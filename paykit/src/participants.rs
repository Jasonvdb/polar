//! Resume persisted participant registration intent with the original identity.
use crate::{model::OwnerRecord, repository::Repository};
use std::future::Future;
use uuid::Uuid;

pub(crate) async fn register(repository: &Repository, id: Uuid) -> anyhow::Result<()> {
    let owner = repository
        .snapshot()?
        .participants
        .into_iter()
        .find(|p| p.public.id == id)
        .ok_or_else(|| anyhow::anyhow!("participant missing"))?;
    complete_registration(repository, owner, register_pubky_owner).await
}

pub(crate) async fn reconcile(repository: &Repository) -> anyhow::Result<()> {
    reconcile_with(repository, register_pubky_owner).await
}

async fn reconcile_with<F, Fut>(repository: &Repository, register: F) -> anyhow::Result<()>
where
    F: Fn([u8; 32]) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let owners = repository
        .snapshot()?
        .participants
        .into_iter()
        .filter(|p| !p.registered)
        .collect::<Vec<_>>();
    for owner in owners {
        complete_registration(repository, owner, &register).await?;
    }
    Ok(())
}

async fn complete_registration<F, Fut>(
    repository: &Repository,
    owner: OwnerRecord,
    register: F,
) -> anyhow::Result<()>
where
    F: FnOnce([u8; 32]) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    if owner.registered {
        return Ok(());
    }
    register(owner.secret).await?;
    repository.update(|state| {
        let saved = state
            .participants
            .iter_mut()
            .find(|p| p.public.id == owner.public.id)
            .ok_or_else(|| anyhow::anyhow!("participant missing"))?;
        anyhow::ensure!(
            saved.secret == owner.secret,
            "participant changed during registration"
        );
        saved.registered = true;
        state.event(
            "participant.created",
            serde_json::json!({"participantId":owner.public.id}),
        );
        Ok(())
    })
}

async fn register_pubky_owner(secret: [u8; 32]) -> anyhow::Result<()> {
    let signer = pubky::Pubky::testnet()?.signer(pubky::Keypair::from_secret(&secret));
    let homeserver = pubky::Keypair::from_secret(&[0; 32]).public_key();
    signer
        .pkdns()
        .publish_homeserver_force(Some(&homeserver))
        .await?;
    if signer.signup(&homeserver, None).await.is_err() {
        signer.signin_cookie().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, model::*};
    use serde_json::json;
    #[tokio::test]
    async fn failed_signup_reopens_with_original_identity_and_retains_failed_operation() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            environment_id: Uuid::new_v4(),
            data_dir: dir.path().into(),
            key: zeroize::Zeroizing::new([4; 32]),
            token: zeroize::Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        };
        let repo = Repository::open(&config).unwrap();
        let id = Uuid::new_v4();
        let key = pubky::Keypair::random();
        let secret = key.secret();
        let public = key.public_key().z32();
        repo.update(|state| {
            state.participants.push(OwnerRecord {
                public: Participant {
                    id,
                    name: "Alice".into(),
                    public_key: public.clone(),
                },
                secret,
                registered: false,
            });
            state.operations.push(OperationRecord {
                public: Operation {
                    id,
                    command: "participant.create".into(),
                    status: OperationStatus::Failed,
                    result: None,
                    error: Some(PublicError::new("operation_failed", "Signup unavailable")),
                },
                request: Command {
                    command_id: id,
                    command: "participant.create".into(),
                    input: json!({"name":"Alice"}),
                },
            });
            Ok(())
        })
        .unwrap();
        assert!(reconcile_with(&repo, |saved| {
            assert_eq!(saved, secret);
            async { anyhow::bail!("injected service outage") }
        })
        .await
        .is_err());
        assert!(!repo.snapshot().unwrap().participants[0].registered);
        drop(repo);
        let reopened = Repository::open(&config).unwrap();
        reconcile_with(&reopened, |saved| {
            assert_eq!(saved, secret);
            async { Ok(()) }
        })
        .await
        .unwrap();
        let state = reopened.snapshot().unwrap();
        assert_eq!(state.participants.len(), 1);
        assert_eq!(state.participants[0].public.id, id);
        assert_eq!(state.participants[0].public.public_key, public);
        assert!(state.participants[0].registered);
        assert!(state.operations[0].public.status == OperationStatus::Failed);
        assert_eq!(
            state.events.last().unwrap().event_type,
            "participant.created"
        );
        reconcile_with(&reopened, |_| async {
            anyhow::bail!("completed participant must not register twice")
        })
        .await
        .unwrap();
    }
}

//! Durable command execution and receiver child ownership.
use crate::{
    commands,
    config::Config,
    model::*,
    receiver::{self, ReceiverSecrets},
    repository::Repository,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::{
    io::BufReader,
    process::{Child, Command as ProcessCommand},
};
use uuid::Uuid;

struct ReceiverChild {
    child: Child,
    input: tokio::process::ChildStdin,
    reader: tokio::task::JoinHandle<()>,
    responses: tokio::sync::mpsc::Receiver<crate::receiver_ipc::Frame>,
}

pub struct Supervisor {
    config: Config,
    pub repository: Arc<Repository>,
    children: HashMap<Uuid, ReceiverChild>,
}
impl Supervisor {
    pub fn new(config: Config, repository: Arc<Repository>) -> Self {
        Self {
            config,
            repository,
            children: HashMap::new(),
        }
    }
    pub async fn run(mut self, stop: tokio::sync::watch::Receiver<bool>) -> anyhow::Result<()> {
        let outcome = self.run_commands(stop).await;
        self.repository.ready.store(false, Ordering::SeqCst);
        let mut cleanup = Ok(());
        let ids = self.children.keys().copied().collect::<Vec<_>>();
        for id in ids {
            if let Err(error) = self.stop_child(id).await {
                cleanup = Err(error);
            }
        }
        outcome.and(cleanup)
    }
    async fn run_commands(
        &mut self,
        mut stop: tokio::sync::watch::Receiver<bool>,
    ) -> anyhow::Result<()> {
        tokio::select! {result=self.reconcile()=>result?, _=stop.wait_for(|value|*value)=>return Ok(())}
        self.repository.ready.store(true, Ordering::SeqCst);
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            let queued = self
                .repository
                .snapshot()?
                .operations
                .into_iter()
                .find(|v| v.public.status == OperationStatus::Queued);
            if let Some(operation) = queued {
                tokio::select! {result=self.execute(operation)=>result?,_=stop.wait_for(|value|*value)=>break}
                continue;
            }
            tokio::select! {_=self.repository.notify.notified()=>{},_=interval.tick()=>self.check_children()?,_=stop.wait_for(|value|*value)=>break}
        }
        Ok(())
    }
    async fn reconcile(&mut self) -> anyhow::Result<()> {
        self.repository.update(|state| {
            commands::reconcile_interrupted(state)?;
            for receiver in &mut state.receivers {
                receiver.public.status = ReceiverStatus::Stopped;
            }
            state.event("environment.reconciling", json!({}));
            Ok(())
        })?;
        crate::participants::reconcile(&self.repository).await?;
        for owner in self
            .repository
            .snapshot()?
            .participants
            .into_iter()
            .filter(|p| p.registered)
        {
            pubky::Pubky::testnet()?
                .signer(pubky::Keypair::from_secret(&owner.secret))
                .pkdns()
                .publish_homeserver_force(Some(&pubky::Keypair::from_secret(&[0; 32]).public_key()))
                .await?;
        }
        let desired = self
            .repository
            .snapshot()?
            .receivers
            .into_iter()
            .filter(|r| r.desired_running)
            .map(|r| r.public.id)
            .collect::<Vec<_>>();
        for id in desired {
            if self.start_child(id).await.is_err() {
                self.set_receiver_error(id)?;
            }
        }
        self.repository.update(|s| {
            s.event("environment.ready", json!({}));
            Ok(())
        })
    }
    async fn execute(&mut self, operation: OperationRecord) -> anyhow::Result<()> {
        self.operation_status(operation.public.id, OperationStatus::Running, None, None)?;
        let result = self.dispatch(&operation.request).await;
        match result {
            Ok(value) => self.operation_status(
                operation.public.id,
                OperationStatus::Succeeded,
                Some(value),
                None,
            ),
            Err(error) => {
                let public=error.downcast_ref::<PublicError>().cloned().unwrap_or_else(||PublicError::new(
                    "operation_failed",
                    "The operation could not complete. Check services and receiver state. Reuse the existing command ID to inspect an uncertain outcome.",
                ));
                self.operation_status(
                    operation.public.id,
                    OperationStatus::Failed,
                    None,
                    Some(public),
                )
            }
        }
    }
    fn operation_status(
        &self,
        id: Uuid,
        status: OperationStatus,
        result: Option<Value>,
        error: Option<PublicError>,
    ) -> anyhow::Result<()> {
        self.repository.update(|state| {
            let record = state
                .operations
                .iter_mut()
                .find(|v| v.public.id == id)
                .ok_or_else(|| anyhow::anyhow!("operation missing"))?;
            record.public.status = status;
            record.public.result = result;
            record.public.error = error;
            let public = record.public.clone();
            state.event("operation.updated", json!(public));
            Ok(())
        })
    }
    async fn dispatch(&mut self, command: &Command) -> anyhow::Result<Value> {
        match command.command.as_str() {
            "participant.create" => {
                let input: commands::NameInput = decode(command)?;
                self.create_participant(command.command_id, &input.name)
                    .await?;
                Ok(json!({"participantId":command.command_id}))
            }
            "participant.rename" => {
                let input: commands::ParticipantName = decode(command)?;
                self.repository.update(|s| {
                    let p = s
                        .participants
                        .iter_mut()
                        .find(|p| p.public.id == input.participant_id)
                        .ok_or_else(|| anyhow::anyhow!("participant missing"))?;
                    p.public.name = input.name;
                    Ok(())
                })?;
                Ok(json!({"participantId":input.participant_id}))
            }
            "receiver.create" => {
                let input: commands::CreateReceiver = decode(command)?;
                self.create_receiver(command.command_id, input).await?;
                Ok(json!({"receiverId":command.command_id}))
            }
            "receiver.rename" => {
                let input: commands::ReceiverName = decode(command)?;
                self.repository.update(|s| {
                    find_receiver(s, input.receiver_id)?.public.name = input.name;
                    Ok(())
                })?;
                Ok(json!({"receiverId":input.receiver_id}))
            }
            "receiver.start" | "receiver.restart" | "receiver.stop" => {
                let input: commands::ReceiverId = decode(command)?;
                self.lifecycle(input.receiver_id, &command.command).await?;
                Ok(json!({"receiverId":input.receiver_id}))
            }
            "preset.create" => self.preset().await,
            value if commands::workspace_command(value) => self.receiver_command(command).await,
            _ => anyhow::bail!("unsupported command"),
        }
    }
    async fn receiver_command(&mut self, command: &Command) -> anyhow::Result<Value> {
        let id: Uuid = serde_json::from_value(command.input["receiverId"].clone())?;
        let child = self
            .children
            .get_mut(&id)
            .ok_or_else(|| anyhow::anyhow!("receiver is stopped"))?;
        anyhow::ensure!(child.child.try_wait()?.is_none(), "receiver exited");
        crate::receiver_ipc::write_frame(&mut child.input, command).await?;
        let frame = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let response = child
                    .responses
                    .recv()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("receiver IPC closed"))?;
                if response.command_id == Some(command.command_id) {
                    return Ok::<_, anyhow::Error>(response);
                }
            }
        })
        .await??;
        if let Some(error) = frame.error {
            return Err(PublicError::new("receiver_operation_failed", &error).into());
        }
        frame
            .result
            .ok_or_else(|| anyhow::anyhow!("receiver result missing"))
    }
    async fn create_participant(&mut self, id: Uuid, name: &str) -> anyhow::Result<()> {
        self.repository.update(|state| {
            if !state.participants.iter().any(|p| p.public.id == id) {
                let key = pubky::Keypair::random();
                state.participants.push(OwnerRecord {
                    public: Participant {
                        id,
                        name: name.into(),
                        public_key: key.public_key().z32(),
                    },
                    secret: key.secret(),
                    registered: false,
                });
            }
            Ok(())
        })?;
        crate::participants::register(&self.repository, id).await
    }
    async fn create_receiver(
        &mut self,
        id: Uuid,
        input: commands::CreateReceiver,
    ) -> anyhow::Result<()> {
        let snapshot = self.repository.snapshot()?;
        let owner = snapshot
            .participants
            .iter()
            .find(|p| p.public.id == input.participant_id && p.registered)
            .ok_or_else(|| anyhow::anyhow!("participant unavailable"))?;
        let path = format!("polar-{}/{kind}", id.simple(), kind = input.kind.as_str());
        let vault = receiver::vault(&self.config, id)?;
        let secrets = match vault.load::<ReceiverSecrets>("session.cbor")? {
            Some(s) => s,
            None => {
                let s = ReceiverSecrets {
                    owner: owner.secret,
                    noise: pubky::Keypair::random().secret(),
                    path: path.clone(),
                    session: None,
                };
                vault.save("session.cbor", &s)?;
                s
            }
        };
        anyhow::ensure!(
            secrets.owner == owner.secret && secrets.path == path,
            "receiver binding mismatch"
        );
        self.repository.update(|s| {
            if !s.receivers.iter().any(|r| r.public.id == id) {
                s.receivers.push(ReceiverRecord {
                    public: Receiver {
                        id,
                        participant_id: input.participant_id,
                        name: input.name,
                        path,
                        status: ReceiverStatus::Stopped,
                        generation: 0,
                        noise_public_key: pubky::Keypair::from_secret(&secrets.noise)
                            .public_key()
                            .z32(),
                        last_error: None,
                    },
                    desired_running: true,
                });
            }
            Ok(())
        })?;
        self.lifecycle(id, "receiver.start").await
    }
    async fn preset(&mut self) -> anyhow::Result<Value> {
        let namespace = self.config.environment_id;
        for name in ["Alice", "Bob", "Carol"] {
            let id = Uuid::new_v5(&namespace, format!("preset:{name}").as_bytes());
            self.create_participant(id, name).await?;
            let kinds = if name == "Bob" {
                vec![
                    commands::ReceiverKind::Wallet,
                    commands::ReceiverKind::Server,
                ]
            } else {
                vec![commands::ReceiverKind::Wallet]
            };
            for kind in kinds {
                let receiver_id = Uuid::new_v5(
                    &namespace,
                    format!("preset:{name}:{}", kind.as_str()).as_bytes(),
                );
                if !self
                    .repository
                    .snapshot()?
                    .receivers
                    .iter()
                    .any(|r| r.public.id == receiver_id)
                {
                    self.create_receiver(
                        receiver_id,
                        commands::CreateReceiver {
                            participant_id: id,
                            name: format!("{name} {}", kind.as_str()),
                            kind,
                        },
                    )
                    .await?;
                } else {
                    self.lifecycle(receiver_id, "receiver.start").await?;
                }
            }
        }
        Ok(json!({"preset":"Alice/Bob/Carol","funded":false}))
    }
    async fn lifecycle(&mut self, id: Uuid, command: &str) -> anyhow::Result<()> {
        self.repository.update(|s| {
            find_receiver(s, id)?.desired_running = command != "receiver.stop";
            Ok(())
        })?;
        if command != "receiver.start" {
            self.stop_child(id).await?;
        }
        if command != "receiver.stop" && self.start_child(id).await.is_err() {
            self.set_receiver_error(id)?;
            anyhow::bail!("receiver start failed");
        }
        Ok(())
    }
    async fn start_child(&mut self, id: Uuid) -> anyhow::Result<()> {
        if self.children.contains_key(&id) {
            let state = self.repository.snapshot()?;
            if state
                .receivers
                .iter()
                .any(|r| r.public.id == id && r.public.status == ReceiverStatus::Running)
                && self
                    .children
                    .get_mut(&id)
                    .is_some_and(|child| matches!(child.child.try_wait(), Ok(None)))
            {
                return Ok(());
            }
            self.stop_child(id).await?;
        }
        self.repository.update(|s| {
            let r = find_receiver(s, id)?;
            r.public.status = ReceiverStatus::Starting;
            r.public.generation += 1;
            r.public.last_error = None;
            s.event("receiver.starting", json!({"receiverId":id}));
            Ok(())
        })?;
        let mut child = ProcessCommand::new(std::env::current_exe()?)
            .arg("receiver")
            .arg(id.to_string())
            .env_remove("TEST_PUBKY_CONNECTION_STRING")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("receiver output missing"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("receiver input missing"))?;
        let (tx, responses) = tokio::sync::mpsc::channel(8);
        let repository = self.repository.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            let ready = async {
                let line = crate::receiver_ipc::read_frame(&mut stdout, 4096)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("receiver exited"))?;
                let result: Value = serde_json::from_slice(&line)?;
                anyhow::ensure!(
                    result["ready"] == true && result["receiverId"] == id.to_string(),
                    "receiver readiness rejected"
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            let valid = ready.is_ok();
            let _ = ready_tx.send(ready);
            if !valid {
                return;
            }
            while let Ok(Some(bytes)) =
                crate::receiver_ipc::read_frame(&mut stdout, crate::receiver_ipc::MAX_FRAME).await
            {
                let Ok(frame) = serde_json::from_slice::<crate::receiver_ipc::Frame>(&bytes) else {
                    break;
                };
                if frame.receiver_id != id || frame.workspace.receiver_id != id {
                    break;
                }
                let changed = repository.snapshot().is_ok_and(|state| {
                    state
                        .receiver_workspaces
                        .iter()
                        .find(|w| w.receiver_id == id)
                        != Some(&frame.workspace)
                });
                if changed
                    && repository
                        .update(|state| {
                            state.receiver_workspaces.retain(|w| w.receiver_id != id);
                            state.receiver_workspaces.push(frame.workspace.clone());
                            state.event("receiver.workspace", json!(frame.workspace));
                            Ok(())
                        })
                        .is_err()
                {
                    break;
                }
                if frame.command_id.is_some() && tx.send(frame).await.is_err() {
                    break;
                }
            }
        });
        self.children.insert(
            id,
            ReceiverChild {
                child,
                input,
                reader,
                responses,
            },
        );
        tokio::time::timeout(Duration::from_secs(60), ready_rx).await???;
        self.repository.update(|s| {
            find_receiver(s, id)?.public.status = ReceiverStatus::Running;
            s.event("receiver.running", json!({"receiverId":id}));
            Ok(())
        })
    }
    async fn stop_child(&mut self, id: Uuid) -> anyhow::Result<()> {
        if let Some(child) = self.children.get_mut(&id) {
            if let Some(pid) = child.child.id() {
                // SAFETY: this PID is held by our unreaped Child handle; no arbitrary process is targeted.
                let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
                if result != 0 && child.child.try_wait()?.is_none() {
                    anyhow::bail!("receiver termination failed");
                }
            }
            tokio::time::timeout(Duration::from_secs(10), child.child.wait()).await??;
            if let Some(child) = self.children.remove(&id) {
                child.reader.abort();
            }
        }
        self.repository.update(|s| {
            find_receiver(s, id)?.public.status = ReceiverStatus::Stopped;
            s.event("receiver.stopped", json!({"receiverId":id}));
            Ok(())
        })
    }
    fn check_children(&mut self) -> anyhow::Result<()> {
        let mut exited = vec![];
        for (id, child) in &mut self.children {
            if child.child.try_wait()?.is_some() {
                exited.push(*id);
            }
        }
        for id in exited {
            if let Some(child) = self.children.remove(&id) {
                child.reader.abort();
            }
            self.set_receiver_error(id)?;
        }
        Ok(())
    }
    fn set_receiver_error(&self, id: Uuid) -> anyhow::Result<()> {
        self.repository.update(|s| {
            let r = find_receiver(s, id)?;
            r.public.status = ReceiverStatus::Error;
            r.public.last_error =
                Some("Receiver unavailable. Check local services and restart the receiver.".into());
            s.event("receiver.error", json!({"receiverId":id}));
            Ok(())
        })
    }
}
fn find_receiver(state: &mut AppState, id: Uuid) -> anyhow::Result<&mut ReceiverRecord> {
    state
        .receivers
        .iter_mut()
        .find(|r| r.public.id == id)
        .ok_or_else(|| anyhow::anyhow!("receiver missing"))
}
fn decode<T: serde::de::DeserializeOwned>(command: &Command) -> anyhow::Result<T> {
    serde_json::from_value(command.input.clone()).map_err(Into::into)
}

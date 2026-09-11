//! Validated command inputs; rejected requests never enter the durable queue.
use crate::model::{Command, PublicError};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NameInput {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParticipantName {
    pub participant_id: Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverName {
    pub receiver_id: Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverId {
    pub receiver_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupTransfer {
    pub receiver_id: Uuid,
    pub transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateReceiver {
    pub participant_id: Uuid,
    pub name: String,
    pub kind: ReceiverKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiverKind {
    Wallet,
    Server,
}
impl ReceiverKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Wallet => "wallet",
            Self::Server => "server",
        }
    }
}

pub fn validate(command: &Command) -> Result<(), PublicError> {
    if command.command_id.is_nil() {
        return Err(invalid());
    }
    match command.command.as_str() {
        "participant.create" => name(&parse::<NameInput>(command)?.name),
        "participant.rename" => name(&parse::<ParticipantName>(command)?.name),
        "receiver.create" => name(&parse::<CreateReceiver>(command)?.name),
        "receiver.rename" => name(&parse::<ReceiverName>(command)?.name),
        "receiver.start" | "receiver.stop" | "receiver.restart" => {
            parse::<ReceiverId>(command)?;
            Ok(())
        }
        "backup.export" | "backup.inspect" | "backup.restore" => {
            let input: BackupTransfer = parse(command)?;
            valid_id(input.receiver_id)?;
            valid_v4(&input.transfer_id)
        }
        "recovery.reconcile" => valid_id(parse::<ReceiverId>(command)?.receiver_id),
        "preset.create" | "preset.fund" if command.input == serde_json::json!({}) => Ok(()),
        value if crate::subscription_input::is_command(value) => {
            crate::subscription_input::validate(command)
        }
        value if crate::receipt_input::is_command(value) => crate::receipt_input::validate(command),
        value if crate::request_input::is_command(value) => crate::request_input::validate(command),
        value if crate::payment_input::is_command(value) => crate::payment_input::validate(command),
        value if workspace_command(value) => validate_workspace(command),
        _ => Err(PublicError::new(
            "unsupported_command",
            "This command is not supported by API v1.",
        )),
    }
}
pub fn parse<T: serde::de::DeserializeOwned>(command: &Command) -> Result<T, PublicError> {
    serde_json::from_value(command.input.clone()).map_err(|_| invalid())
}
fn name(value: &str) -> Result<(), PublicError> {
    if value.trim().is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn invalid() -> PublicError {
    PublicError::new(
        "invalid_input",
        "Check the command identifier and input fields.",
    )
}

/// Replay is deliberately limited to these idempotent environment commands.
/// Payment execution commands must provide independent settlement reconciliation.
pub fn reconcile_interrupted(state: &mut crate::model::AppState) -> anyhow::Result<()> {
    use crate::model::{OperationStatus, PublicError};
    let mut requeued = vec![];
    for operation in &mut state.operations {
        if operation.public.status != OperationStatus::Running {
            continue;
        }
        let replay_safe = matches!(
            operation.request.command.as_str(),
            "participant.create"
                | "participant.rename"
                | "receiver.create"
                | "receiver.rename"
                | "receiver.start"
                | "receiver.stop"
                | "receiver.restart"
                | "preset.create"
        );
        if replay_safe && validate(&operation.request).is_ok() {
            operation.public.status = OperationStatus::Queued;
            operation.public.error = None;
            requeued.push(operation.public.clone());
        } else {
            operation.public.status = OperationStatus::Failed;
            operation.public.error = Some(PublicError::new(
                "reconciliation_required",
                "This operation requires manual recovery.",
            ));
        }
    }
    if state.funding.status == "running" {
        state.funding.status = "uncertain".into();
        state.funding.last_error = Some("Preset setup was interrupted. Retry funding to reconcile its original transfers and channels.".into());
        state.event(
            "funding.updated",
            serde_json::json!({"status":state.funding.status,"step":state.funding.step}),
        );
    }
    for operation in requeued {
        state.event("operation.requeued", serde_json::json!(operation));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_names_and_unknown_secret_fields_rejected() {
        for input in [
            serde_json::json!({"name":" "}),
            serde_json::json!({"name":"Alice","secret":"forbidden"}),
        ] {
            assert!(validate(&Command {
                command_id: Uuid::new_v4(),
                command: "participant.create".into(),
                input
            })
            .is_err());
        }
    }
    #[test]
    fn backup_commands_accept_only_secret_free_lowercase_v4_handles() {
        let receiver = Uuid::new_v4();
        let transfer = Uuid::new_v4().to_string();
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "backup.restore".into(),
            input: serde_json::json!({"receiverId":receiver,"transferId":transfer}),
        };
        assert!(validate(&command).is_ok());
        let mut secret = command.clone();
        secret.input["passphrase"] = serde_json::json!("forbidden secret");
        assert!(validate(&secret).is_err());
        let mut uppercase = command;
        uppercase.input["transferId"] = serde_json::json!(transfer.to_uppercase());
        assert!(validate(&uppercase).is_err());
    }
    #[test]
    fn interrupted_funding_remains_explicitly_recoverable_with_original_progress() {
        use crate::model::*;
        let mut state = AppState::new(Uuid::new_v4());
        let id = Uuid::new_v4();
        state.funding.status = "running".into();
        state.funding.step = "channel2".into();
        state.funding.channel_points = vec![format!("{}:0", "ab".repeat(32))];
        state
            .funding
            .wallets
            .push(crate::request_model::FundedWallet {
                participant: "Alice".into(),
                wallet_id: "lnd-1-core-1".into(),
                onchain_balance_sats: "1000000".into(),
                lightning_balance_sats: "500000".into(),
            });
        let original = state.funding.clone();
        state.operations.push(OperationRecord {
            public: Operation {
                id,
                command: "preset.fund".into(),
                status: OperationStatus::Running,
                result: None,
                error: None,
            },
            request: Command {
                command_id: id,
                command: "preset.fund".into(),
                input: serde_json::json!({}),
            },
        });
        reconcile_interrupted(&mut state).unwrap();
        assert_eq!(state.funding.status, "uncertain");
        assert!(state
            .funding
            .last_error
            .as_ref()
            .unwrap()
            .contains("original transfers and channels"));
        assert_eq!(state.funding.step, original.step);
        assert_eq!(state.funding.channel_points, original.channel_points);
        assert!(state.funding.wallets == original.wallets);
        assert_eq!(state.funding.funded, original.funded);
        assert_eq!(state.operations[0].public.id, id);
        assert!(state.operations[0].public.status == OperationStatus::Failed);
        assert_eq!(
            state.operations[0].public.error.as_ref().unwrap().code,
            "reconciliation_required"
        );
        assert!(!state
            .operations
            .iter()
            .any(|o| o.public.status == OperationStatus::Queued));
        let before = serde_json::to_value(&state).unwrap();
        reconcile_interrupted(&mut state).unwrap();
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
    }
    #[test]
    fn interrupted_environment_commands_requeue_but_future_payments_do_not() {
        use crate::model::*;
        let mut state = AppState::new(Uuid::new_v4());
        for (command, status) in [
            ("preset.create", OperationStatus::Running),
            ("payment.execute", OperationStatus::Running),
            ("preset.create", OperationStatus::Succeeded),
        ] {
            let id = Uuid::new_v4();
            state.operations.push(OperationRecord {
                public: Operation {
                    id,
                    command: command.into(),
                    status,
                    result: None,
                    error: None,
                },
                request: Command {
                    command_id: id,
                    command: command.into(),
                    input: serde_json::json!({}),
                },
            });
        }
        reconcile_interrupted(&mut state).unwrap();
        assert!(state.operations[0].public.status == OperationStatus::Queued);
        assert!(state.operations[1].public.status == OperationStatus::Failed);
        assert!(state.operations[2].public.status == OperationStatus::Succeeded);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.events[0].event_type, "operation.requeued");
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerInput {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContactKey {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContactInput {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub label: String,
    pub receiver_paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    pub receiver_id: Uuid,
    pub display_name: String,
    pub about: String,
    pub avatar_base64: Option<String>,
    pub avatar_mime: Option<String>,
}
pub fn workspace_command(command: &str) -> bool {
    if crate::subscription_input::is_command(command)
        || crate::receipt_input::is_command(command)
        || crate::request_input::is_command(command)
    {
        return true;
    }
    crate::payment_input::is_command(command)
        || matches!(
            command,
            "link.initiate"
                | "link.accept"
                | "link.advance"
                | "link.block"
                | "link.unblock"
                | "link.sendEmptyList"
                | "delivery.pause"
                | "delivery.resume"
                | "delivery.sync"
                | "profile.publish"
                | "profile.delete"
                | "profile.fetch"
                | "contact.save"
                | "contact.remove"
                | "contact.discover"
                | "contact.publish"
                | "contact.unpublish"
        )
}
fn valid_id(id: Uuid) -> Result<(), PublicError> {
    if id.is_nil() {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn valid_v4(value: &str) -> Result<(), PublicError> {
    let id = value.parse::<Uuid>().map_err(|_| invalid())?;
    if id.get_version_num() == 4 && id.to_string() == value {
        Ok(())
    } else {
        Err(invalid())
    }
}
pub fn public_key(value: &str) -> Result<paykit_sdk::PubkyPublicKey, PublicError> {
    let parsed = paykit_sdk::PubkyPublicKey::new(value).map_err(|_| invalid())?;
    if parsed.as_str() != value {
        return Err(invalid());
    }
    Ok(parsed)
}
fn validate_workspace(command: &Command) -> Result<(), PublicError> {
    match command.command.as_str() {
        "delivery.pause" | "delivery.resume" | "delivery.sync" | "profile.delete" => {
            valid_id(parse::<ReceiverId>(command)?.receiver_id)
        }
        "profile.publish" => {
            let i: ProfileInput = parse(command)?;
            valid_id(i.receiver_id)?;
            name(&i.display_name)?;
            if i.about.len() > 2000
                || i.about
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err(invalid());
            }
            match (i.avatar_base64, i.avatar_mime) {
                (None, None) => Ok(()),
                (Some(a), Some(m)) if a.is_empty() && m.is_empty() => Ok(()),
                (Some(a), Some(m)) => {
                    decode_avatar(&a, &m)?;
                    Ok(())
                }
                _ => Err(invalid()),
            }
        }
        "contact.save" => {
            let i: ContactInput = parse(command)?;
            valid_id(i.receiver_id)?;
            public_key(&i.peer_public_key)?;
            if i.label.len() > 80
                || i.label.chars().any(char::is_control)
                || i.receiver_paths.is_empty()
                || i.receiver_paths.len() > 16
            {
                return Err(invalid());
            }
            let mut paths = std::collections::HashSet::new();
            for p in i.receiver_paths {
                paykit_sdk::PaykitReceiverPath::new(&p).map_err(|_| invalid())?;
                if !paths.insert(p) {
                    return Err(invalid());
                }
            }
            Ok(())
        }
        "contact.remove" | "contact.discover" => {
            let i: ContactKey = parse(command)?;
            valid_id(i.receiver_id)?;
            public_key(&i.peer_public_key)?;
            Ok(())
        }
        _ => {
            let i: PeerInput = parse(command)?;
            valid_id(i.receiver_id)?;
            public_key(&i.peer_public_key)?;
            paykit_sdk::PaykitReceiverPath::new(i.peer_receiver_path).map_err(|_| invalid())?;
            Ok(())
        }
    }
}
pub const MAX_AVATAR: usize = 256 * 1024;
pub fn decode_avatar(encoded: &str, mime: &str) -> Result<Vec<u8>, PublicError> {
    use base64::Engine;
    if encoded.len() > MAX_AVATAR.div_ceil(3) * 4 {
        return Err(invalid());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid())?;
    if avatar_mime(&bytes) != Some(mime) {
        return Err(invalid());
    }
    Ok(bytes)
}
pub fn avatar_mime(bytes: &[u8]) -> Option<&'static str> {
    decode_image(bytes).map(|(mime, _)| mime)
}
fn decode_image(bytes: &[u8]) -> Option<(&'static str, image::DynamicImage)> {
    if bytes.len() > MAX_AVATAR {
        return None;
    }
    let (format, mime) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.ends_with(b"\x00\x00\x00\x00IEND\xaeB`\x82")
    {
        (image::ImageFormat::Png, "image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]) {
        (image::ImageFormat::Jpeg, "image/jpeg")
    } else {
        return None;
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1024);
    limits.max_image_height = Some(1024);
    limits.max_alloc = Some(16 * 1024 * 1024);
    reader.limits(limits);
    Some((mime, reader.decode().ok()?))
}

/// A small PNG preview of a fully validated original; never a renderer remote URL.
pub fn avatar_preview(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let (_, decoded) = decode_image(bytes)?;
    let thumbnail = image::DynamicImage::ImageRgba8(decoded.thumbnail(48, 48).to_rgba8());
    let mut output = std::io::Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, image::ImageFormat::Png)
        .ok()?;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    );
    (data_url.len() <= 16 * 1024).then_some(data_url)
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use base64::Engine;
    fn validate_input(command: &str, input: serde_json::Value) -> bool {
        validate(&Command {
            command_id: Uuid::new_v4(),
            command: command.into(),
            input,
        })
        .is_ok()
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }
    #[test]
    fn avatars_require_full_decoding_mime_and_bounded_dimensions() {
        let valid = png(2, 2);
        assert_eq!(avatar_mime(&valid), Some("image/png"));
        for len in [8, 24, valid.len() / 2, valid.len() - 1] {
            assert_eq!(avatar_mime(&valid[..len]), None);
        }
        assert_eq!(avatar_mime(&png(1025, 1)), None);
        assert_eq!(avatar_mime(&vec![0; MAX_AVATAR + 1]), None);
        assert!(decode_avatar(
            &base64::engine::general_purpose::STANDARD.encode(valid),
            "image/jpeg"
        )
        .is_err());
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        assert_eq!(avatar_mime(jpeg.get_ref()), Some("image/jpeg"));
    }
    #[test]
    fn actual_large_avatar_has_a_small_aspect_preserving_preview() {
        let bytes = png(1024, 512);
        let preview = avatar_preview(&bytes).unwrap();
        assert!(preview.len() <= 16 * 1024);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(preview.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let image = image::load_from_memory(&decoded).unwrap();
        assert_eq!((image.width(), image.height()), (48, 24));
    }
    #[test]
    fn validates_exact_peer_paths_keys_and_contact_sets() {
        let id = Uuid::new_v4();
        let peer = pubky::Keypair::random().public_key().z32();
        let good = serde_json::json!({"receiverId":id,"peerPublicKey":peer,"peerReceiverPath":"other/server"});
        assert!(validate_input("link.initiate", good.clone()));
        for path in [
            "private/wallet",
            "Other/server",
            "other/ios",
            "../server",
            "other_wallet/wallet",
            "other/wallet/extra",
        ] {
            let mut v = good.clone();
            v["peerReceiverPath"] = path.into();
            assert!(!validate_input("link.accept", v));
        }
        let mut bad = good.clone();
        bad["peerPublicKey"] = "not-a-key".into();
        assert!(!validate_input("link.accept", bad));
        let mut bad = good.clone();
        bad["secret"] = "injected".into();
        assert!(!validate_input("link.accept", bad));
        assert!(!validate_input(
            "contact.save",
            serde_json::json!({"receiverId":id,"peerPublicKey":peer,"label":"local","receiverPaths":["a/wallet","a/wallet"]})
        ));
        assert!(!validate_input(
            "contact.save",
            serde_json::json!({"receiverId":id,"peerPublicKey":peer,"label":"local","receiverPaths":[]})
        ));
    }
    #[test]
    fn validates_profile_byte_limits_and_paired_avatar_fields() {
        let good = serde_json::json!({"receiverId":Uuid::new_v4(),"displayName":"Bob","about":"line one\nline two"});
        assert!(validate_input("profile.publish", good.clone()));
        let mut bad = good.clone();
        bad["displayName"] = "é".repeat(41).into();
        assert!(!validate_input("profile.publish", bad));
        let mut bad = good.clone();
        bad["avatarBase64"] = "".into();
        assert!(!validate_input("profile.publish", bad));
        let mut good = good;
        good["avatarBase64"] = "".into();
        good["avatarMime"] = "".into();
        assert!(validate_input("profile.publish", good));
    }
}

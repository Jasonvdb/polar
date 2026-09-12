//! Versioned command discovery and guided plans for public Paykit workflows.

use crate::model::{Command, PublicError};
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: &'static str,
    pub title: &'static str,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub id: &'static str,
    pub panel_id: &'static str,
    pub required_parameters: &'static [&'static str],
    pub optional_parameters: &'static [&'static str],
    pub generic_command_allowed: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioStep {
    pub id: &'static str,
    pub panel_id: &'static str,
    pub command: &'static str,
    pub required_parameters: &'static [&'static str],
    pub checkpoint: &'static str,
    pub recovery_hint: &'static str,
    pub transport: StepTransport,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub id: &'static str,
    pub title: &'static str,
    pub prerequisites: &'static [&'static str],
    pub steps: &'static [ScenarioStep],
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepTransport {
    Command,
    FileDescriptorBackup,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub api_version: u8,
    pub catalog_version: u8,
    pub panels: &'static [Panel],
    pub commands: &'static [CommandSpec],
    pub scenarios: &'static [Scenario],
}

pub const PANELS: &[Panel] = &[
    Panel {
        id: "workspace",
        title: "Workspace",
    },
    Panel {
        id: "links",
        title: "Links",
    },
    Panel {
        id: "profiles",
        title: "Profiles and contacts",
    },
    Panel {
        id: "methods",
        title: "Payment methods",
    },
    Panel {
        id: "requests",
        title: "Requests and payments",
    },
    Panel {
        id: "proofs",
        title: "Proofs",
    },
    Panel {
        id: "receipts",
        title: "Receipts",
    },
    Panel {
        id: "subscriptions",
        title: "Subscriptions",
    },
    Panel {
        id: "backup",
        title: "Backup and recovery",
    },
];

macro_rules! spec {
    ($id:literal, $panel:literal, [$($required:literal),*], [$($optional:literal),*]) => {
        CommandSpec { id: $id, panel_id: $panel, required_parameters: &[$($required),*], optional_parameters: &[$($optional),*], generic_command_allowed: true }
    };
    (fd $id:literal, [$($required:literal),*]) => {
        CommandSpec { id: $id, panel_id: "backup", required_parameters: &[$($required),*], optional_parameters: &[], generic_command_allowed: false }
    };
}

pub const COMMANDS: &[CommandSpec] = &[
    spec!("participant.create", "workspace", ["name"], []),
    spec!(
        "participant.rename",
        "workspace",
        ["participantId", "name"],
        []
    ),
    spec!(
        "receiver.create",
        "workspace",
        ["participantId", "name", "kind"],
        []
    ),
    spec!("receiver.rename", "workspace", ["receiverId", "name"], []),
    spec!("receiver.start", "workspace", ["receiverId"], []),
    spec!("receiver.stop", "workspace", ["receiverId"], []),
    spec!("receiver.restart", "workspace", ["receiverId"], []),
    spec!("preset.create", "workspace", [], []),
    spec!("preset.fund", "workspace", [], []),
    spec!(
        "link.prepareRecovery",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.retryRecoveryMarker",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.initiate",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.accept",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.advance",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.block",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.unblock",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "link.sendEmptyList",
        "links",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!("delivery.pause", "links", ["receiverId"], []),
    spec!("delivery.resume", "links", ["receiverId"], []),
    spec!("delivery.sync", "links", ["receiverId"], []),
    spec!(
        "profile.publish",
        "profiles",
        ["receiverId", "displayName", "about"],
        ["avatarBase64", "avatarMime"]
    ),
    spec!("profile.delete", "profiles", ["receiverId"], []),
    spec!(
        "profile.fetch",
        "profiles",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "contact.save",
        "profiles",
        ["receiverId", "peerPublicKey", "label", "receiverPaths"],
        []
    ),
    spec!(
        "contact.remove",
        "profiles",
        ["receiverId", "peerPublicKey"],
        []
    ),
    spec!(
        "contact.discover",
        "profiles",
        ["receiverId", "peerPublicKey"],
        []
    ),
    spec!(
        "contact.publish",
        "profiles",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "contact.unpublish",
        "profiles",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        []
    ),
    spec!(
        "method.configure",
        "methods",
        ["receiverId", "walletId", "enabledMethods", "preference"],
        []
    ),
    spec!("method.prefer", "methods", ["receiverId", "preference"], []),
    spec!(
        "paymentList.publish",
        "methods",
        ["receiverId", "amountSats", "expirySeconds"],
        []
    ),
    spec!("paymentList.unpublish", "methods", ["receiverId"], []),
    spec!(
        "reservation.create",
        "methods",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "amountSats",
            "expirySeconds"
        ],
        []
    ),
    spec!(
        "reservation.rotate",
        "methods",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "amountSats",
            "expirySeconds"
        ],
        []
    ),
    spec!(
        "reservation.cancel",
        "methods",
        ["receiverId", "reservationId"],
        []
    ),
    spec!(
        "reservation.reconcile",
        "methods",
        ["receiverId", "reservationId"],
        []
    ),
    spec!(
        "paymentList.resolve",
        "methods",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "source",
            "amountSats"
        ],
        ["method"]
    ),
    spec!(
        "paymentList.consume",
        "methods",
        ["receiverId", "resolutionId"],
        []
    ),
    spec!(
        "request.create",
        "requests",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "amountSats",
            "description",
            "expirySeconds",
            "acceptedMethods",
            "recurrence"
        ],
        []
    ),
    spec!(
        "request.accept",
        "requests",
        ["receiverId", "requestId"],
        []
    ),
    spec!(
        "request.reject",
        "requests",
        ["receiverId", "requestId"],
        []
    ),
    spec!(
        "request.cancel",
        "requests",
        ["receiverId", "requestId"],
        []
    ),
    spec!(
        "payment.execute",
        "requests",
        ["receiverId", "requestId", "walletId", "source"],
        ["periodIndex", "method"]
    ),
    spec!(
        "payment.reconcile",
        "requests",
        ["receiverId", "executionId"],
        []
    ),
    spec!(
        "proof.submit",
        "proofs",
        ["receiverId", "requestId"],
        ["periodIndex", "executionId", "proof"]
    ),
    spec!(
        "proof.verify",
        "proofs",
        ["receiverId", "requestId", "proofId"],
        ["requiredConfirmations"]
    ),
    spec!(
        "receipt.prepare",
        "receipts",
        ["receiverId", "requestId", "proofId"],
        ["note"]
    ),
    spec!(
        "receipt.process",
        "receipts",
        ["receiverId", "receiptId"],
        []
    ),
    spec!(
        "receipt.retrieve",
        "receipts",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "receiptId"
        ],
        []
    ),
    spec!(
        "subscription.prepare",
        "subscriptions",
        [
            "receiverId",
            "requestId",
            "periodIndex",
            "source",
            "expirySeconds"
        ],
        []
    ),
    spec!(
        "subscription.authorize",
        "subscriptions",
        ["receiverId", "requestId", "walletId", "source", "method"],
        []
    ),
    spec!(
        "subscription.disable",
        "subscriptions",
        ["receiverId", "requestId"],
        []
    ),
    spec!("clock.set", "subscriptions", ["receiverId", "now"], []),
    spec!("clock.reset", "subscriptions", ["receiverId"], []),
    spec!(fd "backup.export", ["receiverId", "transferId"]),
    spec!(fd "backup.inspect", ["receiverId", "transferId"]),
    spec!(fd "backup.restore", ["receiverId", "transferId"]),
    spec!("recovery.reconcile", "backup", ["receiverId"], []),
];

macro_rules! step {
    ($id:literal, $panel:literal, $command:literal, [$($required:literal),*], $checkpoint:literal, $recovery:literal) => {
        ScenarioStep { id: $id, panel_id: $panel, command: $command, required_parameters: &[$($required),*], checkpoint: $checkpoint, recovery_hint: $recovery, transport: StepTransport::Command }
    };
    (fd $id:literal, $command:literal, $checkpoint:literal) => {
        ScenarioStep { id: $id, panel_id: "backup", command: $command, required_parameters: &["receiverId"], checkpoint: $checkpoint, recovery_hint: "Keep the inherited descriptors open, inspect the existing operation ID, and retry only after a terminal failure.", transport: StepTransport::FileDescriptorBackup }
    };
}

const FUNDED: &[ScenarioStep] = &[
    step!("create-preset", "workspace", "preset.create", [], "State shows Alice, Bob, and Carol with four receivers.", "Keep the operation and command IDs. Inspect the terminal error; reconcile any uncertain wallet outcome before issuing another command."),
    step!("fund-preset", "workspace", "preset.fund", [], "Funding is ready and wallet balances and channels are visible.", "If funding is uncertain, retry preset.fund so its original transfers and channels are reconciled."),
];
const LINKS: &[ScenarioStep] = &[
    step!("initiate", "links", "link.initiate", ["receiverId", "peerPublicKey", "peerReceiverPath"], "The initiator workspace shows the peer link awaiting its next handshake transition.", "Check both receiver generations and retry the failed command without changing peer identity or path."),
    step!("accept", "links", "link.accept", ["receiverId", "peerPublicKey", "peerReceiverPath"], "The accepting receiver records the matching peer link.", "Confirm the invitation exists; acceptance is always an explicit peer action."),
    step!("advance", "links", "link.advance", ["receiverId", "peerPublicKey", "peerReceiverPath"], "Both workspaces show the link established.", "Run delivery.sync on each receiver and inspect the failed operation code before retrying."),
];
const PROFILES: &[ScenarioStep] = &[
    step!("publish-profile", "profiles", "profile.publish", ["receiverId", "displayName", "about"], "The local workspace shows the published profile.", "Remove optional avatar fields and retry if public image validation failed."),
    step!("save-contact", "profiles", "contact.save", ["receiverId", "peerPublicKey", "label", "receiverPaths"], "The contact lists every explicitly supplied receiver path.", "Discover the peer again and correct only the public key or receiver paths reported invalid."),
    step!("publish-contact", "profiles", "contact.publish", ["receiverId", "peerPublicKey", "peerReceiverPath"], "The contact is marked as publicly shared on the selected receiver path.", "Verify the saved contact and exact receiver path before retrying."),
];
const METHODS: &[ScenarioStep] = &[
    step!(
        "configure",
        "methods",
        "method.configure",
        ["receiverId", "walletId", "enabledMethods", "preference"],
        "The workspace shows both configured payment rails in the requested preference order.",
        "Use only btc-onchain and btc-lightning-bolt11 and keep preference within enabledMethods."
    ),
    step!(
        "publish-list",
        "methods",
        "paymentList.publish",
        ["receiverId", "amountSats", "expirySeconds"],
        "The public payment list is active and contains the exact satoshi amount.",
        "Inspect wallet configuration and retry after a terminal issuance failure."
    ),
];
const REQUESTS: &[ScenarioStep] = &[
    step!("create-request", "requests", "request.create", ["receiverId", "peerPublicKey", "peerReceiverPath", "amountSats", "description", "expirySeconds", "acceptedMethods", "recurrence"], "The sender workspace shows the request pending for the intended peer and rails.", "Correct explicit peer, amount, rail, or recurrence fields; never infer a fallback rail."),
    step!("accept-request", "requests", "request.accept", ["receiverId", "requestId"], "The peer workspace shows the request accepted.", "Acceptance must be run explicitly by the receiving peer after reviewing the request."),
    step!("execute-payment", "requests", "payment.execute", ["receiverId", "requestId", "walletId", "source"], "The execution is terminal on the explicitly selected public or private source and rail.", "If execution is uncertain, use payment.reconcile with its executionId; do not submit a replacement payment."),
];
const PROOFS: &[ScenarioStep] = &[
    step!("submit-proof", "proofs", "proof.submit", ["receiverId", "requestId"], "The request shows exactly one submitted execution proof or public proof material.", "Provide exactly one of executionId or proof and keep Lightning proof material private to this explicit submission."),
    step!("verify-proof", "proofs", "proof.verify", ["receiverId", "requestId", "proofId"], "The proof status reflects rail-specific verification.", "For on-chain proofs, wait for the requested confirmations before retrying verification."),
];
const RECEIPTS: &[ScenarioStep] = &[
    step!(
        "prepare-receipt",
        "receipts",
        "receipt.prepare",
        ["receiverId", "requestId", "proofId"],
        "An outbound receipt exists for the verified proof.",
        "Verify the proof first, then retry with the same public identifiers and a new command ID."
    ),
    step!(
        "process-receipt",
        "receipts",
        "receipt.process",
        ["receiverId", "receiptId"],
        "The receipt is processed and its public status is visible.",
        "Sync delivery and inspect the operation error code before retrying."
    ),
    step!(
        "retrieve-receipt",
        "receipts",
        "receipt.retrieve",
        [
            "receiverId",
            "peerPublicKey",
            "peerReceiverPath",
            "receiptId"
        ],
        "The receipt is retrieved from the explicitly selected peer path.",
        "Confirm the exact peer identity and path; no alternate source is selected automatically."
    ),
];
const SUBSCRIPTIONS: &[ScenarioStep] = &[
    step!(
        "prepare-period",
        "subscriptions",
        "subscription.prepare",
        [
            "receiverId",
            "requestId",
            "periodIndex",
            "source",
            "expirySeconds"
        ],
        "Exactly the selected due period is prepared without creating backlog payments.",
        "Inspect the recurrence clock and period index; missed periods are not paid automatically."
    ),
    step!(
        "authorize",
        "subscriptions",
        "subscription.authorize",
        ["receiverId", "requestId", "walletId", "source", "method"],
        "Future due periods may use only the explicitly authorized wallet, source, and method.",
        "Correct the explicit method selection; no public/private or rail fallback is inferred."
    ),
];
const BACKUP: &[ScenarioStep] = &[
    step!(fd "export", "backup.export", "An encrypted archive is written only to the inherited archive descriptor."),
    step!(fd "inspect", "backup.inspect", "The archive inspection operation reports a safe public recovery summary."),
    step!(fd "restore", "backup.restore", "The restored receiver enters its reported recovery phase."),
    step!(
        "reconcile",
        "backup",
        "recovery.reconcile",
        ["receiverId"],
        "Wallet recovery is reconciled or remains explicitly blocked.",
        "Resolve every reported recovery block before attempting peer relinking."
    ),
    step!(
        "prepare-relink",
        "links",
        "link.prepareRecovery",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        "Recovery markers are ready on both explicit peer endpoints.",
        "Do not advance the handshake until both public recovery markers are visible."
    ),
    step!(
        "relink",
        "links",
        "link.initiate",
        ["receiverId", "peerPublicKey", "peerReceiverPath"],
        "The restored receiver establishes a fresh link generation.",
        "Use the original peer identity and path and complete acceptance explicitly on the peer."
    ),
];

pub const SCENARIOS: &[Scenario] = &[
    Scenario {
        id: "funded-workspace",
        title: "Funded workspace",
        prerequisites: &["The Paykit service is ready."],
        steps: FUNDED,
    },
    Scenario {
        id: "multi-receiver-links",
        title: "Multi-receiver links",
        prerequisites: &[
            "Both receivers are running.",
            "Use each peer's public key and exact receiver path.",
        ],
        steps: LINKS,
    },
    Scenario {
        id: "profiles-and-contacts",
        title: "Profiles and contacts",
        prerequisites: &[
            "The publishing receiver is running.",
            "Peer receiver paths are known.",
        ],
        steps: PROFILES,
    },
    Scenario {
        id: "both-payment-rails",
        title: "On-chain and Lightning methods",
        prerequisites: &[
            "The workspace is funded.",
            "The selected wallet supports both declared rails.",
        ],
        steps: METHODS,
    },
    Scenario {
        id: "requests-and-payments",
        title: "Requests and payments",
        prerequisites: &[
            "Peers are linked.",
            "Payment methods are configured and published.",
        ],
        steps: REQUESTS,
    },
    Scenario {
        id: "proofs",
        title: "Proof submission and verification",
        prerequisites: &["A payment request and its execution exist."],
        steps: PROOFS,
    },
    Scenario {
        id: "receipts",
        title: "Receipt delivery",
        prerequisites: &[
            "A verified proof exists.",
            "Peers are linked for private delivery.",
        ],
        steps: RECEIPTS,
    },
    Scenario {
        id: "recurrence",
        title: "Recurring payments without backlog",
        prerequisites: &[
            "A recurring request is accepted.",
            "The application clock and desired period are explicit.",
        ],
        steps: SUBSCRIPTIONS,
    },
    Scenario {
        id: "backup-and-relink",
        title: "Backup, restore, and relink",
        prerequisites: &[
            "Archive and passphrase are supplied through inherited file descriptors only.",
        ],
        steps: BACKUP,
    },
];

pub fn catalog() -> Catalog {
    Catalog {
        api_version: 1,
        catalog_version: 1,
        panels: PANELS,
        commands: COMMANDS,
        scenarios: SCENARIOS,
    }
}

pub fn scenario(id: &str) -> Result<&'static Scenario, PublicError> {
    SCENARIOS
        .iter()
        .find(|scenario| scenario.id == id)
        .ok_or_else(|| {
            PublicError::new("scenario_not_found", "The guided scenario does not exist.")
        })
}

pub fn command_spec(id: &str) -> Option<&'static CommandSpec> {
    COMMANDS.iter().find(|spec| spec.id == id)
}

pub fn validate_scenario_step(
    scenario_id: &str,
    step_id: &str,
    command: &Command,
) -> Result<(), PublicError> {
    let step = scenario(scenario_id)?
        .steps
        .iter()
        .find(|step| step.id == step_id)
        .ok_or_else(|| {
            PublicError::new(
                "scenario_step_not_found",
                "The guided scenario step does not exist.",
            )
        })?;
    if !matches!(step.transport, StepTransport::Command) {
        return Err(PublicError::new(
            "fd_transport_required",
            "Use the file-descriptor backup command for this step.",
        ));
    }
    if command.command != step.command {
        return Err(PublicError::new(
            "scenario_command_mismatch",
            "The command does not match the selected guided step.",
        ));
    }
    crate::commands::validate(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use uuid::Uuid;

    #[test]
    fn catalog_has_all_unique_commands_and_stable_panels() {
        let ids: HashSet<_> = COMMANDS.iter().map(|command| command.id).collect();
        assert_eq!(COMMANDS.len(), 58);
        assert_eq!(ids.len(), 58);
        let panels: HashSet<_> = PANELS.iter().map(|panel| panel.id).collect();
        assert!(COMMANDS
            .iter()
            .all(|command| panels.contains(command.panel_id)));
        assert!(SCENARIOS
            .iter()
            .flat_map(|scenario| scenario.steps)
            .all(|step| panels.contains(step.panel_id) && ids.contains(step.command)));
    }

    #[test]
    fn catalog_inventory_matches_command_router() {
        for spec in COMMANDS {
            let command = Command {
                command_id: Uuid::new_v4(),
                command: spec.id.into(),
                input: serde_json::json!({}),
            };
            if let Err(error) = crate::commands::validate(&command) {
                assert_ne!(error.code, "unsupported_command", "{}", spec.id);
            }
        }
        assert!(command_spec("unknown.command").is_none());
    }

    #[test]
    fn scenario_runner_uses_existing_strict_validation() {
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "preset.create".into(),
            input: serde_json::json!({"secret":"no"}),
        };
        let expected = crate::commands::validate(&command).unwrap_err();
        assert_eq!(
            validate_scenario_step("funded-workspace", "create-preset", &command)
                .unwrap_err()
                .code,
            expected.code
        );
        let wrong = Command {
            command_id: Uuid::new_v4(),
            command: "preset.fund".into(),
            input: serde_json::json!({}),
        };
        assert_eq!(
            validate_scenario_step("funded-workspace", "create-preset", &wrong)
                .unwrap_err()
                .code,
            "scenario_command_mismatch"
        );
    }

    #[test]
    fn backup_steps_require_native_fd_transport() {
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "backup.export".into(),
            input: serde_json::json!({}),
        };
        assert_eq!(
            validate_scenario_step("backup-and-relink", "export", &command)
                .unwrap_err()
                .code,
            "fd_transport_required"
        );
        assert!(COMMANDS
            .iter()
            .filter(|spec| spec.id.starts_with("backup."))
            .all(|spec| !spec.generic_command_allowed));
    }
}

//! Supervisor, receiver and CLI composition roots.
use polar_paykit::{
    api::{self, ApiState},
    config::Config,
    receiver,
    repository::Repository,
    supervisor::Supervisor,
};
use std::{sync::Arc, time::Duration};
use zeroize::Zeroize;

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Err(error) = run(&args).await {
        if private_receiver_error_enabled(&args, |name| std::env::var(name).ok()) {
            eprintln!("Receiver private diagnostic: {error:#}");
        }
        eprintln!("Polar Paykit operation failed. Check service readiness and persistent state.");
        std::process::exit(1);
    }
}
fn private_receiver_error_enabled(args: &[String], env: impl Fn(&str) -> Option<String>) -> bool {
    args.first().map(String::as_str) == Some("receiver")
        && env("PAYKIT_PRIVATE_RECEIVER_CHILD").as_deref() == Some("1")
        && env("PAYKIT_PRIVATE_RECEIVER_DIAGNOSTICS").as_deref()
            == Some("receiver-diagnostics.json")
}
async fn run(args: &[String]) -> anyhow::Result<()> {
    match args.first().map(String::as_str) {
        Some("serve") => serve().await,
        Some("diagnose-session") => {
            let value = receiver::diagnose_session(
                Config::from_env()?,
                args.get(1)
                    .ok_or_else(|| anyhow::anyhow!("receiver required"))?
                    .parse()?,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Some("inspect-marker") => {
            let value = receiver::inspect_marker(
                args.get(1)
                    .ok_or_else(|| anyhow::anyhow!("owner required"))?,
                args.get(2)
                    .ok_or_else(|| anyhow::anyhow!("receiver path required"))?,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Some("inspect-payment-endpoints") => {
            anyhow::ensure!(args.len() == 3, "owner and path required");
            println!(
                "{}",
                receiver::inspect_payment_endpoints(&args[1], &args[2]).await?
            );
            Ok(())
        }
        Some("inspect-private-list") => {
            anyhow::ensure!(args.len() == 4, "receiver, peer and path required");
            let value = receiver::inspect_private_list(
                Config::from_env()?,
                args[1].parse()?,
                &args[2],
                &args[3],
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Some("inspect-avatar") => {
            anyhow::ensure!(args.len() == 4, "owner, path and blob name required");
            let value = receiver::inspect_avatar(&args[1], &args[2], &args[3]).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Some("inspect-contact") => {
            anyhow::ensure!(args.len() == 5, "owner, path, peer and peer path required");
            let value = receiver::inspect_contact(&args[1], &args[2], &args[3], &args[4]).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Some("receiver") => {
            receiver::run(
                Config::from_env()?,
                args.get(1)
                    .ok_or_else(|| anyhow::anyhow!("missing receiver"))?
                    .parse()?,
            )
            .await
        }
        Some("state")
        | Some("command")
        | Some("operation")
        | Some("health")
        | Some("catalog")
        | Some("scenario")
        | Some("scenario-step")
        | Some("diagnostics")
        | Some("wait") => cli(args).await,
        Some("backup") => backup_cli(args).await,
        _ => {
            eprintln!("Usage: polar-paykit serve | state | health | catalog | scenario ID | diagnostics | operation UUID | wait UUID [--timeout-seconds N] | command NAME JSON [COMMAND_UUID] [--no-wait] | scenario-step SCENARIO STEP JSON [COMMAND_UUID] [--no-wait]\nCLI: PAYKIT_API_URL and PAYKIT_TOKEN_FILE; default operation wait is 120 seconds.");
            Ok(())
        }
    }
}

#[cfg(unix)]
async fn backup_cli(args: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(args.len() >= 3, "backup action and receiver UUID required");
    let action = args[1].as_str();
    anyhow::ensure!(
        matches!(action, "export" | "inspect" | "restore"),
        "invalid backup action"
    );
    let receiver_id: uuid::Uuid = args[2].parse()?;
    let archive_fd = cli_fd(args, "--archive-fd")?;
    let passphrase_fd = cli_fd(args, "--passphrase-fd")?;
    let mut passphrase = zeroize::Zeroizing::new(read_fd(passphrase_fd, 1025)?);
    while matches!(passphrase.last(), Some(b'\n' | b'\r')) {
        passphrase.pop();
    }
    anyhow::ensure!(
        (12..=1024).contains(&passphrase.len()),
        "invalid passphrase length"
    );
    let purpose = if action == "export" { 1u8 } else { 2u8 };
    let archive = if action == "export" {
        zeroize::Zeroizing::new(Vec::new())
    } else {
        zeroize::Zeroizing::new(read_fd(
            archive_fd,
            polar_paykit::backup::MAX_ARCHIVE_BYTES + 1,
        )?)
    };
    anyhow::ensure!(
        archive.len() <= polar_paykit::backup::MAX_ARCHIVE_BYTES,
        "backup too large"
    );
    let base = std::env::var("PAYKIT_API_URL")?;
    ensure_loopback_url(&base)?;
    let token = zeroize::Zeroizing::new(std::fs::read_to_string(std::env::var(
        "PAYKIT_TOKEN_FILE",
    )?)?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(130))
        .build()?;
    let mut frame =
        zeroize::Zeroizing::new(Vec::with_capacity(27 + passphrase.len() + archive.len()));
    frame.extend_from_slice(b"PKTR");
    frame.extend_from_slice(&[1, purpose]);
    frame.extend_from_slice(receiver_id.as_bytes());
    frame.extend_from_slice(&(passphrase.len() as u16).to_be_bytes());
    frame.extend_from_slice(&(archive.len() as u32).to_be_bytes());
    frame.extend_from_slice(&passphrase);
    frame.extend_from_slice(&archive);
    let created = client
        .post(format!("{base}/v1/transfers"))
        .bearer_auth(token.trim())
        .header("content-type", "application/octet-stream")
        .body(frame.to_vec())
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    frame.zeroize();
    let transfer_id = created["transferId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing transfer id"))?;
    let command = polar_paykit::model::Command {
        command_id: uuid::Uuid::new_v4(),
        command: format!("backup.{action}"),
        input: serde_json::json!({"receiverId":receiver_id,"transferId":transfer_id}),
    };
    let result = submit_and_wait(&client, &base, token.trim(), &command).await?;
    if action == "export" {
        let bytes = client
            .get(format!("{base}/v1/transfers/{transfer_id}/archive"))
            .bearer_auth(token.trim())
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        write_archive_fd(archive_fd, &bytes)?;
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

#[cfg(unix)]
fn write_archive_fd(archive_fd: i32, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::fd::BorrowedFd;
    // SAFETY: the CLI contract requires archive_fd to remain open for this call.
    // Clone it so this function never closes the caller-owned descriptor.
    let borrowed = unsafe { BorrowedFd::borrow_raw(archive_fd) };
    let mut output = std::fs::File::from(borrowed.try_clone_to_owned()?);
    output.write_all(bytes)?;
    output.flush()?;
    Ok(())
}

#[cfg(not(unix))]
async fn backup_cli(_args: &[String]) -> anyhow::Result<()> {
    anyhow::bail!("file-descriptor backup CLI is unavailable on this platform")
}

fn cli_fd(args: &[String], flag: &str) -> anyhow::Result<i32> {
    let index = args
        .iter()
        .position(|value| value == flag)
        .ok_or_else(|| anyhow::anyhow!("{flag} required"))?;
    let fd: i32 = args
        .get(index + 1)
        .ok_or_else(|| anyhow::anyhow!("{flag} value required"))?
        .parse()?;
    anyhow::ensure!(fd >= 0, "invalid file descriptor");
    Ok(fd)
}

#[cfg(unix)]
fn read_fd(fd: i32, maximum: usize) -> anyhow::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(format!("/dev/fd/{fd}"))?;
    let mut bytes = Vec::new();
    file.by_ref().take(maximum as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

async fn submit_and_wait(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    command: &polar_paykit::model::Command,
) -> anyhow::Result<serde_json::Value> {
    let response = client
        .post(format!("{base}/v1/commands"))
        .bearer_auth(token)
        .json(command)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    let id = response["operationId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing operation id"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let result = client
            .get(format!("{base}/v1/operations/{id}"))
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        if result["status"] == "succeeded" {
            return Ok(result);
        }
        anyhow::ensure!(result["status"] != "failed", "operation failed");
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "operation wait timed out"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn serve() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    Config::bind_database()?;
    let repository = Arc::new(Repository::open(&config)?);
    let pubky_dir = config.data_dir.join("pubky");
    std::fs::create_dir_all(&pubky_dir)?;
    if !pubky_dir.join("config.toml").exists() {
        polar_paykit::storage::atomic_write(
            &pubky_dir.join("config.toml"),
            b"[general]\nsignup_mode = \"open\"\n",
        )?;
    }
    let testnet = pubky_testnet::StaticTestnet::builder()
        .persistent(config.data_dir.join("pubky"))
        .build()
        .await?;
    std::env::remove_var("TEST_PUBKY_CONNECTION_STRING");
    let listener = tokio::net::TcpListener::bind(&config.listen).await?;
    let (stop_sender, stop_receiver) = tokio::sync::watch::channel(false);
    let app = api::router(ApiState {
        repository: repository.clone(),
        token: Arc::new(config.token.clone()),
        shutdown: stop_receiver.clone(),
    });
    let supervisor = Supervisor::new(config, repository);
    let mut server_stop = stop_receiver.clone();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = server_stop.wait_for(|value| *value).await;
    });
    let shutdown = async {
        receiver::shutdown().await?;
        let _ = stop_sender.send(true);
        Ok::<_, anyhow::Error>(())
    };
    tokio::try_join!(
        supervisor.run(stop_receiver),
        async { server.await.map_err(anyhow::Error::from) },
        shutdown
    )?;
    drop(testnet);
    Ok(())
}

async fn cli(args: &[String]) -> anyhow::Result<()> {
    let action = parse_cli_action(args)?;
    let client = polar_paykit::client::Client::from_env()?;
    match action {
        CliAction::Get(path) => print_json(&client.get::<serde_json::Value>(path).await?),
        CliAction::Scenario(id) => print_json(
            &client
                .get::<serde_json::Value>(&format!("/v1/scenarios/{id}"))
                .await?,
        ),
        CliAction::Operation(id) => print_json(&client.operation(id).await?),
        CliAction::Wait { id, timeout } => wait_and_print(&client, id, timeout).await,
        CliAction::Submit { command, wait } => submit_cli_command(&client, &command, wait).await,
    }
}

enum CliAction {
    Get(&'static str),
    Scenario(String),
    Operation(uuid::Uuid),
    Wait {
        id: uuid::Uuid,
        timeout: Duration,
    },
    Submit {
        command: polar_paykit::model::Command,
        wait: bool,
    },
}

fn parse_cli_action(args: &[String]) -> anyhow::Result<CliAction> {
    match args.first().map(String::as_str) {
        Some("state") => exact_get(args, "/v1/state"),
        Some("health") => exact_get(args, "/health"),
        Some("catalog") => exact_get(args, "/v1/catalog"),
        Some("diagnostics") => exact_get(args, "/v1/diagnostics"),
        Some("scenario") => {
            ensure_len(args, 2, "scenario ID required")?;
            ensure_positional(&args[1], "scenario ID")?;
            Ok(CliAction::Scenario(args[1].clone()))
        }
        Some("operation") => {
            ensure_len(args, 2, "operation UUID required")?;
            Ok(CliAction::Operation(required_uuid(
                args.get(1),
                "operation UUID required",
            )?))
        }
        Some("wait") => parse_wait(args),
        Some("command") => parse_command(args, None),
        Some("scenario-step") => parse_scenario_step(args),
        _ => anyhow::bail!("unsupported CLI action"),
    }
}

fn exact_get(args: &[String], path: &'static str) -> anyhow::Result<CliAction> {
    anyhow::ensure!(args.len() == 1, "unexpected CLI arguments");
    Ok(CliAction::Get(path))
}

fn ensure_len(args: &[String], expected: usize, missing: &str) -> anyhow::Result<()> {
    anyhow::ensure!(args.len() >= expected, "{missing}");
    anyhow::ensure!(args.len() == expected, "unexpected CLI arguments");
    Ok(())
}

fn ensure_positional(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.starts_with("--"), "{name} required");
    Ok(())
}

fn parse_wait(args: &[String]) -> anyhow::Result<CliAction> {
    anyhow::ensure!(args.len() >= 2, "operation UUID required");
    let id = required_uuid(args.get(1), "operation UUID required")?;
    let timeout = match args.get(2).map(String::as_str) {
        None => Duration::from_secs(120),
        Some("--timeout-seconds") => {
            ensure_len(args, 4, "timeout value required")?;
            parse_timeout(&args[3])?
        }
        Some(_) => anyhow::bail!("unexpected CLI arguments"),
    };
    Ok(CliAction::Wait { id, timeout })
}

fn parse_timeout(value: &str) -> anyhow::Result<Duration> {
    let seconds: u64 = value.parse()?;
    anyhow::ensure!(
        (1..=3600).contains(&seconds),
        "timeout must be 1..3600 seconds"
    );
    Ok(Duration::from_secs(seconds))
}

fn parse_scenario_step(args: &[String]) -> anyhow::Result<CliAction> {
    anyhow::ensure!(args.len() >= 3, "scenario and step IDs required");
    ensure_positional(&args[1], "scenario ID")?;
    ensure_positional(&args[2], "scenario step ID")?;
    parse_command(args, Some((&args[1], &args[2])))
}

fn parse_command(
    args: &[String],
    selected_step: Option<(&str, &str)>,
) -> anyhow::Result<CliAction> {
    let offset = usize::from(selected_step.is_some());
    let input_index = 2 + offset;
    anyhow::ensure!(args.len() > input_index, "JSON input required");
    if selected_step.is_none() {
        ensure_positional(&args[1], "command name")?;
    }
    ensure_positional(&args[input_index], "JSON input")?;

    let optional = &args[input_index + 1..];
    let (command_id, wait) = parse_command_options(optional)?;
    let command_name = match selected_step {
        Some((scenario_id, step_id)) => polar_paykit::interfaces::scenario(scenario_id)?
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .ok_or_else(|| anyhow::anyhow!("scenario step not found"))?
            .command
            .to_owned(),
        None => args[1].clone(),
    };
    let command = polar_paykit::model::Command {
        command_id,
        command: command_name,
        input: serde_json::from_str(&args[input_index])?,
    };
    if let Some((scenario_id, step_id)) = selected_step {
        polar_paykit::interfaces::validate_scenario_step(scenario_id, step_id, &command)?;
    }
    Ok(CliAction::Submit { command, wait })
}

fn parse_command_options(args: &[String]) -> anyhow::Result<(uuid::Uuid, bool)> {
    match args {
        [] => Ok((uuid::Uuid::new_v4(), true)),
        [flag] if flag == "--no-wait" => Ok((uuid::Uuid::new_v4(), false)),
        [command_id] => Ok((command_id.parse()?, true)),
        [command_id, flag] if flag == "--no-wait" => Ok((command_id.parse()?, false)),
        _ => anyhow::bail!("unexpected CLI arguments"),
    }
}

fn print_json(value: &impl serde::Serialize) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn required_uuid(value: Option<&String>, message: &str) -> anyhow::Result<uuid::Uuid> {
    value
        .ok_or_else(|| anyhow::anyhow!("{message}"))?
        .parse()
        .map_err(Into::into)
}

async fn submit_cli_command(
    client: &polar_paykit::client::Client,
    command: &polar_paykit::model::Command,
    wait: bool,
) -> anyhow::Result<()> {
    let id = client.submit(command).await?;
    if !wait {
        return print_json(&serde_json::json!({"operationId": id}));
    }
    eprintln!("Accepted operation {id}");
    wait_and_print(client, id, Duration::from_secs(120)).await
}

async fn wait_and_print(
    client: &polar_paykit::client::Client,
    id: uuid::Uuid,
    timeout: Duration,
) -> anyhow::Result<()> {
    match client.wait(id, timeout).await {
        Ok(operation) => {
            print_json(&operation)?;
            if operation.status == polar_paykit::model::OperationStatus::Failed {
                let code = operation
                    .error
                    .as_ref()
                    .map_or("operation_failed", |error| error.code.as_str());
                anyhow::bail!("operation {id} failed: {code}");
            }
            Ok(())
        }
        Err(polar_paykit::client::ClientError::Timeout { operation_id }) => {
            print_json(
                &serde_json::json!({"operationId":operation_id,"status":"timeout","error":{"code":"operation_timeout","message":"The operation did not finish before the requested timeout."}}),
            )?;
            anyhow::bail!("operation {operation_id} wait timed out")
        }
        Err(error) => Err(error.into()),
    }
}

fn ensure_loopback_url(base: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(base)?;
    anyhow::ensure!(
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
        "CLI requires a loopback HTTP endpoint"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_cli_action, private_receiver_error_enabled, CliAction};

    fn cli_args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parser_accepts_documented_read_shapes() {
        for action in ["state", "health", "catalog", "diagnostics"] {
            assert!(matches!(
                parse_cli_action(&cli_args(&[action])).unwrap(),
                CliAction::Get(_)
            ));
        }
        assert!(matches!(
            parse_cli_action(&cli_args(&["scenario", "funded-workspace"])).unwrap(),
            CliAction::Scenario(_)
        ));

        let id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            parse_cli_action(&cli_args(&["operation", &id])).unwrap(),
            CliAction::Operation(_)
        ));
        assert!(matches!(
            parse_cli_action(&cli_args(&["wait", &id])).unwrap(),
            CliAction::Wait { timeout, .. } if timeout.as_secs() == 120
        ));
        assert!(matches!(
            parse_cli_action(&cli_args(&["wait", &id, "--timeout-seconds", "9"])).unwrap(),
            CliAction::Wait { timeout, .. } if timeout.as_secs() == 9
        ));
    }

    #[test]
    fn parser_accepts_documented_command_shapes() {
        let id = uuid::Uuid::new_v4().to_string();
        for suffix in [vec![], vec!["--no-wait"], vec![&id], vec![&id, "--no-wait"]] {
            let mut args = vec!["command", "preset.create", "{}"];
            args.extend(suffix.iter().copied());
            assert!(matches!(
                parse_cli_action(&cli_args(&args)).unwrap(),
                CliAction::Submit { .. }
            ));

            let mut scenario_args =
                vec!["scenario-step", "funded-workspace", "create-preset", "{}"];
            scenario_args.extend(suffix);
            assert!(matches!(
                parse_cli_action(&cli_args(&scenario_args)).unwrap(),
                CliAction::Submit { .. }
            ));
        }
    }

    #[test]
    fn parser_rejects_unknown_duplicate_and_surplus_arguments() {
        let id = uuid::Uuid::new_v4().to_string();
        let malformed = [
            vec!["state", "extra"],
            vec!["scenario", "funded-workspace", "extra"],
            vec!["operation", &id, "extra"],
            vec!["wait", &id, "--timeout-seconds", "5", "extra"],
            vec![
                "wait",
                &id,
                "--timeout-seconds",
                "5",
                "--timeout-seconds",
                "6",
            ],
            vec!["command", "preset.create", "{}", "--no-wiat"],
            vec!["command", "preset.create", "{}", "--no-wait", "--no-wait"],
            vec!["command", "preset.create", "{}", &id, "extra"],
        ];
        for args in malformed {
            assert!(
                parse_cli_action(&cli_args(&args)).is_err(),
                "accepted {args:?}"
            );
        }
    }

    #[test]
    fn parser_rejects_missing_values_and_flags_in_positional_slots() {
        let id = uuid::Uuid::new_v4().to_string();
        let malformed = [
            vec!["scenario"],
            vec!["operation"],
            vec!["wait", &id, "--timeout-seconds"],
            vec!["wait", &id, "--no-wait"],
            vec!["command", "--no-wait", "{}"],
            vec!["command", "preset.create", "--no-wait"],
            vec!["scenario-step", "--no-wait", "create-preset", "{}"],
            vec!["scenario-step", "funded-workspace", "--no-wait", "{}"],
            vec![
                "scenario-step",
                "funded-workspace",
                "create-preset",
                "--no-wait",
            ],
        ];
        for args in malformed {
            assert!(
                parse_cli_action(&cli_args(&args)).is_err(),
                "accepted {args:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn archive_writer_uses_and_preserves_inherited_descriptor() {
        use std::io::{Read, Seek, Write};
        use std::os::fd::AsRawFd;

        let directory = tempfile::tempdir().unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(directory.path().join("archive"))
            .unwrap();
        super::write_archive_fd(file.as_raw_fd(), b"encrypted-archive").unwrap();
        file.write_all(b"-parent-open").unwrap();
        file.rewind().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"encrypted-archive-parent-open");
    }

    #[test]
    fn detailed_receiver_error_requires_exact_private_child_contract() {
        let receiver = vec!["receiver".to_string(), uuid::Uuid::nil().to_string()];
        let enabled = |name: &str| match name {
            "PAYKIT_PRIVATE_RECEIVER_CHILD" => Some("1".into()),
            "PAYKIT_PRIVATE_RECEIVER_DIAGNOSTICS" => Some("receiver-diagnostics.json".into()),
            _ => None,
        };
        assert!(private_receiver_error_enabled(&receiver, enabled));
        assert!(!private_receiver_error_enabled(&["serve".into()], enabled));
        assert!(!private_receiver_error_enabled(
            &receiver,
            |name| match name {
                "PAYKIT_PRIVATE_RECEIVER_CHILD" => Some("1".into()),
                "PAYKIT_PRIVATE_RECEIVER_DIAGNOSTICS" => Some("application.cbor".into()),
                _ => None,
            }
        ));
        assert!(!private_receiver_error_enabled(
            &receiver,
            |name| match name {
                "PAYKIT_PRIVATE_RECEIVER_DIAGNOSTICS" => Some("receiver-diagnostics.json".into()),
                _ => None,
            }
        ));
    }
}

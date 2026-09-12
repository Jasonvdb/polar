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
    let client = polar_paykit::client::Client::from_env()?;
    match args[0].as_str() {
        "state" => print_json(&client.get::<serde_json::Value>("/v1/state").await?),
        "health" => print_json(&client.get::<serde_json::Value>("/health").await?),
        "catalog" => print_json(&client.get::<serde_json::Value>("/v1/catalog").await?),
        "diagnostics" => print_json(&client.get::<serde_json::Value>("/v1/diagnostics").await?),
        "scenario" => {
            let id = args
                .get(1)
                .ok_or_else(|| anyhow::anyhow!("scenario ID required"))?;
            print_json(
                &client
                    .get::<serde_json::Value>(&format!("/v1/scenarios/{id}"))
                    .await?,
            )
        }
        "operation" => {
            let id = required_uuid(args.get(1), "operation UUID required")?;
            print_json(&client.operation(id).await?)
        }
        "wait" => {
            let id = required_uuid(args.get(1), "operation UUID required")?;
            wait_and_print(&client, id, timeout_seconds(args)?).await
        }
        "command" => submit_cli_command(&client, args, None).await,
        "scenario-step" => {
            let scenario = args
                .get(1)
                .ok_or_else(|| anyhow::anyhow!("scenario ID required"))?;
            let step = args
                .get(2)
                .ok_or_else(|| anyhow::anyhow!("scenario step ID required"))?;
            submit_cli_command(&client, args, Some((scenario, step))).await
        }
        _ => anyhow::bail!("unsupported CLI action"),
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

fn timeout_seconds(args: &[String]) -> anyhow::Result<Duration> {
    let Some(index) = args.iter().position(|value| value == "--timeout-seconds") else {
        return Ok(Duration::from_secs(120));
    };
    let seconds: u64 = args
        .get(index + 1)
        .ok_or_else(|| anyhow::anyhow!("timeout value required"))?
        .parse()?;
    anyhow::ensure!(
        (1..=3600).contains(&seconds),
        "timeout must be 1..3600 seconds"
    );
    Ok(Duration::from_secs(seconds))
}

async fn submit_cli_command(
    client: &polar_paykit::client::Client,
    args: &[String],
    selected_step: Option<(&String, &String)>,
) -> anyhow::Result<()> {
    let offset = usize::from(selected_step.is_some());
    let command_name = if let Some((scenario_id, step_id)) = selected_step {
        polar_paykit::interfaces::scenario(scenario_id)?
            .steps
            .iter()
            .find(|step| step.id == step_id)
            .ok_or_else(|| anyhow::anyhow!("scenario step not found"))?
            .command
            .to_owned()
    } else {
        args.get(1)
            .ok_or_else(|| anyhow::anyhow!("command name required"))?
            .clone()
    };
    let input_index = 2 + offset;
    let command_id_index = input_index + 1;
    let command = polar_paykit::model::Command {
        command_id: args
            .get(command_id_index)
            .filter(|value| !value.starts_with("--"))
            .map(|value| value.parse())
            .transpose()?
            .unwrap_or_else(uuid::Uuid::new_v4),
        command: command_name,
        input: serde_json::from_str(
            args.get(input_index)
                .ok_or_else(|| anyhow::anyhow!("JSON input required"))?,
        )?,
    };
    if let Some((scenario_id, step_id)) = selected_step {
        polar_paykit::interfaces::validate_scenario_step(scenario_id, step_id, &command)?;
    }
    let id = client.submit(&command).await?;
    if args.iter().any(|value| value == "--no-wait") {
        return print_json(&serde_json::json!({"operationId": id}));
    }
    eprintln!("Accepted operation {id}");
    wait_and_print(client, id, timeout_seconds(args)?).await
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
    use super::private_receiver_error_enabled;

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

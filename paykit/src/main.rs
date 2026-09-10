//! Supervisor, receiver and CLI composition roots.
use polar_paykit::{
    api::{self, ApiState},
    config::Config,
    receiver,
    repository::Repository,
    supervisor::Supervisor,
};
use std::{sync::Arc, time::Duration};

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("Polar Paykit operation failed. Check service readiness and persistent state.");
        std::process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
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
        Some("receiver") => {
            receiver::run(
                Config::from_env()?,
                args.get(1)
                    .ok_or_else(|| anyhow::anyhow!("missing receiver"))?
                    .parse()?,
            )
            .await
        }
        Some("state") | Some("command") | Some("operation") | Some("health") => cli(&args).await,
        _ => {
            eprintln!("Usage: polar-paykit serve | state | health | operation UUID | command NAME JSON [COMMAND_UUID]\nCLI: PAYKIT_API_URL and PAYKIT_TOKEN_FILE; operations wait up to 120 seconds.");
            Ok(())
        }
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
    let base = std::env::var("PAYKIT_API_URL")?;
    let url = reqwest::Url::parse(&base)?;
    anyhow::ensure!(
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
        "CLI requires a loopback HTTP endpoint"
    );
    let token = zeroize::Zeroizing::new(std::fs::read_to_string(std::env::var(
        "PAYKIT_TOKEN_FILE",
    )?)?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let path = match args[0].as_str() {
        "state" => "/v1/state".into(),
        "health" => "/health".into(),
        "operation" => format!(
            "/v1/operations/{}",
            args.get(1)
                .ok_or_else(|| anyhow::anyhow!("operation UUID required"))?
                .parse::<uuid::Uuid>()?
        ),
        _ => "/v1/commands".into(),
    };
    if args[0] != "command" {
        let value = client
            .get(format!("{base}{path}"))
            .bearer_auth(token.trim())
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let command = polar_paykit::model::Command {
        command_id: args
            .get(3)
            .map(|v| v.parse())
            .transpose()?
            .unwrap_or_else(uuid::Uuid::new_v4),
        command: args
            .get(1)
            .ok_or_else(|| anyhow::anyhow!("command name required"))?
            .clone(),
        input: serde_json::from_str(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("JSON input required"))?,
        )?,
    };
    let response = client
        .post(format!("{base}{path}"))
        .bearer_auth(token.trim())
        .json(&command)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    let id = response["operationId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing operation id"))?;
    eprintln!("Accepted operation {id}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let result = client
            .get(format!("{base}/v1/operations/{id}"))
            .bearer_auth(token.trim())
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        if result["status"] == "succeeded" || result["status"] == "failed" {
            println!("{}", serde_json::to_string_pretty(&result)?);
            anyhow::ensure!(result["status"] == "succeeded", "operation failed");
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "operation wait timed out; poll the existing operation"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

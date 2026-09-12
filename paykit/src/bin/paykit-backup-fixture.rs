//! Non-shipping backup scenario mutation helper.

use polar_paykit::config::Config;

fn main() {
    if let Err(error) = run() {
        eprintln!("Backup fixture failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let config = Config::from_env()?;
    match args.first().map(String::as_str) {
        Some("prune-executions") if args.len() == 4 => {
            let (removed_executions, removed_settlements) =
                polar_paykit::backup::fixture_prune_post_export_executions(
                    &config,
                    args[1].parse()?,
                    &args[2],
                    &args[3],
                )?;
            println!(
                "{}",
                serde_json::json!({
                    "removedExecutions": removed_executions,
                    "removedSettlements": removed_settlements,
                })
            );
        }
        Some("mark-peer-unsafe") if args.len() == 4 => {
            let count = polar_paykit::backup::fixture_mark_peer_unsafe(
                &config,
                args[1].parse()?,
                &args[2],
                &args[3],
            )?;
            println!("{}", serde_json::json!({"unsafeCheckpoints":count}));
        }
        Some("journal-projection") if args.len() == 1 => {
            println!(
                "{}",
                polar_paykit::backup::fixture_journal_projection(&config)?
            );
        }
        _ => anyhow::bail!("invalid backup fixture command"),
    }
    Ok(())
}

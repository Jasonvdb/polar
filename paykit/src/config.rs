//! Trusted process configuration; secret values never enter public DTOs.
use std::{env, path::PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Config {
    pub environment_id: Uuid,
    pub data_dir: PathBuf,
    pub key: Zeroizing<[u8; 32]>,
    pub token: Zeroizing<String>,
    pub listen: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let key_text = secret_file("PAYKIT_KEY_FILE")?;
        let key: [u8; 32] = hex::decode(key_text.trim())?
            .try_into()
            .map_err(|_| anyhow::anyhow!("master key must contain 32 hexadecimal bytes"))?;
        let token = secret_file("PAYKIT_TOKEN_FILE")?;
        anyhow::ensure!(
            token.len() == 64 && token.bytes().all(|v| v.is_ascii_hexdigit()),
            "invalid API token file"
        );
        Ok(Self {
            environment_id: env::var("PAYKIT_ENVIRONMENT_ID")?.parse()?,
            data_dir: PathBuf::from(env::var("PAYKIT_DATA_DIR")?),
            key: Zeroizing::new(key),
            token,
            listen: env::var("PAYKIT_LISTEN").unwrap_or_else(|_| "0.0.0.0:10090".into()),
        })
    }

    pub fn bind_database() -> anyhow::Result<()> {
        let password = secret_file("PAYKIT_POSTGRES_PASSWORD_FILE")?;
        anyhow::ensure!(
            password.len() == 64 && password.bytes().all(|v| v.is_ascii_hexdigit()),
            "invalid database password file"
        );
        let host = env::var("PAYKIT_POSTGRES_HOST").unwrap_or_else(|_| "paykit-postgres".into());
        anyhow::ensure!(
            host.bytes()
                .all(|v| v.is_ascii_alphanumeric() || b".-".contains(&v)),
            "invalid database host"
        );
        env::set_var(
            "TEST_PUBKY_CONNECTION_STRING",
            format!("postgresql://pubky:{}@{host}:5432/pubky", password.as_str()),
        );
        Ok(())
    }
}

fn secret_file(name: &str) -> anyhow::Result<Zeroizing<String>> {
    Ok(Zeroizing::new(
        std::fs::read_to_string(env::var(name)?)?.trim().to_owned(),
    ))
}

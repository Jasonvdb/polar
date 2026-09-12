//! Loopback API client shared by command-line interfaces.

use crate::model::{Command, Operation, OperationStatus, PublicError};
use serde::de::DeserializeOwned;
use std::time::Duration;
use uuid::Uuid;
use zeroize::Zeroizing;

pub struct Client {
    base: String,
    token: Zeroizing<String>,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum ClientError {
    Transport(anyhow::Error),
    Api { status: u16, error: PublicError },
    Timeout { operation_id: Uuid },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(formatter, "{error:#}"),
            Self::Api { status, error } => write!(
                formatter,
                "Paykit API error {status}: {} ({})",
                error.code, error.message
            ),
            Self::Timeout { operation_id } => {
                write!(formatter, "operation {operation_id} wait timed out")
            }
        }
    }
}

impl std::error::Error for ClientError {}

impl Client {
    pub fn from_env() -> Result<Self, ClientError> {
        let base = std::env::var("PAYKIT_API_URL").map_err(transport)?;
        ensure_loopback_url(&base)?;
        let token_path = std::env::var("PAYKIT_TOKEN_FILE").map_err(transport)?;
        let token = Zeroizing::new(std::fs::read_to_string(token_path).map_err(transport)?);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(130))
            .build()
            .map_err(transport)?;
        Ok(Self { base, token, http })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ClientError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(self.token.trim())
            .send()
            .await
            .map_err(transport)?;
        decode(response).await
    }

    pub async fn submit(&self, command: &Command) -> Result<Uuid, ClientError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Accepted {
            operation_id: Uuid,
        }
        let response = self
            .http
            .post(format!("{}/v1/commands", self.base))
            .bearer_auth(self.token.trim())
            .json(command)
            .send()
            .await
            .map_err(transport)?;
        Ok(decode::<Accepted>(response).await?.operation_id)
    }

    pub async fn operation(&self, id: Uuid) -> Result<Operation, ClientError> {
        self.get(&format!("/v1/operations/{id}")).await
    }

    pub async fn wait(&self, id: Uuid, timeout: Duration) -> Result<Operation, ClientError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let operation = self.operation(id).await?;
            if matches!(
                operation.status,
                OperationStatus::Succeeded | OperationStatus::Failed
            ) {
                return Ok(operation);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ClientError::Timeout { operation_id: id });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

fn ensure_loopback_url(base: &str) -> Result<(), ClientError> {
    let url = reqwest::Url::parse(base).map_err(transport)?;
    if url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    {
        Ok(())
    } else {
        Err(transport(anyhow::anyhow!(
            "CLI requires a loopback HTTP endpoint"
        )))
    }
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, ClientError> {
    let status = response.status();
    if status.is_success() {
        return response.json().await.map_err(transport);
    }
    let error = response.json::<PublicError>().await.unwrap_or_else(|_| {
        PublicError::new(
            "invalid_response",
            "The Paykit API returned an invalid error response.",
        )
    });
    Err(ClientError::Api {
        status: status.as_u16(),
        error,
    })
}

fn transport(error: impl Into<anyhow::Error>) -> ClientError {
    ClientError::Transport(error.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_error_preserves_operation_id() {
        let id = Uuid::new_v4();
        let error = ClientError::Timeout { operation_id: id };
        assert!(error.to_string().contains(&id.to_string()));
    }
}

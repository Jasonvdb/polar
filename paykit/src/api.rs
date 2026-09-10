//! Authenticated HTTP v1 boundary and replayable server events.
use crate::{
    model::{Command, PublicError},
    repository::Repository,
};
use axum::{
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    convert::Infallible,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct ApiState {
    pub repository: Arc<Repository>,
    pub token: Arc<Zeroizing<String>>,
}
pub fn router(state: ApiState) -> Router {
    let protected = Router::new()
        .route("/v1/state", get(snapshot))
        .route("/v1/commands", post(command))
        .route("/v1/operations/{id}", get(operation))
        .route("/v1/events", get(events))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(state)
}
async fn authenticate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let actual = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if actual.as_bytes().ct_eq(state.token.as_bytes()).unwrap_u8() != 1 {
        return failure(
            StatusCode::UNAUTHORIZED,
            PublicError::new("unauthorized", "A valid API token is required."),
        );
    }
    next.run(request).await
}
async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let ready = state.repository.ready.load(Ordering::SeqCst);
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({"apiVersion":1,"ready":ready})),
    )
}
async fn snapshot(State(state): State<ApiState>) -> Response {
    match state.repository.snapshot() {
        Ok(value) => {
            Json(value.public(state.repository.ready.load(Ordering::SeqCst))).into_response()
        }
        Err(_) => unavailable(),
    }
}
async fn command(
    State(state): State<ApiState>,
    request: Result<Json<Command>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(request)) = request else {
        return failure(
            StatusCode::BAD_REQUEST,
            PublicError::new("invalid_input", "Expected an API v1 command."),
        );
    };
    match state.repository.accept(request) {
        Ok(id) => (StatusCode::ACCEPTED, Json(json!({"operationId":id}))).into_response(),
        Err(error) => {
            let status = match error.code.as_str() {
                "command_conflict" => StatusCode::CONFLICT,
                "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            };
            failure(status, error)
        }
    }
}
async fn operation(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let Ok(id) = id.parse::<Uuid>() else {
        return failure(
            StatusCode::BAD_REQUEST,
            PublicError::new("invalid_input", "Expected an operation UUID."),
        );
    };
    match state.repository.snapshot() {
        Ok(value) => match value.operations.into_iter().find(|v| v.public.id == id) {
            Some(v) => Json(v.public).into_response(),
            None => failure(
                StatusCode::NOT_FOUND,
                PublicError::new("not_found", "Operation not found."),
            ),
        },
        Err(_) => unavailable(),
    }
}
#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: u64,
}
async fn events(
    State(state): State<ApiState>,
    query: Result<Query<EventQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return failure(
            StatusCode::BAD_REQUEST,
            PublicError::new("invalid_input", "Expected a nonnegative event sequence."),
        );
    };
    let Ok(snapshot) = state.repository.snapshot() else {
        return unavailable();
    };
    if query.after > snapshot.events.last().map_or(0, |v| v.sequence) {
        return failure(
            StatusCode::CONFLICT,
            PublicError::new(
                "event_cursor_reset",
                "The cursor is ahead of this environment. Reload state and reconnect.",
            ),
        );
    }
    let stream = async_stream::stream! {let mut cursor=query.after;loop{
        let notified=state.repository.notify.notified();
        let Ok(snapshot)=state.repository.snapshot()else{break;};
        for event in snapshot.events.into_iter().filter(|v|v.sequence>cursor).collect::<Vec<_>>(){cursor=event.sequence;
            yield Ok::<_,Infallible>(Event::default().id(cursor.to_string()).event(event.event_type.clone()).data(serde_json::to_string(&event).unwrap_or_default()));}
        tokio::select!{_=notified=>{},_=tokio::time::sleep(Duration::from_secs(2))=>{}}
    }};
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response()
}
fn failure(status: StatusCode, error: PublicError) -> Response {
    (status, Json(json!({"error":error}))).into_response()
}
fn unavailable() -> Response {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        PublicError::new("unavailable", "Persistent state is unavailable."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body, HttpBody},
        http::Request,
    };
    use tower::ServiceExt;
    fn fixture() -> (tempfile::TempDir, Router, Arc<Repository>) {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            environment_id: Uuid::new_v4(),
            data_dir: dir.path().into(),
            key: Zeroizing::new([2; 32]),
            token: Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        };
        let repository = Arc::new(Repository::open(&config).unwrap());
        repository.ready.store(true, Ordering::SeqCst);
        let app = router(ApiState {
            repository: repository.clone(),
            token: Arc::new(config.token),
        });
        (dir, app, repository)
    }
    #[tokio::test]
    async fn authenticated_acceptance_returns_before_operation_runs() {
        let (_dir, app, repo) = fixture();
        let id = Uuid::new_v4();
        let response = app
            .oneshot(
                Request::post("/v1/commands")
                    .header("authorization", format!("Bearer {}", "a".repeat(64)))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"commandId":id,"command":"preset.create","input":{}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(
            repo.snapshot().unwrap().operations[0].public.status
                == crate::model::OperationStatus::Queued
        );
    }
    #[tokio::test]
    async fn missing_token_rejected_and_error_does_not_echo_input() {
        let (_dir, app, _) = fixture();
        let response = app
            .oneshot(
                Request::get("/v1/state")
                    .header("authorization", "Bearer secret-do-not-echo")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("secret-do-not-echo"));
    }
    #[tokio::test]
    async fn event_replay_returns_persisted_sequence() {
        let (_dir, app, repo) = fixture();
        repo.update(|s| {
            s.event("receiver.stopped", json!({"receiverId":Uuid::new_v4()}));
            Ok(())
        })
        .unwrap();
        let response = app
            .oneshot(
                Request::get("/v1/events?after=0")
                    .header("authorization", format!("Bearer {}", "a".repeat(64)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut body = response.into_body();
        let frame = tokio::time::timeout(
            Duration::from_secs(1),
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let data = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("id: 1"));
        assert!(text.contains("event: receiver.stopped"));
        assert!(text.contains("\"sequence\":1"));
    }
    #[tokio::test]
    async fn cursor_ahead_requires_explicit_state_reset() {
        let (_dir, app, _) = fixture();
        let response = app
            .oneshot(
                Request::get("/v1/events?after=99")
                    .header("authorization", format!("Bearer {}", "a".repeat(64)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
}

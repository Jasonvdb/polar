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
    pub shutdown: tokio::sync::watch::Receiver<bool>,
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
    match state.repository.public_state() {
        Ok(value) => Json(value).into_response(),
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
    if let Err(error) = state.repository.events_after(query.after) {
        return if error.code == "event_cursor_reset" {
            failure(StatusCode::CONFLICT, error)
        } else {
            unavailable()
        };
    }
    let stream = async_stream::stream! {
        let mut cursor = query.after;
        let mut shutdown = state.shutdown;
        'events: loop {
            if *shutdown.borrow() { break; }
            let notified = state.repository.notify.notified();
            let events = match state.repository.events_after(cursor) {
                Ok(events) => events,
                Err(error) => {
                    if error.code == "event_cursor_reset" {
                        yield Ok::<_, Infallible>(Event::default()
                            .event("event_cursor_reset")
                            .data(json!({"error":error}).to_string()));
                    }
                    break;
                }
            };
            for event in events {
                if *shutdown.borrow() { break 'events; }
                cursor = event.sequence;
                yield Ok::<_, Infallible>(Event::default()
                    .id(cursor.to_string())
                    .event(event.event_type.clone())
                    .data(serde_json::to_string(&event).unwrap_or_default()));
            }
            tokio::select! {
                biased;
                _ = shutdown.wait_for(|stopping| *stopping) => break,
                _ = notified => {},
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            }
        }
    };
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
    fn fixture() -> (
        tempfile::TempDir,
        Router,
        Arc<Repository>,
        tokio::sync::watch::Sender<bool>,
    ) {
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
        let (shutdown_sender, shutdown) = tokio::sync::watch::channel(false);
        let app = router(ApiState {
            repository: repository.clone(),
            token: Arc::new(config.token),
            shutdown,
        });
        (dir, app, repository, shutdown_sender)
    }
    #[tokio::test]
    async fn authenticated_acceptance_returns_before_operation_runs() {
        let (_dir, app, repo, _shutdown) = fixture();
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
        let (_dir, app, _, _shutdown) = fixture();
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
    async fn state_summarizes_large_operations_while_detail_retains_the_result() {
        let (_dir, app, repo, _shutdown) = fixture();
        let id = Uuid::new_v4();
        let large = "x".repeat(4 * 1024 * 1024);
        repo.update(|state| {
            state.operations.push(crate::model::OperationRecord {
                public: crate::model::Operation {
                    id,
                    command: "clock.set".into(),
                    status: crate::model::OperationStatus::Succeeded,
                    result: Some(json!({"workspace":large.clone()})),
                    error: None,
                },
                request: Command {
                    command_id: id,
                    command: "clock.set".into(),
                    input: json!({}),
                },
            });
            Ok(())
        })
        .unwrap();

        let state_response = app
            .clone()
            .oneshot(authenticated_get("/v1/state"))
            .await
            .unwrap();
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_body = to_bytes(state_response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let state: serde_json::Value = serde_json::from_slice(&state_body).unwrap();
        assert_eq!(state["operations"][0]["id"], id.to_string());
        assert_eq!(state["operations"][0]["command"], "clock.set");
        assert_eq!(state["operations"][0]["status"], "succeeded");
        assert!(state["operations"][0].get("result").is_none());

        let detail_response = app
            .oneshot(authenticated_get(&format!("/v1/operations/{id}")))
            .await
            .unwrap();
        assert_eq!(detail_response.status(), StatusCode::OK);
        let detail_body = to_bytes(detail_response.into_body(), 5 * 1024 * 1024)
            .await
            .unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&detail_body).unwrap();
        assert_eq!(detail["result"]["workspace"].as_str(), Some(large.as_str()));
        assert!(repo.snapshot().unwrap().operations[0]
            .public
            .result
            .is_some());
    }

    fn authenticated_get(path: &str) -> Request<Body> {
        Request::get(path)
            .header("authorization", format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap()
    }
    #[tokio::test]
    async fn event_replay_returns_persisted_sequence() {
        let (_dir, app, repo, _shutdown) = fixture();
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
        let (_dir, app, _, _shutdown) = fixture();
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
    #[tokio::test]
    async fn held_http_event_stream_ends_before_graceful_server_shutdown_completes() {
        let (_dir, app, repository, shutdown) = fixture();
        repository
            .update(|state| {
                state.event("receiver.stopped", json!({"receiverId":Uuid::new_v4()}));
                Ok(())
            })
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut server_shutdown = shutdown.subscribe();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = server_shutdown.wait_for(|stopping| *stopping).await;
                })
                .await
                .unwrap();
        });
        let mut response = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
            .get(format!("http://{address}/v1/events?after=0"))
            .bearer_auth("a".repeat(64))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let frame = tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&frame).contains("id: 1"));
        shutdown.send(true).unwrap();
        // Keep the client response alive: closing it would hide the shutdown bug.
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("server must finish with the SSE client still connected")
            .unwrap();
        let remainder = tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap();
        assert!(remainder.is_none(), "server must terminate the SSE body");
    }

    #[tokio::test]
    async fn event_stream_opened_after_shutdown_ends_without_replaying_events() {
        let (_dir, app, repository, shutdown) = fixture();
        repository
            .update(|state| {
                state.event("receiver.stopped", json!({"receiverId":Uuid::new_v4()}));
                Ok(())
            })
            .unwrap();
        shutdown.send(true).unwrap();
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
        let body =
            tokio::time::timeout(Duration::from_secs(1), to_bytes(response.into_body(), 4096))
                .await
                .expect("already-signaled shutdown must terminate the stream")
                .unwrap();
        assert!(body.is_empty());
    }
    async fn event_response(app: Router, after: u64) -> Response {
        app.oneshot(
            Request::get(format!("/v1/events?after={after}"))
                .header("authorization", format!("Bearer {}", "a".repeat(64)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn next_event(body: &mut Body) -> String {
        let frame = tokio::time::timeout(
            Duration::from_secs(3),
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut *body).poll_frame(cx)),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn expired_cursor_requires_reload_but_exact_retained_boundary_replays() {
        let (_dir, app, repo, _shutdown) = fixture();
        repo.update(|state| {
            for _ in 0..crate::model::EVENT_RETENTION + 8 {
                state.event("receiver.workspace", json!({"receiverId":Uuid::nil()}));
            }
            Ok(())
        })
        .unwrap();
        let response = event_response(app.clone(), 7).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let error: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(error["error"]["code"], "event_cursor_reset");
        let mut body = event_response(app.clone(), 8).await.into_body();
        let first = next_event(&mut body).await;
        assert!(first.contains("id: 9\n"));
        assert!(first.contains("receiver.workspace"));
        let state = repo.public_state().unwrap();
        let response = event_response(app.clone(), state.last_event_sequence).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        repo.update(|state| {
            state.event("environment.ready", json!({}));
            Ok(())
        })
        .unwrap();
        assert!(next_event(&mut body).await.contains("id: 265\n"));
        assert_eq!(
            event_response(app, 266).await.status(),
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn connected_consumer_that_loses_history_gets_reset_and_closed_stream() {
        let (_dir, app, repo, _shutdown) = fixture();
        repo.update(|state| {
            state.event("environment.ready", json!({}));
            Ok(())
        })
        .unwrap();
        let response = event_response(app, 0).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        assert!(next_event(&mut body).await.contains("id: 1\n"));
        repo.update(|state| {
            for _ in 0..crate::model::EVENT_RETENTION + 1 {
                state.event("receiver.workspace", json!({"receiverId":Uuid::nil()}));
            }
            Ok(())
        })
        .unwrap();
        let reset = next_event(&mut body).await;
        assert!(reset.contains("event: event_cursor_reset\n"));
        assert!(reset.contains("lastEventSequence"));
        assert!(
            !reset.contains("id:"),
            "reset must not acknowledge skipped events"
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(1), to_bytes(body, 4096))
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn history_expiring_between_headers_and_first_frame_resets_stream() {
        let (_dir, app, repo, _shutdown) = fixture();
        let response = event_response(app, 0).await;
        assert_eq!(response.status(), StatusCode::OK);
        repo.update(|state| {
            for _ in 0..crate::model::EVENT_RETENTION + 1 {
                state.event("receiver.workspace", json!({"receiverId":Uuid::nil()}));
            }
            Ok(())
        })
        .unwrap();
        let bytes =
            tokio::time::timeout(Duration::from_secs(1), to_bytes(response.into_body(), 4096))
                .await
                .unwrap()
                .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: event_cursor_reset\n"));
        assert!(!text.contains("id:"));
    }
}

//! Bounded newline IPC; one receiver owns every SDK operation and storage lock.
use crate::{model::Command, workspace::Runtime, workspace_model::Workspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub receiver_id: Uuid,
    pub workspace: Workspace,
    pub command_id: Option<Uuid>,
    pub result: Option<Value>,
    pub error: Option<String>,
}
/// Unlike `lines`, this does not allocate an unbounded buffer before rejecting it.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    read_frame_into(reader, &mut Vec::new(), limit).await
}
/// The caller retains partial bytes when a competing select branch cancels this future.
async fn read_frame_into<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    frame: &mut Vec<u8>,
    limit: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            anyhow::ensure!(frame.is_empty(), "truncated IPC frame");
            return Ok(None);
        }
        let end = available.iter().position(|b| *b == b'\n');
        let count = end.map_or(available.len(), |p| p + 1);
        anyhow::ensure!(frame.len() + count <= limit, "IPC frame too large");
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(std::mem::take(frame)));
        }
    }
}
pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    anyhow::ensure!(bytes.len() < MAX_FRAME, "IPC frame too large");
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}
// Tokio's generic stdio wrappers use blocking threads that cannot be cancelled.
// Receivers always inherit pipes; nonblocking descriptors let shutdown drop pending IO.
fn stdin_pipe() -> std::io::Result<tokio::net::unix::pipe::Receiver> {
    use std::os::fd::AsFd;
    tokio::net::unix::pipe::Receiver::from_owned_fd(std::io::stdin().as_fd().try_clone_to_owned()?)
}
fn stdout_pipe() -> std::io::Result<tokio::net::unix::pipe::Sender> {
    use std::os::fd::AsFd;
    tokio::net::unix::pipe::Sender::from_owned_fd(std::io::stdout().as_fd().try_clone_to_owned()?)
}
pub async fn run(mut runtime: Runtime) -> anyhow::Result<()> {
    let mut stdin = tokio::io::BufReader::new(stdin_pipe()?);
    let mut stdout = stdout_pipe()?;
    let mut pending_input = Vec::new();
    emit(&mut stdout, &runtime, None, None, None).await?;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        tokio::select! {
            result=read_frame_into(&mut stdin,&mut pending_input,512*1024)=>{
                let Some(bytes)=result? else {return Ok(());};
                let command:Command=serde_json::from_slice(&bytes)?;
                let id=command.command_id;
                // The outer shutdown select cancels this future. Incomplete intent remains durable.
                let result=runtime.execute(command).await?;
                let (value,error)=match result {Ok(v)=>(Some(v),None),Err(e)=>(None,Some(e))};
                emit(&mut stdout,&runtime,Some(id),value,error).await?;
            }
            _=interval.tick()=>{
                let before=runtime.view();
                runtime.background().await?;
                if before != runtime.view() {emit(&mut stdout,&runtime,None,None,None).await?;}
            }
        }
    }
}
async fn emit<W: AsyncWrite + Unpin>(
    writer: &mut W,
    runtime: &Runtime,
    command_id: Option<Uuid>,
    result: Option<Value>,
    error: Option<String>,
) -> anyhow::Result<()> {
    let workspace = runtime.view();
    write_frame(
        writer,
        &Frame {
            receiver_id: workspace.receiver_id,
            workspace,
            command_id,
            result,
            error,
        },
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stdio_child_shutdown_probe() {
        if std::env::var("PAYKIT_STDIO_SHUTDOWN_PROBE").as_deref() != Ok("1") {
            return;
        }
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut reader = tokio::io::BufReader::new(stdin_pipe().unwrap());
            assert!(tokio::time::timeout(
                std::time::Duration::from_millis(25),
                read_frame(&mut reader, 16)
            )
            .await
            .is_err());
        });
        drop(runtime); // Must not wait for the parent to close/write its held stdin pipe.
    }
    #[test]
    fn pending_stdio_read_does_not_hold_process_runtime_shutdown() {
        use std::io::Write;
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "receiver_ipc::tests::stdio_child_shutdown_probe",
                "--nocapture",
            ])
            .env("PAYKIT_STDIO_SHUTDOWN_PROBE", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut held_writer = child.stdin.take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        if status.is_none() {
            // Even the red version is cleaned without force: wake its blocking read.
            let _ = held_writer.write_all(b"\n");
            drop(held_writer);
            let _ = child.wait();
        }
        assert!(
            status.is_some_and(|status| status.success()),
            "runtime waited for held stdin"
        );
    }
    #[tokio::test]
    async fn cancelled_partial_frame_resumes_without_losing_consumed_prefix() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut reader = tokio::io::BufReader::new(reader);
        let mut pending = Vec::new();
        writer.write_all(b"{\"receiver").await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            read_frame_into(&mut reader, &mut pending, 64)
        )
        .await
        .is_err());
        writer.write_all(b"Id\":1}\n").await.unwrap();
        assert_eq!(
            read_frame_into(&mut reader, &mut pending, 64)
                .await
                .unwrap()
                .unwrap(),
            b"{\"receiverId\":1}\n"
        );
    }
    #[tokio::test]
    async fn rejects_oversize_and_truncated_frames() {
        assert!(read_frame(&mut &b"12345\n"[..], 4).await.is_err());
        assert!(read_frame(&mut &b"123"[..], 4).await.is_err());
        assert_eq!(
            read_frame(&mut &b"123\n"[..], 4).await.unwrap().unwrap(),
            b"123\n"
        );
    }
    #[tokio::test]
    async fn held_frame_can_be_cancelled_without_a_writer_task() {
        let (_writer, reader) = tokio::io::duplex(16);
        let mut reader = tokio::io::BufReader::new(reader);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            read_frame(&mut reader, 16)
        )
        .await
        .is_err());
    }
}

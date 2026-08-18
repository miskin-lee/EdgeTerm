use std::io::{Read, Write};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::{emit_state, reject_sftp, OutputPump, SessionCommand};
use crate::error::{err, Result};
use crate::model::{default_shell, SessionKind, SessionProfile};

/// Spawns a login shell on a local pseudo-terminal.
///
/// Two threads per session: one parked on the pty reader, one draining the
/// command queue. The pty crate is blocking, so neither belongs on the async
/// runtime.
pub fn spawn(
    app: AppHandle,
    id: String,
    profile: &SessionProfile,
    mut rx: UnboundedReceiver<SessionCommand>,
) -> Result<()> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;

    let shell = profile.shell.clone().unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "EdgeTerm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if let Some(cwd) = profile.cwd.as_deref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    // The slave fd must be closed in the parent or the reader never sees EOF.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let mut writer = pair.master.take_writer().map_err(err)?;
    let master = pair.master;

    emit_state(&app, &id, "connected", Some(format!("shell {shell}")));

    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::Builder::new()
        .name(format!("edgeterm-pty-read-{id}"))
        .spawn(move || {
            let mut pump = OutputPump::new(reader_app.clone(), reader_id.clone());
            let mut buf = vec![0u8; 32 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pump.push(&buf[..n]);
                        // The next read blocks until more output arrives, so
                        // anything still buffered has to go out now.
                        pump.flush();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            pump.flush();
            emit_state(&reader_app, &reader_id, "closed", None);
        })
        .map_err(err)?;

    std::thread::Builder::new()
        .name(format!("edgeterm-pty-ctl-{id}"))
        .spawn(move || {
            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    SessionCommand::Write(data) => {
                        if writer.write_all(&data).is_err() || writer.flush().is_err() {
                            break;
                        }
                    }
                    SessionCommand::WriteConfirmed { data, reply } => {
                        let result = writer
                            .write_all(&data)
                            .and_then(|_| writer.flush())
                            .map_err(err);
                        let failed = result.is_err();
                        let _ = reply.send(result);
                        if failed {
                            break;
                        }
                    }
                    SessionCommand::Resize { cols, rows } => {
                        let _ = master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    SessionCommand::Close => {
                        let _ = child.kill();
                        break;
                    }
                    other => reject_sftp(other, SessionKind::Local),
                }
            }
            let _ = child.wait();
        })
        .map_err(err)?;

    Ok(())
}

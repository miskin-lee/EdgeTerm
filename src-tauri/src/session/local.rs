use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::{emit_state, reject_sftp, OutputPump, SessionCommand};
use crate::error::{err, Result};
use crate::model::{split_command_line, SessionKind, SessionProfile};

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

    // The Shell field is a command line, not just a program name, so a
    // profile can start `wsl.exe -d Ubuntu` or `pwsh -NoLogo`.
    let shell = profile.shell_command_line();
    let argv = split_command_line(&shell, cfg!(windows)).map_err(err)?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
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

    // Raised by the control thread before it kills the shell, so the reader
    // can tell a close the frontend asked for from the shell exiting on its
    // own; only the latter is reported back (see `emit_state`).
    let close_requested = Arc::new(AtomicBool::new(false));

    let reader_app = app.clone();
    let reader_id = id.clone();
    let reader_close_requested = close_requested.clone();
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
            if !reader_close_requested.load(Ordering::SeqCst) {
                emit_state(&reader_app, &reader_id, "closed", None);
            }
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
                        close_requested.store(true, Ordering::SeqCst);
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

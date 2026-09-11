use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::{cwd, emit_state, locale, reject_unsupported, OutputPump, SessionCommand};
use crate::error::{err, Result};
use crate::model::{split_command_line, SessionKind, SessionProfile};

/// Shells whose `-l` flag starts them as a login shell; see `login_flag`.
const LOGIN_SHELLS: &[&str] = &[
    "bash", "csh", "dash", "fish", "ksh", "nu", "pwsh", "sh", "tcsh", "xonsh", "zsh",
];

/// The flag that turns a bare `argv` into a login shell on macOS, or None
/// when the command line is to run as written.
///
/// A process the Dock or Finder starts inherits launchd's environment, whose
/// PATH is the four system directories and nothing else: no Homebrew, no
/// `/usr/local/bin`, none of what `/etc/paths.d` and `~/.zprofile` add,
/// because `/etc/zprofile` and `~/.zprofile` run for login shells only. A
/// `.zshrc` that expects `brew` or its tools on the PATH then fails line by
/// line (issue #28). Terminal.app, iTerm2 and VS Code all start the shell as
/// a login shell for this reason, so a bare shell gets `-l` here too. A
/// command line that carries arguments is the user's to run verbatim (`zsh
/// +l` opts out), and a program that is not a known shell is not guessed at.
/// Linux terminals conventionally start non-login shells and a desktop
/// session there already carries the user's environment, so nothing is
/// added off macOS.
fn login_flag(argv: &[String], macos: bool) -> Option<&'static str> {
    if !macos || argv.len() != 1 {
        return None;
    }
    let program = argv[0].rsplit('/').next().unwrap_or(&argv[0]);
    LOGIN_SHELLS.contains(&program).then_some("-l")
}

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
    let mut argv = split_command_line(&shell, cfg!(windows)).map_err(err)?;
    if let Some(flag) = login_flag(&argv, cfg!(target_os = "macos")) {
        argv.push(flag.to_string());
    }
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "EdgeTerm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // A GUI application's environment names no locale on macOS, and a shell
    // without one runs in the C locale, where `ls` shows a Chinese file
    // name as `???` (issue #39). See `locale` for what is set and when.
    if let Some(lang) = locale::local_shell_lang(profile) {
        cmd.env("LANG", lang);
    }
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
                    SessionCommand::QueryCwd { reply } => {
                        let _ = reply.send(cwd::local_shell_cwd(master.as_ref(), child.as_ref()));
                    }
                    SessionCommand::Close => {
                        close_requested.store(true, Ordering::SeqCst);
                        let _ = child.kill();
                        break;
                    }
                    other => reject_unsupported(other, SessionKind::Local),
                }
            }
            let _ = child.wait();
        })
        .map_err(err)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::login_flag;

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn a_bare_shell_becomes_a_login_shell_on_macos() {
        assert_eq!(login_flag(&argv(&["/bin/zsh"]), true), Some("-l"));
        assert_eq!(login_flag(&argv(&["zsh"]), true), Some("-l"));
        assert_eq!(
            login_flag(&argv(&["/opt/homebrew/bin/fish"]), true),
            Some("-l")
        );
        assert_eq!(
            login_flag(&argv(&["/usr/local/bin/pwsh"]), true),
            Some("-l")
        );
    }

    #[test]
    fn a_command_line_with_arguments_runs_as_written() {
        assert_eq!(login_flag(&argv(&["/bin/zsh", "+l"]), true), None);
        assert_eq!(login_flag(&argv(&["pwsh", "-NoLogo"]), true), None);
        assert_eq!(login_flag(&argv(&["/bin/zsh", "-l"]), true), None);
    }

    #[test]
    fn only_known_shells_and_only_on_macos() {
        assert_eq!(login_flag(&argv(&["/usr/bin/python3"]), true), None);
        assert_eq!(login_flag(&argv(&["/bin/zsh"]), false), None);
        assert_eq!(login_flag(&argv(&["wsl.exe"]), false), None);
    }
}

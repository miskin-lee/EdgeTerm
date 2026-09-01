use std::io::{Read, Write};
use std::sync::mpsc;

use async_channel::{Receiver, Sender};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};

use crate::model::split_command_line;

#[derive(Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Closed,
    Error(String),
}

enum PtyCommand {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Clone)]
pub struct PtyWriter {
    tx: mpsc::Sender<PtyCommand>,
}

impl PtyWriter {
    pub fn write(&self, bytes: impl Into<Vec<u8>>) {
        let _ = self.tx.send(PtyCommand::Write(bytes.into()));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.tx.send(PtyCommand::Resize { cols, rows });
    }
}

pub struct LocalPty {
    writer: PtyWriter,
}

impl LocalPty {
    #[cfg(test)]
    pub fn spawn(cols: u16, rows: u16) -> Result<(Self, Receiver<PtyEvent>), String> {
        Self::spawn_command(cols, rows, None, None)
    }

    pub fn spawn_command(
        cols: u16,
        rows: u16,
        command_line: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<(Self, Receiver<PtyEvent>), String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not open a local PTY: {error}"))?;

        let command_line = command_line
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(default_shell);
        let argv = split_command_line(&command_line, cfg!(windows))?;
        let program = argv
            .first()
            .ok_or_else(|| "shell command is empty".to_string())?;
        let mut command = CommandBuilder::new(program);
        command.args(argv.iter().skip(1));
        if let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
            command.cwd(expand_home(cwd));
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "EdgeTerm");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("could not start {command_line}: {error}"))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("could not read from the local PTY: {error}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("could not write to the local PTY: {error}"))?;
        let master = pair.master;

        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = async_channel::unbounded();

        spawn_reader(reader, event_tx.clone())?;
        std::thread::Builder::new()
            .name("edgeterm-gpui-pty-control".into())
            .spawn(move || {
                while let Ok(command) = command_rx.recv() {
                    match command {
                        PtyCommand::Write(bytes) => {
                            if let Err(error) =
                                writer.write_all(&bytes).and_then(|_| writer.flush())
                            {
                                let _ = event_tx.send_blocking(PtyEvent::Error(format!(
                                    "local shell write failed: {error}"
                                )));
                                break;
                            }
                        }
                        PtyCommand::Resize { cols, rows } => {
                            let _ = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        PtyCommand::Close => {
                            let _ = child.kill();
                            break;
                        }
                    }
                }
                let _ = child.wait();
            })
            .map_err(|error| format!("could not start the PTY control thread: {error}"))?;

        Ok((
            Self {
                writer: PtyWriter { tx: command_tx },
            },
            event_rx,
        ))
    }

    pub fn writer(&self) -> PtyWriter {
        self.writer.clone()
    }
}

fn expand_home(path: &str) -> std::path::PathBuf {
    if path == "~" {
        return home_dir().unwrap_or_else(|| path.into());
    }
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }
    path.into()
}

fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(Into::into)
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        let _ = self.writer.tx.send(PtyCommand::Close);
    }
}

fn spawn_reader(mut reader: Box<dyn Read + Send>, events: Sender<PtyEvent>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("edgeterm-gpui-pty-reader".into())
        .spawn(move || {
            let mut buffer = vec![0; 32 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if events
                            .send_blocking(PtyEvent::Output(buffer[..count].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = events.send_blocking(PtyEvent::Error(format!(
                            "local shell read failed: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = events.send_blocking(PtyEvent::Closed);
        })
        .map(|_| ())
        .map_err(|error| format!("could not start the PTY reader thread: {error}"))
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }

    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use async_channel::TryRecvError;

    use super::*;

    #[test]
    fn local_shell_round_trips_input_and_output() {
        let (pty, events) = LocalPty::spawn(80, 24).expect("local PTY should start");
        let writer = pty.writer();

        #[cfg(windows)]
        writer.write(b"echo EDGETERM_^PTY_OK\r\nexit\r\n".to_vec());
        #[cfg(not(windows))]
        writer.write(b"printf 'EDGETERM_%s\\n' 'PTY_OK'; exit\n".to_vec());

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match events.try_recv() {
                Ok(PtyEvent::Output(bytes)) => {
                    output.extend(bytes);
                    if output
                        .windows(b"EDGETERM_PTY_OK".len())
                        .any(|window| window == b"EDGETERM_PTY_OK")
                    {
                        return;
                    }
                }
                Ok(PtyEvent::Closed) => break,
                Ok(PtyEvent::Error(error)) => panic!("local PTY failed: {error}"),
                Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                Err(TryRecvError::Closed) => break,
            }
        }

        panic!(
            "local shell did not produce the sentinel; output was {:?}",
            String::from_utf8_lossy(&output)
        );
    }
}

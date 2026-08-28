//! The SSH server side: password auth, then a PTY running the local shell
//! for every session channel. This is the part EdgeTerm would embed; the
//! transport it runs on is whatever `transport` hands us.

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};

use crate::transport::BoxedStream;

/// Runs one SSH server session over `stream` until the peer goes away.
pub async fn serve_ssh(stream: BoxedStream, password: &str, peer: &str) -> Result<()> {
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        auth_rejection_time: Duration::from_secs(2),
        auth_rejection_time_initial: Some(Duration::from_secs(0)),
        // A real deployment persists this next to the transport identity so
        // the SSH host key is stable too; for the spike a fresh key per
        // session is fine (the client does not pin it).
        keys: vec![russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .context("generate host key")?],
        ..Default::default()
    });
    let handler = Handler {
        password: password.to_string(),
        peer: peer.to_string(),
        pty_size: PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        },
        term: "xterm-256color".into(),
        shell: None,
    };
    let session = server::run_stream(config, stream, handler)
        .await
        .context("ssh handshake")?;
    session.await.context("ssh session")?;
    eprintln!("[{peer}] disconnected");
    Ok(())
}

/// The shell behind one channel.
struct Shell {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Shell {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct Handler {
    password: String,
    peer: String,
    pty_size: PtySize,
    term: String,
    shell: Option<Shell>,
}

fn io_err(e: std::io::Error) -> russh::Error {
    russh::Error::IO(e)
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == self.password {
            eprintln!("[{}] authenticated as {user}", self.peer);
            Ok(Auth::Accept)
        } else {
            eprintln!("[{}] rejected password for {user}", self.peer);
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.term = term.to_string();
        self.pty_size = PtySize {
            rows: row_height as u16,
            cols: col_width as u16,
            pixel_width: pix_width as u16,
            pixel_height: pix_height as u16,
        };
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let pair = native_pty_system().openpty(self.pty_size).map_err(|e| {
            russh::Error::IO(std::io::Error::other(format!("openpty: {e}")))
        })?;
        let shell = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", &self.term);
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "EdgeTerm-p2p-term");
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            cmd.cwd(home);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| russh::Error::IO(std::io::Error::other(format!("spawn {shell}: {e}"))))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| {
            russh::Error::IO(std::io::Error::other(format!("pty reader: {e}")))
        })?;
        let writer = pair.master.take_writer().map_err(|e| {
            russh::Error::IO(std::io::Error::other(format!("pty writer: {e}")))
        })?;
        eprintln!("[{}] started {shell} ({}x{})", self.peer, self.pty_size.cols, self.pty_size.rows);

        // The pty crate is blocking, so the read loop lives on its own
        // thread and hops back onto the runtime for every SSH write.
        let handle = session.handle();
        let rt = tokio::runtime::Handle::current();
        let peer = self.peer.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{peer}"))
            .spawn(move || {
                let mut buf = vec![0u8; 32 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if rt
                                .block_on(handle.data(channel, buf[..n].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                eprintln!("[{peer}] shell exited");
                rt.block_on(async {
                    let _ = handle.exit_status_request(channel, 0).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                });
            })
            .map_err(io_err)?;

        self.shell = Some(Shell {
            master: pair.master,
            writer,
            child,
        });
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(shell) = self.shell.as_mut() {
            shell.writer.write_all(data).map_err(io_err)?;
            shell.writer.flush().map_err(io_err)?;
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(shell) = self.shell.as_ref() {
            let _ = shell.master.resize(PtySize {
                rows: row_height as u16,
                cols: col_width as u16,
                pixel_width: pix_width as u16,
                pixel_height: pix_height as u16,
            });
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // "No more input" is not "stop the shell": like sshd, keep the shell
        // running until it exits on its own or the channel closes.
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shell = None;
        Ok(())
    }
}

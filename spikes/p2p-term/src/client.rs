//! The SSH client side: authenticate, request a PTY + shell, then pump the
//! local terminal in and out. Stands in for EdgeTerm's `ssh.rs` + xterm.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, is_raw_mode_enabled};
use russh::{client, ChannelMsg, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::transport::BoxedStream;

struct Handler;

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Over iroh the peer is already authenticated by its EndpointId; over
        // TCP a real client would consult known_hosts here.
        eprintln!(
            "[ssh] server host key: {}",
            server_public_key.fingerprint(russh::keys::HashAlg::Sha256)
        );
        Ok(true)
    }
}

/// Restores the terminal even when the session ends with an error.
struct RawMode(bool);

impl RawMode {
    fn enable() -> Self {
        if !is_raw_mode_enabled().unwrap_or(false) && enable_raw_mode().is_ok() {
            RawMode(true)
        } else {
            RawMode(false)
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if self.0 {
            let _ = disable_raw_mode();
        }
    }
}

fn terminal_size() -> (u32, u32) {
    match crossterm::terminal::size() {
        Ok((cols, rows)) if cols > 0 && rows > 0 => (cols as u32, rows as u32),
        _ => (80, 24),
    }
}

pub async fn run(stream: BoxedStream, password: &str) -> Result<()> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let mut handle = client::connect_stream(config, stream, Handler)
        .await
        .context("ssh handshake")?;
    let auth = handle
        .authenticate_password("edgeterm", password)
        .await
        .context("authenticate")?;
    if !auth.success() {
        bail!("authentication failed (wrong password?)");
    }

    let mut channel = handle.channel_open_session().await?;
    let (cols, rows) = terminal_size();
    channel
        .request_pty(
            true,
            &std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".into()),
            cols,
            rows,
            0,
            0,
            &[],
        )
        .await?;
    channel.request_shell(true).await?;
    eprintln!("[ssh] shell open ({cols}x{rows}); exit the remote shell to disconnect\r");

    let _raw = RawMode::enable();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut buf = vec![0u8; 8 * 1024];
    let mut stdin_open = true;
    let mut last_size = (cols, rows);

    #[cfg(unix)]
    let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    #[cfg(not(unix))]
    let mut poll_size = tokio::time::interval(Duration::from_millis(500));

    let exit_code = loop {
        tokio::select! {
            read = stdin.read(&mut buf), if stdin_open => match read {
                Ok(0) => {
                    stdin_open = false;
                    channel.eof().await?;
                }
                Ok(n) => channel.data(&buf[..n]).await?,
                Err(e) => return Err(e.into()),
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    stdout.write_all(&data).await?;
                    stdout.flush().await?;
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    stdout.write_all(&data).await?;
                    stdout.flush().await?;
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => break Some(exit_status),
                Some(ChannelMsg::Close) | None => break None,
                Some(_) => {}
            },
            _ = resize_signal(
                #[cfg(unix)] &mut winch,
                #[cfg(not(unix))] &mut poll_size,
            ) => {
                let size = terminal_size();
                if size != last_size {
                    last_size = size;
                    channel.window_change(size.0, size.1, 0, 0).await?;
                }
            }
        }
    };

    drop(_raw);
    let _ = handle
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;
    match exit_code {
        Some(code) => eprintln!("\n[ssh] remote shell exited with status {code}"),
        None => eprintln!("\n[ssh] channel closed"),
    }
    Ok(())
}

#[cfg(unix)]
async fn resize_signal(winch: &mut tokio::signal::unix::Signal) {
    winch.recv().await;
}

#[cfg(not(unix))]
async fn resize_signal(interval: &mut tokio::time::Interval) {
    interval.tick().await;
}

//! Byte-stream transports the SSH layer runs on: iroh (feature `p2p`) or TCP.

use std::future::Future;
use std::pin::Pin;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncWrite};

/// One connected, bidirectional byte stream, whatever carried it.
pub type BoxedStream = Pin<Box<dyn Stream>>;

pub trait Stream: AsyncRead + AsyncWrite + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + 'static> Stream for T {}

/// Accepts TCP connections on `addr` and hands each to `handler`.
pub async fn serve_tcp<H, F>(addr: &str, handler: H) -> Result<()>
where
    H: Fn(BoxedStream, String) -> F + Clone + Send + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    eprintln!("[tcp] listening on {}", listener.local_addr()?);
    loop {
        let (socket, peer) = listener.accept().await?;
        socket.set_nodelay(true)?;
        let handler = handler.clone();
        tokio::spawn(handler(Box::pin(socket), peer.to_string()));
    }
}

/// Connects to `target`: an iroh EndpointId (with `p2p`), else `host:port`.
/// `relay` and `addrs` are optional hints for the iroh case: with them the
/// connection does not depend on the address lookup (DNS / pkarr) service.
pub async fn connect(target: &str, relay: Option<&str>, addrs: &[String]) -> Result<BoxedStream> {
    #[cfg(feature = "p2p")]
    if let Ok(id) = target.parse::<iroh::EndpointId>() {
        return p2p::connect(id, relay, addrs).await;
    }
    let _ = (relay, addrs);
    let socket = tokio::net::TcpStream::connect(target)
        .await
        .with_context(|| format!("connect {target}"))?;
    socket.set_nodelay(true)?;
    eprintln!("[tcp] connected to {}", socket.peer_addr()?);
    Ok(Box::pin(socket))
}

#[cfg(feature = "p2p")]
pub use p2p::serve as serve_p2p;

#[cfg(not(feature = "p2p"))]
pub async fn serve_p2p<H, F>(_key: &str, _handler: H) -> Result<()>
where
    H: Fn(BoxedStream, String) -> F + Clone + Send + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    anyhow::bail!("built without the `p2p` feature: pass --tcp ADDR")
}

#[cfg(feature = "p2p")]
mod p2p {
    use std::future::Future;
    use std::time::Duration;

    use anyhow::{Context, Result};
    use iroh::endpoint::{presets, Connection};
    use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};

    use super::BoxedStream;

    /// Both sides must agree on this; it is what makes an iroh connection
    /// "a p2p-term connection" rather than some other iroh protocol.
    const ALPN: &[u8] = b"edgeterm/p2p-term/0";

    /// Loads the server's identity from `path`, creating it on first run.
    /// The EndpointId (public key) derived from it is the server's address,
    /// so it has to survive restarts.
    fn load_or_create_key(path: &str) -> Result<SecretKey> {
        match std::fs::read_to_string(path) {
            Ok(text) => text
                .trim()
                .parse::<SecretKey>()
                .with_context(|| format!("parse secret key in {path}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = SecretKey::generate();
                let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
                std::fs::write(path, format!("{hex}\n"))
                    .with_context(|| format!("write secret key to {path}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                }
                eprintln!("[p2p] generated new identity in {path}");
                Ok(key)
            }
            Err(e) => Err(e).with_context(|| format!("read {path}")),
        }
    }

    pub async fn serve<H, F>(key_path: &str, handler: H) -> Result<()>
    where
        H: Fn(BoxedStream, String) -> F + Clone + Send + 'static,
        F: Future<Output = ()> + Send + 'static,
    {
        let secret = load_or_create_key(key_path)?;
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .context("bind iroh endpoint")?;
        eprintln!("[p2p] waiting for the home relay…");
        endpoint.online().await;
        let addr = endpoint.addr();
        eprintln!("[p2p] local addresses: {:?}", addr.addrs);
        println!("EndpointId: {}", endpoint.id());
        println!("(on the other machine: p2p-term connect {})", endpoint.id());

        while let Some(incoming) = endpoint.accept().await {
            let handler = handler.clone();
            tokio::spawn(async move {
                let from = format!("{:?}", incoming.remote_addr());
                let conn = match incoming.await {
                    Ok(conn) => conn,
                    Err(error) => {
                        eprintln!("[p2p] incoming connection from {from} failed: {error:#}");
                        return;
                    }
                };
                let peer = conn.remote_id().fmt_short().to_string();
                eprintln!("[p2p] connection from {peer}");
                report_paths(conn.clone(), false);
                // The client opens exactly one bidirectional stream and runs
                // SSH over it.
                match conn.accept_bi().await {
                    Ok((send, recv)) => handler(Box::pin(tokio::io::join(recv, send)), peer).await,
                    Err(error) => eprintln!("[p2p] accept_bi from {peer} failed: {error:#}"),
                }
                conn.close(0u32.into(), b"done");
            });
        }
        Ok(())
    }

    /// The client's endpoint. Dropping the last `Endpoint` handle shuts the
    /// QUIC driver down and every connection with it, so it must outlive
    /// the stream we hand back; a process-wide slot is the simplest owner
    /// for a one-connection tool.
    static CLIENT_ENDPOINT: std::sync::OnceLock<Endpoint> = std::sync::OnceLock::new();

    pub async fn connect(
        id: EndpointId,
        relay: Option<&str>,
        addrs: &[String],
    ) -> Result<BoxedStream> {
        // The client does not need a stable identity; a fresh key per run.
        let endpoint = Endpoint::bind(presets::N0)
            .await
            .context("bind iroh endpoint")?;
        let endpoint = CLIENT_ENDPOINT.get_or_init(|| endpoint);

        let mut target = EndpointAddr::new(id);
        if let Some(relay) = relay {
            target = target.with_relay_url(relay.parse().context("parse --relay URL")?);
        }
        for addr in addrs {
            target = target.with_ip_addr(addr.parse().context("parse --addr IP:PORT")?);
        }
        eprintln!(
            "[p2p] connecting to {}{}…",
            id.fmt_short(),
            if target.is_empty() { " (via address lookup)" } else { " (with given addresses)" }
        );
        let started = std::time::Instant::now();
        let conn = endpoint
            .connect(target, ALPN)
            .await
            .context("iroh connect")?;
        eprintln!("[p2p] connected in {:?}", started.elapsed());
        report_paths(conn.clone(), true);
        let (send, recv) = conn.open_bi().await.context("open_bi")?;
        Ok(Box::pin(tokio::io::join(recv, send)))
    }

    /// Prints the selected network path (direct vs relay) whenever it
    /// changes, so a tester can see hole punching succeed — or not.
    /// `raw_terminal` picks `\r\n` line endings for a terminal in raw mode.
    fn report_paths(conn: Connection, raw_terminal: bool) {
        tokio::spawn(async move {
            let nl = if raw_terminal { "\r\n" } else { "\n" };
            let mut last = String::new();
            loop {
                let mut current = String::new();
                for path in conn.paths().iter() {
                    let kind = if path.is_relay() { "relay" } else { "direct" };
                    let selected = if path.is_selected() { "*" } else { " " };
                    current.push_str(&format!(
                        "{selected} {kind:6} {:?} rtt={:?}; ",
                        path.remote_addr(),
                        path.rtt()
                    ));
                }
                if current != last {
                    eprint!("[p2p] paths: {current}{nl}");
                    last = current;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    _ = conn.closed() => break,
                }
            }
        });
    }
}

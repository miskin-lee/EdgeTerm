//! p2p-term: spike for "EdgeTerm as a terminal server reachable across NATs".
//!
//! Two roles, one binary:
//!
//! ```text
//! p2p-term serve   [--password PW] [--key PATH] [--tcp ADDR]
//! p2p-term connect <ENDPOINT_ID | host:port> [--password PW] [--relay URL] [--addr IP:PORT]...
//! ```
//!
//! The wire protocol is plain SSH (russh), so the server side is the same
//! code EdgeTerm would embed. What differs is the transport underneath:
//! with the `p2p` feature the SSH byte stream rides on an iroh QUIC
//! connection (hole punching + relay fallback, addressed by public key);
//! without it — or with `--tcp` / a `host:port` target — it is a TCP socket.

mod client;
mod server;
mod transport;

use anyhow::{bail, Context, Result};

const DEFAULT_PASSWORD: &str = "edgeterm";

fn usage() -> ! {
    eprintln!(
        "usage:\n  p2p-term serve   [--password PW] [--key PATH] [--tcp ADDR]\n  p2p-term connect <ENDPOINT_ID | host:port> [--password PW] [--relay URL] [--addr IP:PORT]..."
    );
    std::process::exit(2)
}

struct Args {
    command: String,
    positional: Vec<String>,
    password: String,
    key: String,
    tcp: Option<String>,
    relay: Option<String>,
    addrs: Vec<String>,
}

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    let Some(command) = it.next() else { usage() };
    let mut args = Args {
        command,
        positional: Vec::new(),
        password: std::env::var("P2P_TERM_PASSWORD").unwrap_or_else(|_| DEFAULT_PASSWORD.into()),
        key: "p2p-term.key".into(),
        tcp: None,
        relay: None,
        addrs: Vec::new(),
    };
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--password" => args.password = it.next().unwrap_or_else(|| usage()),
            "--key" => args.key = it.next().unwrap_or_else(|| usage()),
            "--tcp" => args.tcp = Some(it.next().unwrap_or_else(|| usage())),
            "--relay" => args.relay = Some(it.next().unwrap_or_else(|| usage())),
            "--addr" => args.addrs.push(it.next().unwrap_or_else(|| usage())),
            "-h" | "--help" => usage(),
            other if other.starts_with("--") => usage(),
            other => args.positional.push(other.to_string()),
        }
    }
    args
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args();
    match args.command.as_str() {
        "serve" => {
            let password = args.password.clone();
            let handler = move |stream: transport::BoxedStream, peer: String| {
                let password = password.clone();
                async move {
                    if let Err(error) = server::serve_ssh(stream, &password, &peer).await {
                        eprintln!("[{peer}] session ended with error: {error:#}");
                    }
                }
            };
            match args.tcp {
                Some(addr) => transport::serve_tcp(&addr, handler).await,
                None => transport::serve_p2p(&args.key, handler).await,
            }
        }
        "connect" => {
            let target = args
                .positional
                .first()
                .context("connect needs a target: an iroh EndpointId or host:port")?;
            let stream = transport::connect(target, args.relay.as_deref(), &args.addrs).await?;
            client::run(stream, &args.password).await
        }
        _ => bail!("unknown command {:?}", args.command),
    }
}

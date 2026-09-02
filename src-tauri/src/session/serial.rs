use std::io::{Read, Write};
use std::thread::JoinHandle;
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use tauri::AppHandle;
use tokio::sync::mpsc::{error::TryRecvError, UnboundedReceiver};

use super::{emit_state, reject_unsupported, OutputPump, SessionCommand};
use crate::error::{err, AppError, Result};
use crate::model::{SerialPortDesc, SessionKind, SessionProfile};

pub fn list_ports() -> Result<Vec<SerialPortDesc>> {
    let ports = serialport::available_ports()?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (kind, description) = match &p.port_type {
                SerialPortType::UsbPort(info) => (
                    "usb",
                    Some(
                        format!(
                            "{} {}",
                            info.manufacturer.clone().unwrap_or_default(),
                            info.product.clone().unwrap_or_default()
                        )
                        .trim()
                        .to_string(),
                    ),
                ),
                SerialPortType::BluetoothPort => ("bluetooth", None),
                SerialPortType::PciPort => ("pci", None),
                SerialPortType::Unknown => ("unknown", None),
            };
            SerialPortDesc {
                port_name: p.port_name,
                port_type: kind.to_string(),
                description: description.filter(|d| !d.is_empty()),
            }
        })
        .collect())
}

pub fn spawn(
    app: AppHandle,
    id: String,
    profile: &SessionProfile,
    rx: UnboundedReceiver<SessionCommand>,
) -> Result<JoinHandle<()>> {
    let port_name = profile
        .port_name
        .clone()
        .ok_or_else(|| AppError::new("serial session is missing a port name"))?;
    let baud = profile.baud_rate.unwrap_or(115_200);

    let data_bits = match profile.data_bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let stop_bits = match profile.stop_bits.unwrap_or(1) {
        2 => StopBits::Two,
        _ => StopBits::One,
    };
    let parity = match profile.parity.as_deref().unwrap_or("none") {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let flow_control = match profile.flow_control.as_deref().unwrap_or("none") {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    };

    let port = serialport::new(&port_name, baud)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(flow_control)
        // The owner loop only sees the command channel between reads, so
        // this bounds how long a queued write waits before it goes out. For
        // typing 50 ms went unnoticed, but XMODEM is stop-and-wait: the peer
        // sends nothing until our block or ACK arrives, so that latency was
        // paid once per block and dominated the transfer rate. The idle cost
        // is one poll wake-up per timeout.
        .timeout(Duration::from_millis(10))
        .open()
        .map_err(|e| AppError::new(format!("cannot open {port_name}: {e}")))?;

    emit_state(
        &app,
        &id,
        "connected",
        Some(format!("{port_name} @ {baud}")),
    );

    std::thread::Builder::new()
        .name(format!("edgeterm-serial-{id}"))
        .spawn(move || {
            let mut pump = OutputPump::new(app.clone(), id.clone());
            let close_requested = run_owner_loop(port, rx, |bytes| {
                pump.push(bytes);
                pump.flush();
            });
            pump.flush();
            // A close the frontend asked for is not reported back; see
            // `emit_state`.
            if !close_requested {
                emit_state(&app, &id, "closed", None);
            }
        })
        .map_err(err)
}

/// Owns the serial handle for its entire lifetime. In particular, do not clone
/// the handle for a separate reader: dropping only the writer would leave the
/// cloned descriptor open and keep the device busy forever.
///
/// Returns `true` when the loop ended because a close was requested (a Close
/// command, or the command channel going away with the session manager) and
/// `false` when the port itself failed.
fn run_owner_loop<P, F>(
    mut port: P,
    mut rx: UnboundedReceiver<SessionCommand>,
    mut on_output: F,
) -> bool
where
    P: Read + Write,
    F: FnMut(&[u8]),
{
    let mut buf = vec![0u8; 8192];
    loop {
        match rx.try_recv() {
            Ok(SessionCommand::Write(data)) => {
                if port.write_all(&data).is_err() || port.flush().is_err() {
                    return false;
                }
            }
            Ok(SessionCommand::WriteConfirmed { data, reply }) => {
                let result = port
                    .write_all(&data)
                    .and_then(|_| port.flush())
                    .map_err(err);
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    return false;
                }
            }
            // A serial line has no window to resize.
            Ok(SessionCommand::Resize { .. }) => {}
            Ok(SessionCommand::Close) | Err(TryRecvError::Disconnected) => return true,
            Ok(other) => reject_unsupported(other, SessionKind::Serial),
            Err(TryRecvError::Empty) => {}
        }

        match port.read(&mut buf) {
            Ok(0) => std::thread::sleep(Duration::from_millis(10)),
            Ok(n) => on_output(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // A read timeout is the idle case and also bounds how long a
                // queued close command has to wait before it can be handled.
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };

    use super::*;

    struct MockPort {
        dropped: Arc<AtomicBool>,
        read_started: Option<mpsc::Sender<()>>,
    }

    impl Read for MockPort {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            if let Some(started) = self.read_started.take() {
                let _ = started.send(());
            }
            std::thread::sleep(Duration::from_millis(10));
            Err(io::Error::new(io::ErrorKind::TimedOut, "idle"))
        }
    }

    impl Write for MockPort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for MockPort {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn close_releases_the_owned_serial_handle() {
        let dropped = Arc::new(AtomicBool::new(false));
        let (read_started_tx, read_started_rx) = mpsc::channel();
        let port = MockPort {
            dropped: dropped.clone(),
            read_started: Some(read_started_tx),
        };
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();

        let owner = std::thread::spawn(move || run_owner_loop(port, command_rx, |_| {}));
        read_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("owner should start reading");
        let (write_reply, write_response) = tokio::sync::oneshot::channel();
        command_tx
            .send(SessionCommand::WriteConfirmed {
                data: vec![0, 1, 2, 3],
                reply: write_reply,
            })
            .unwrap();
        write_response
            .blocking_recv()
            .expect("owner should acknowledge the write")
            .expect("mock write should succeed");
        command_tx.send(SessionCommand::Close).unwrap();
        let close_requested = owner.join().unwrap();

        assert!(close_requested);
        assert!(dropped.load(Ordering::SeqCst));
    }
}

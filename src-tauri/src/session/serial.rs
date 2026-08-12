use std::io::{Read, Write};
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::{emit_state, reject_sftp, OutputPump, SessionCommand};
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
    mut rx: UnboundedReceiver<SessionCommand>,
) -> Result<()> {
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
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| AppError::new(format!("cannot open {port_name}: {e}")))?;

    let mut reader = port.try_clone().map_err(err)?;
    let mut writer = port;

    emit_state(
        &app,
        &id,
        "connected",
        Some(format!("{port_name} @ {baud}")),
    );

    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::Builder::new()
        .name(format!("edgeterm-serial-read-{id}"))
        .spawn(move || {
            let mut pump = OutputPump::new(reader_app.clone(), reader_id.clone());
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        pump.flush();
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Ok(n) => {
                        pump.push(&buf[..n]);
                        pump.flush();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        // A read timeout is the idle case, not a failure.
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
        .name(format!("edgeterm-serial-ctl-{id}"))
        .spawn(move || {
            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    SessionCommand::Write(data) => {
                        if writer.write_all(&data).is_err() || writer.flush().is_err() {
                            break;
                        }
                    }
                    // A serial line has no window to resize.
                    SessionCommand::Resize { .. } => {}
                    SessionCommand::Close => break,
                    other => reject_sftp(other, SessionKind::Serial),
                }
            }
        })
        .map_err(err)?;

    Ok(())
}

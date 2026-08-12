import { useEffect, useState } from "react";

import { openSession } from "../actions";
import * as api from "../api";
import { useStore } from "../store";
import type { SerialPortDesc, SessionKind, SessionProfile } from "../types";

interface Props {
  initial: SessionProfile | null;
  onClose: () => void;
}

const BLANK: SessionProfile = {
  id: "",
  name: "",
  kind: "ssh",
  port: 22,
  auth: "password",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

const RAW_TEXT_INPUT = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

const COMMON_BAUD_RATES = [
  1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400,
  460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
  4000000,
];

function validateProfile(profile: SessionProfile): string | null {
  if (profile.kind !== "serial") return null;

  const baudRate = profile.baudRate;
  if (
    baudRate == null ||
    !Number.isInteger(baudRate) ||
    baudRate <= 0 ||
    baudRate > 0xffffffff
  ) {
    return "Baud rate must be a positive whole number up to 4294967295.";
  }
  return null;
}

export function SessionDialog({ initial, onClose }: Props) {
  const [profile, setProfile] = useState<SessionProfile>(initial ?? BLANK);
  const [ports, setPorts] = useState<SerialPortDesc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upsertProfile = useStore((s) => s.upsertProfile);

  useEffect(() => {
    if (profile.kind !== "serial") return;
    api.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, [profile.kind]);

  const patch = (fields: Partial<SessionProfile>) =>
    setProfile((prev) => ({ ...prev, ...fields }));

  const defaultName = () => {
    if (profile.kind === "ssh") return profile.host ?? "ssh";
    if (profile.kind === "serial") return profile.portName ?? "serial";
    return "shell";
  };

  const normalized = (): SessionProfile => ({
    ...profile,
    name: profile.name.trim() || defaultName(),
  });

  const save = async () => {
    const candidate = normalized();
    const validationError = validateProfile(candidate);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await upsertProfile(candidate);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const candidate = normalized();
    const validationError = validateProfile(candidate);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Saving first keeps the profile in the tree and stores its credentials
      // in the operating system's secure credential vault.
      const saved = candidate.name ? await upsertProfile(candidate) : candidate;
      const id = await openSession({
        ...saved,
        password: candidate.password,
        passphrase: candidate.passphrase,
      });
      if (id) onClose();
      else setError(useStore.getState().error ?? "connection failed");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedPort = ports.find(
    (port) => port.portName === profile.portName,
  );
  const parityCode =
    profile.parity === "odd" ? "O" : profile.parity === "even" ? "E" : "N";

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <div id="session-dialog-title" className="session-dialog-title">
              {initial?.id ? "Edit Session" : "New Session"}
            </div>
          </div>
          <button className="panel-action" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-body session-dialog-body">
          <section className="session-section">
            <div className="session-section-heading">
              <span>Session</span>
              <small>Identity and protocol</small>
            </div>
            <div className="session-form-grid">
              <div className="session-field is-wide">
                <span className="session-field-label">Protocol</span>
                <div className="kind-picker">
                  {(["ssh", "local", "serial"] as SessionKind[]).map((kind) => (
                    <button
                      key={kind}
                      className={`kind-option${profile.kind === kind ? " is-active" : ""}`}
                      onClick={() =>
                        patch({
                          kind,
                          port:
                            kind === "ssh" ? (profile.port ?? 22) : profile.port,
                        })
                      }
                    >
                      {kind === "ssh"
                        ? "SSH"
                        : kind === "local"
                          ? "Shell"
                          : "Serial"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="session-field">
                <span className="session-field-label">Name</span>
                <input
                  {...RAW_TEXT_INPUT}
                  value={profile.name}
                  placeholder={defaultName()}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>

              <label className="session-field">
                <span className="session-field-label">Group</span>
                <input
                  {...RAW_TEXT_INPUT}
                  value={profile.group ?? ""}
                  placeholder="Sessions"
                  onChange={(event) => patch({ group: event.target.value })}
                />
              </label>
            </div>
          </section>

          {profile.kind === "ssh" && (
            <section className="session-section">
              <div className="session-section-heading">
                <span>SSH connection</span>
                <small>Server and authentication</small>
              </div>
              <div className="session-form-grid">
                <label className="session-field">
                  <span className="session-field-label">Host</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.host ?? ""}
                    placeholder="example.com"
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">Port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={profile.port ?? 22}
                    onChange={(event) =>
                      patch({ port: Number(event.target.value) || 22 })
                    }
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">Username</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.username ?? ""}
                    placeholder="user"
                    onChange={(event) => patch({ username: event.target.value })}
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">Authentication</span>
                  <select
                    value={profile.auth ?? "password"}
                    onChange={(event) =>
                      patch({
                        auth: event.target.value as SessionProfile["auth"],
                      })
                    }
                  >
                    <option value="password">Password</option>
                    <option value="publicKey">Public key</option>
                    <option value="agent">SSH agent</option>
                  </select>
                </label>

                {profile.auth === "password" && (
                  <label className="session-field is-wide">
                    <span className="session-field-label">Password</span>
                    <input
                      {...RAW_TEXT_INPUT}
                      type="password"
                      value={profile.password ?? ""}
                      onChange={(event) =>
                        patch({ password: event.target.value })
                      }
                    />
                  </label>
                )}

                {profile.auth === "publicKey" && (
                  <>
                    <label className="session-field is-wide">
                      <span className="session-field-label">Private key</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        value={profile.privateKeyPath ?? ""}
                        placeholder="~/.ssh/id_ed25519"
                        onChange={(event) =>
                          patch({ privateKeyPath: event.target.value })
                        }
                      />
                    </label>
                    <label className="session-field is-wide">
                      <span className="session-field-label">Passphrase</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        type="password"
                        value={profile.passphrase ?? ""}
                        onChange={(event) =>
                          patch({ passphrase: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            </section>
          )}

          {profile.kind === "local" && (
            <section className="session-section">
              <div className="session-section-heading">
                <span>Local shell</span>
                <small>Process and working directory</small>
              </div>
              <div className="session-form-grid">
                <label className="session-field is-wide">
                  <span className="session-field-label">Shell</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.shell ?? ""}
                    placeholder="$SHELL"
                    onChange={(event) => patch({ shell: event.target.value })}
                  />
                </label>
                <label className="session-field is-wide">
                  <span className="session-field-label">Directory</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.cwd ?? ""}
                    placeholder="Home directory"
                    onChange={(event) => patch({ cwd: event.target.value })}
                  />
                </label>
              </div>
            </section>
          )}

          {profile.kind === "serial" && (
            <section className="session-section">
              <div className="session-section-heading">
                <span>Serial connection</span>
                <small>
                  {profile.dataBits ?? 8}-{parityCode}-{profile.stopBits ?? 1}
                  {profile.flowControl && profile.flowControl !== "none"
                    ? ` · ${profile.flowControl} flow`
                    : " · no flow control"}
                </small>
              </div>
              <div className="session-form-grid">
                <div className="session-field is-wide">
                  <span className="session-field-label">Port</span>
                  <div className="serial-port-row">
                    <select
                      value={profile.portName ?? ""}
                      onChange={(event) =>
                        patch({ portName: event.target.value })
                      }
                    >
                      <option value="">Select a port…</option>
                      {ports.map((port) => (
                        <option key={port.portName} value={port.portName}>
                          {port.portName}
                          {port.description ? ` — ${port.description}` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn serial-refresh"
                      onClick={() =>
                        api
                          .listSerialPorts()
                          .then(setPorts)
                          .catch(() => undefined)
                      }
                      title="Refresh serial ports"
                      aria-label="Refresh serial ports"
                    >
                      <span aria-hidden="true">⟳</span>
                    </button>
                  </div>
                  <small className="session-field-hint">
                    {selectedPort?.description ||
                      (ports.length
                        ? "Choose a detected COM or TTY device."
                        : "No serial ports detected. Refresh to scan again.")}
                  </small>
                </div>

                <div className="session-field is-wide">
                  <label
                    className="session-field-label"
                    htmlFor="serial-baud-rate"
                  >
                    Baud rate
                  </label>
                  <div className="input-with-suffix">
                    <input
                      id="serial-baud-rate"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={0xffffffff}
                      step={1}
                      list="serial-baud-rates"
                      value={profile.baudRate ?? ""}
                      placeholder="115200"
                      onChange={(event) =>
                        patch({
                          baudRate:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                    />
                    <span>baud</span>
                  </div>
                  <datalist id="serial-baud-rates">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <option key={rate} value={rate} />
                    ))}
                  </datalist>
                  <small className="session-field-hint">
                    Select a common value or enter any custom positive integer.
                  </small>
                </div>

                <label className="session-field">
                  <span className="session-field-label">Data bits</span>
                  <select
                    value={profile.dataBits ?? 8}
                    onChange={(event) =>
                      patch({ dataBits: Number(event.target.value) })
                    }
                  >
                    {[5, 6, 7, 8].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits} bits
                      </option>
                    ))}
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">Stop bits</span>
                  <select
                    value={profile.stopBits ?? 1}
                    onChange={(event) =>
                      patch({ stopBits: Number(event.target.value) })
                    }
                  >
                    <option value={1}>1 bit</option>
                    <option value={2}>2 bits</option>
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">Parity</span>
                  <select
                    value={profile.parity ?? "none"}
                    onChange={(event) => patch({ parity: event.target.value })}
                  >
                    <option value="none">None (N)</option>
                    <option value="odd">Odd (O)</option>
                    <option value="even">Even (E)</option>
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">Flow control</span>
                  <select
                    value={profile.flowControl ?? "none"}
                    onChange={(event) =>
                      patch({ flowControl: event.target.value })
                    }
                  >
                    <option value="none">None</option>
                    <option value="software">XON/XOFF (software)</option>
                    <option value="hardware">RTS/CTS (hardware)</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={save} disabled={busy}>
            Save
          </button>
          <button className="btn is-primary" onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

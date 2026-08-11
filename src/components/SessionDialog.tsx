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
    setBusy(true);
    try {
      await upsertProfile(normalized());
      setError(null);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const candidate = normalized();
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

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <span>{initial?.id ? "Edit Session" : "New Session"}</span>
          <button className="panel-action" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label>Protocol</label>
            <div className="kind-picker">
              {(["ssh", "local", "serial"] as SessionKind[]).map((kind) => (
                <button
                  key={kind}
                  className={`kind-option${profile.kind === kind ? " is-active" : ""}`}
                  onClick={() =>
                    patch({ kind, port: kind === "ssh" ? (profile.port ?? 22) : profile.port })
                  }
                >
                  {kind === "ssh" ? "SSH" : kind === "local" ? "Shell" : "Serial"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Name</label>
            <input
              {...RAW_TEXT_INPUT}
              value={profile.name}
              placeholder={defaultName()}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </div>

          <div className="field">
            <label>Group</label>
            <input
              {...RAW_TEXT_INPUT}
              value={profile.group ?? ""}
              placeholder="Sessions"
              onChange={(event) => patch({ group: event.target.value })}
            />
          </div>

          {profile.kind === "ssh" && (
            <>
              <div className="field">
                <label>Host</label>
                <div className="field-row">
                  <input
                    {...RAW_TEXT_INPUT}
                    style={{ flex: 1 }}
                    value={profile.host ?? ""}
                    placeholder="example.com"
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                  <input
                    style={{ width: 76 }}
                    type="number"
                    value={profile.port ?? 22}
                    onChange={(event) =>
                      patch({ port: Number(event.target.value) || 22 })
                    }
                  />
                </div>
              </div>

              <div className="field">
                <label>Username</label>
                <input
                  {...RAW_TEXT_INPUT}
                  value={profile.username ?? ""}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </div>

              <div className="field">
                <label>Authentication</label>
                <select
                  value={profile.auth ?? "password"}
                  onChange={(event) =>
                    patch({ auth: event.target.value as SessionProfile["auth"] })
                  }
                >
                  <option value="password">Password</option>
                  <option value="publicKey">Public key</option>
                  <option value="agent">SSH agent</option>
                </select>
              </div>

              {profile.auth === "password" && (
                <div className="field">
                  <label>Password</label>
                  <input
                    {...RAW_TEXT_INPUT}
                    type="password"
                    value={profile.password ?? ""}
                    onChange={(event) => patch({ password: event.target.value })}
                  />
                </div>
              )}

              {profile.auth === "publicKey" && (
                <>
                  <div className="field">
                    <label>Private key</label>
                    <input
                      {...RAW_TEXT_INPUT}
                      value={profile.privateKeyPath ?? ""}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(event) =>
                        patch({ privateKeyPath: event.target.value })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Passphrase</label>
                    <input
                      {...RAW_TEXT_INPUT}
                      type="password"
                      value={profile.passphrase ?? ""}
                      onChange={(event) =>
                        patch({ passphrase: event.target.value })
                      }
                    />
                  </div>
                </>
              )}
            </>
          )}

          {profile.kind === "local" && (
            <>
              <div className="field">
                <label>Shell</label>
                <input
                  {...RAW_TEXT_INPUT}
                  value={profile.shell ?? ""}
                  placeholder="$SHELL"
                  onChange={(event) => patch({ shell: event.target.value })}
                />
              </div>
              <div className="field">
                <label>Directory</label>
                <input
                  {...RAW_TEXT_INPUT}
                  value={profile.cwd ?? ""}
                  placeholder="home directory"
                  onChange={(event) => patch({ cwd: event.target.value })}
                />
              </div>
            </>
          )}

          {profile.kind === "serial" && (
            <>
              <div className="field">
                <label>Port</label>
                <div className="field-row">
                  <select
                    style={{ flex: 1 }}
                    value={profile.portName ?? ""}
                    onChange={(event) => patch({ portName: event.target.value })}
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
                    className="btn"
                    onClick={() =>
                      api.listSerialPorts().then(setPorts).catch(() => undefined)
                    }
                  >
                    ⟳
                  </button>
                </div>
              </div>

              <div className="field">
                <label>Baud rate</label>
                <select
                  value={profile.baudRate ?? 115200}
                  onChange={(event) =>
                    patch({ baudRate: Number(event.target.value) })
                  }
                >
                  {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(
                    (rate) => (
                      <option key={rate} value={rate}>
                        {rate}
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div className="field">
                <label>Framing</label>
                <div className="field-row">
                  <select
                    value={profile.dataBits ?? 8}
                    onChange={(event) =>
                      patch({ dataBits: Number(event.target.value) })
                    }
                  >
                    {[5, 6, 7, 8].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits} data
                      </option>
                    ))}
                  </select>
                  <select
                    value={profile.parity ?? "none"}
                    onChange={(event) => patch({ parity: event.target.value })}
                  >
                    <option value="none">no parity</option>
                    <option value="odd">odd</option>
                    <option value="even">even</option>
                  </select>
                  <select
                    value={profile.stopBits ?? 1}
                    onChange={(event) =>
                      patch({ stopBits: Number(event.target.value) })
                    }
                  >
                    <option value={1}>1 stop</option>
                    <option value={2}>2 stop</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Flow control</label>
                <select
                  value={profile.flowControl ?? "none"}
                  onChange={(event) => patch({ flowControl: event.target.value })}
                >
                  <option value="none">None</option>
                  <option value="software">XON/XOFF</option>
                  <option value="hardware">RTS/CTS</option>
                </select>
              </div>
            </>
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

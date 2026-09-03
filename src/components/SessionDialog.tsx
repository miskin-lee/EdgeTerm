import { useEffect, useRef, useState, type CSSProperties } from "react";

import { openSession } from "../actions";
import * as api from "../api";
import { IS_WINDOWS } from "../platform";
import {
  flattenGroups,
  groupCategory,
  groupPath,
  sectionLabel,
} from "../sessionGroups";
import { useStore } from "../store";
import {
  endDialogAttention,
  requestDialogAttention,
} from "./dialogAttention";
import { useDialogDrag } from "./useDialogDrag";
import {
  colorForSession,
  isSshTransport,
  randomSessionColor,
  SESSION_COLORS,
  type SerialPortDesc,
  type SessionKind,
  type SessionProfile,
} from "../types";
import { Icon, type IconName } from "./icons";

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

const defaultPort = (kind: SessionKind, current?: number | null) =>
  kind === "ssh" || kind === "sftp"
    ? (current ?? 22)
    : kind === "ftp"
      ? (current ?? 21)
      : current;

/**
 * Protocol picker entries. FTP and SFTP share one "(S)FTP" choice, mirroring
 * the Session panel's merged section; a sub-toggle inside the connection
 * section picks the actual protocol. `kinds[0]` is the default when the choice
 * is selected fresh — SFTP, since it is the encrypted one. The icon and the
 * one-word hint are what the picker cards show under the name.
 */
const PROTOCOL_OPTIONS: {
  label: string;
  hint: string;
  icon: IconName;
  kinds: SessionKind[];
}[] = [
  { label: "SSH", hint: "Remote shell", icon: "server", kinds: ["ssh"] },
  {
    label: "(S)FTP",
    hint: "File transfer",
    icon: "folder",
    kinds: ["sftp", "ftp"],
  },
  { label: "Shell", hint: "Local shell", icon: "terminal", kinds: ["local"] },
  {
    label: "Serial",
    hint: "Device port",
    icon: "circuit-board",
    kinds: ["serial"],
  },
];

/** The picker icon of the choice a kind belongs to; also the dialog's badge. */
const protocolIcon = (kind: SessionKind): IconName =>
  PROTOCOL_OPTIONS.find((option) => option.kinds.includes(kind))?.icon ??
  "server";

/** How a kind is named in the header line, where the protocol is spelled out. */
const PROTOCOL_NAMES: Record<SessionKind, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  local: "Shell",
  serial: "Serial",
};

/** Column count of `.session-color-picker`; keep in sync with styles.css. */
const COLOR_PICKER_COLUMNS = 8;

const COMMON_BAUD_RATES = [
  1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400,
  460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
  4000000,
];

/**
 * Saved SSH transports `profile` may be tunnelled through: every SSH / SFTP
 * profile except itself and those whose own jump chain already leads back to
 * it, which would loop. Mirrors the cycle check in the backend's
 * `Store::save`, so the menu never offers a choice that save would refuse.
 */
function jumpHostChoices(
  profile: SessionProfile,
  profiles: SessionProfile[],
): SessionProfile[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const leadsBackHere = (candidate: SessionProfile): boolean => {
    const seen = new Set<string>();
    let current: SessionProfile | undefined = candidate;
    while (current) {
      if (current.id === profile.id) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.jumpProfileId
        ? byId.get(current.jumpProfileId)
        : undefined;
    }
    return false;
  };
  return profiles.filter(
    (p) =>
      p.id &&
      p.id !== profile.id &&
      isSshTransport(p.kind) &&
      !(profile.id && leadsBackHere(p)),
  );
}

const describeJumpHost = (p: SessionProfile) =>
  `${p.name} — ${p.username ?? ""}@${p.host ?? ""}:${p.port ?? 22}`;

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

function nextColorIndex(
  key: string,
  current: number,
  count: number,
  columns: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "ArrowDown":
      return current + columns < count ? current + columns : current % columns;
    case "ArrowUp": {
      if (current - columns >= 0) return current - columns;
      const lastRowStart = Math.floor((count - 1) / columns) * columns;
      const target = lastRowStart + (current % columns);
      return target < count ? target : target - columns;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function SessionDialog({ initial, onClose }: Props) {
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const { dialogRef, handleProps: dragHandleProps } =
    useDialogDrag<HTMLDivElement>();
  const [profile, setProfile] = useState<SessionProfile>(() =>
    initial
      ? {
          ...initial,
          color:
            initial.color ?? colorForSession(initial.id || initial.name),
        }
      : { ...BLANK, color: randomSessionColor() },
  );
  const [ports, setPorts] = useState<SerialPortDesc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upsertProfile = useStore((s) => s.upsertProfile);
  const groups = useStore((s) => s.groups);
  const profiles = useStore((s) => s.profiles);
  const groupChoices = flattenGroups(groups, profile.kind);
  const jumpChoices = jumpHostChoices(profile, profiles);
  // The chosen jump session was deleted (or now loops back here): keep it
  // visible so the user sees what is wrong; saving drops it.
  const jumpHostMissing =
    !!profile.jumpProfileId &&
    !jumpChoices.some((p) => p.id === profile.jumpProfileId);

  useEffect(() => {
    if (profile.kind !== "serial") return;
    api.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, [profile.kind]);

  const patch = (fields: Partial<SessionProfile>) =>
    setProfile((prev) => ({ ...prev, ...fields }));

  const defaultName = () => {
    if (profile.kind === "ssh") return profile.host ?? "ssh";
    if (profile.kind === "sftp") return profile.host ?? "sftp";
    if (profile.kind === "ftp") return profile.host ?? "ftp";
    if (profile.kind === "serial") return profile.portName ?? "serial";
    return "shell";
  };

  const normalized = (): SessionProfile => ({
    ...profile,
    name: profile.name.trim() || defaultName(),
    // A jump host only means something on an SSH transport; drop one left
    // over from before the protocol was switched.
    jumpProfileId: isSshTransport(profile.kind)
      ? profile.jumpProfileId || null
      : null,
  });

  // One line under the title saying what the form connects to as it is filled
  // in, so the header always names the target rather than repeating the mode.
  const summary = (): string => {
    const name = PROTOCOL_NAMES[profile.kind];
    if (profile.kind === "local") {
      return `${name} · ${profile.shell?.trim() || (IS_WINDOWS ? "%COMSPEC%" : "$SHELL")}`;
    }
    if (profile.kind === "serial") {
      const port = profile.portName?.trim();
      return port
        ? `${name} · ${port} · ${profile.baudRate ?? 115200} baud`
        : `${name} · no port selected`;
    }
    const host = profile.host?.trim();
    if (!host) return `${name} · no host yet`;
    const user = profile.username?.trim();
    return `${name} · ${user ? `${user}@` : ""}${host}:${profile.port ?? defaultPort(profile.kind)}`;
  };

  // ProxyJump: tunnel this session through another saved SSH session.
  // Offered for SSH and SFTP alike, since both ride the same transport.
  const renderJumpHostField = () => (
    <>
      <label className="session-field is-wide">
        <span className="session-field-label">Jump host</span>
        <select
          value={profile.jumpProfileId ?? ""}
          onChange={(event) =>
            patch({ jumpProfileId: event.target.value || null })
          }
        >
          <option value="">None — connect directly</option>
          {jumpHostMissing && (
            <option value={profile.jumpProfileId ?? ""}>
              (deleted session)
            </option>
          )}
          {jumpChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {describeJumpHost(p)}
            </option>
          ))}
        </select>
      </label>
      <div className="session-note is-wide">
        <Icon name="info" />
        <span>
          Connect through a saved SSH session (ProxyJump) to reach a host that
          is only visible from its network.
        </span>
      </div>
    </>
  );

  // The authentication block shared by SSH and SFTP: they ride the same
  // transport, so both offer password, public-key, and ssh-agent auth with the
  // exact same inputs.
  const renderServerAuthFields = () => (
    <>
      <label className="session-field">
        <span className="session-field-label">Authentication</span>
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
      </label>

      {profile.auth === "password" && (
        <label className="session-field is-wide">
          <span className="session-field-label">Password</span>
          <input
            {...RAW_TEXT_INPUT}
            type="password"
            value={profile.password ?? ""}
            onChange={(event) => patch({ password: event.target.value })}
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
              onChange={(event) => patch({ privateKeyPath: event.target.value })}
            />
          </label>
          <label className="session-field is-wide">
            <span className="session-field-label">Passphrase</span>
            <input
              {...RAW_TEXT_INPUT}
              type="password"
              value={profile.passphrase ?? ""}
              onChange={(event) => patch({ passphrase: event.target.value })}
            />
          </label>
        </>
      )}
    </>
  );

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
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        // A stray click outside must not discard the form (issue #33): keep
        // the dialog and its focus, and flash it so the click is answered.
        event.preventDefault();
        requestDialogAttention(dialogRef.current);
      }}
    >
      <div
        ref={dialogRef}
        className="dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onAnimationEnd={endDialogAttention}
      >
        <div
          className="dialog-header session-dialog-header is-drag-handle"
          {...dragHandleProps}
        >
          {/* The badge carries the session colour picked below, so the
              dialog wears the identity the tab will have. */}
          <span
            className="session-dialog-badge"
            style={
              {
                "--session-color": profile.color ?? "var(--accent)",
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <Icon name={protocolIcon(profile.kind)} />
          </span>
          <div className="session-dialog-heading">
            <div id="session-dialog-title" className="session-dialog-title">
              {initial?.id ? "Edit Session" : "New Session"}
            </div>
            <div className="session-dialog-subtitle">{summary()}</div>
          </div>
          <button
            className="panel-action"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="dialog-body session-dialog-body">
          <section className="session-section">
            <div className="session-section-heading">
              <Icon name="tag" />
              <span>Session</span>
              <small>Identity and protocol</small>
            </div>
            <div className="session-form-grid">
              <div className="session-field is-wide">
                <span className="session-field-label">Protocol</span>
                <div
                  className="protocol-picker"
                  role="radiogroup"
                  aria-label="Protocol"
                >
                  {PROTOCOL_OPTIONS.map((option) => {
                    const active = option.kinds.includes(profile.kind);
                    // Keep the current sub-choice when the group already
                    // matches; otherwise select the option's default kind.
                    const target = active ? profile.kind : option.kinds[0];
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`protocol-option${active ? " is-active" : ""}`}
                        onClick={() =>
                          patch({
                            kind: target,
                            port: defaultPort(
                              target,
                              profile.kind === target ? profile.port : null,
                            ),
                            // Groups belong to one category; FTP and SFTP share
                            // theirs, so the choice survives switching between
                            // them but is cleared across categories.
                            groupId:
                              groupCategory(profile.kind) ===
                              groupCategory(target)
                                ? profile.groupId
                                : null,
                          })
                        }
                      >
                        <span className="protocol-option-icon">
                          <Icon name={option.icon} />
                        </span>
                        <span className="protocol-option-label">
                          {option.label}
                        </span>
                        <small className="protocol-option-hint">
                          {option.hint}
                        </small>
                      </button>
                    );
                  })}
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

              <div className="session-field">
                <span className="session-field-label">Color</span>
                <div
                  ref={colorPickerRef}
                  className="session-color-picker"
                  role="radiogroup"
                  aria-label="Session color"
                  onKeyDown={(event) => {
                    const current = SESSION_COLORS.indexOf(
                      (event.target as HTMLElement).dataset.color ?? "",
                    );
                    if (current < 0) return;
                    const next = nextColorIndex(
                      event.key,
                      current,
                      SESSION_COLORS.length,
                      COLOR_PICKER_COLUMNS,
                    );
                    if (next == null) return;
                    event.preventDefault();
                    const color = SESSION_COLORS[next];
                    patch({ color });
                    colorPickerRef.current
                      ?.querySelector<HTMLButtonElement>(
                        `[data-color="${color}"]`,
                      )
                      ?.focus();
                  }}
                >
                  {SESSION_COLORS.map((color, index) => {
                    const selected = profile.color === color;
                    // Roving tabindex: only the selected swatch is a Tab stop,
                    // so Tab moves on to the next field and arrow keys pick colors.
                    const tabbable =
                      selected ||
                      (!SESSION_COLORS.includes(profile.color ?? "") &&
                        index === 0);
                    return (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        data-color={color}
                        tabIndex={tabbable ? 0 : -1}
                        className={`session-color-option${selected ? " is-selected" : ""}`}
                        style={{ background: color }}
                        aria-checked={selected}
                        aria-label={`Use session color ${color}`}
                        title={color}
                        onClick={() => patch({ color })}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="session-field is-wide">
                <label className="session-field-label" htmlFor="session-group">
                  Group
                </label>
                <select
                  id="session-group"
                  value={profile.groupId ?? ""}
                  onChange={(event) =>
                    patch({ groupId: event.target.value || null })
                  }
                >
                  <option value="">
                    {sectionLabel(profile.kind)} (no group)
                  </option>
                  {groupChoices.map(({ group }) => (
                    <option key={group.id} value={group.id}>
                      {groupPath(groups, group.id).join(" / ")}
                    </option>
                  ))}
                </select>
                {groupChoices.length === 0 && (
                  <small className="session-field-hint">
                    Right-click a heading in the Session panel to create
                    groups.
                  </small>
                )}
              </div>
            </div>
          </section>

          {profile.kind === "ssh" && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="server" />
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

                {renderServerAuthFields()}
                {renderJumpHostField()}
              </div>
            </section>
          )}

          {(profile.kind === "sftp" || profile.kind === "ftp") && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="folder" />
                <span>(S)FTP connection</span>
                <small>
                  {profile.kind === "sftp"
                    ? "SFTP · encrypted file transfer over SSH"
                    : "FTP · passive mode · unencrypted"}
                </small>
              </div>
              <div className="session-form-grid">
                <div className="session-field is-wide">
                  <span className="session-field-label">Protocol</span>
                  <div className="kind-picker">
                    {(["sftp", "ftp"] as SessionKind[]).map((sub) => (
                      <button
                        key={sub}
                        className={`kind-option${profile.kind === sub ? " is-active" : ""}`}
                        onClick={() =>
                          patch({
                            kind: sub,
                            // Swap the default port when it is still the old
                            // default; keep a custom port untouched. The group
                            // survives — FTP and SFTP share one category.
                            port:
                              profile.port === defaultPort(profile.kind)
                                ? defaultPort(sub)
                                : profile.port,
                          })
                        }
                      >
                        {sub === "sftp" ? "SFTP (over SSH)" : "FTP"}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="session-field">
                  <span className="session-field-label">Host</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.host ?? ""}
                    placeholder={
                      profile.kind === "sftp"
                        ? "sftp.example.com"
                        : "ftp.example.com"
                    }
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">Port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={profile.port ?? (profile.kind === "sftp" ? 22 : 21)}
                    onChange={(event) =>
                      patch({
                        port:
                          Number(event.target.value) ||
                          (profile.kind === "sftp" ? 22 : 21),
                      })
                    }
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">Username</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.username ?? ""}
                    placeholder={profile.kind === "sftp" ? "user" : "anonymous"}
                    onChange={(event) => patch({ username: event.target.value })}
                  />
                </label>

                {profile.kind === "sftp" ? (
                  <>
                    {renderServerAuthFields()}
                    {renderJumpHostField()}
                  </>
                ) : (
                  <>
                    <label className="session-field">
                      <span className="session-field-label">Password</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        type="password"
                        value={profile.password ?? ""}
                        placeholder="Optional for anonymous FTP"
                        onChange={(event) =>
                          patch({ password: event.target.value })
                        }
                      />
                    </label>

                    <div className="session-note is-warning is-wide">
                      <Icon name="warning" />
                      <span>
                        Standard FTP sends credentials and file contents
                        without encryption. Use it only on a trusted network —
                        choose SFTP when transport security is required.
                      </span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {profile.kind === "local" && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="terminal" />
                <span>Local shell</span>
                <small>Process and working directory</small>
              </div>
              <div className="session-form-grid">
                <label className="session-field is-wide">
                  <span className="session-field-label">Shell</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.shell ?? ""}
                    placeholder={IS_WINDOWS ? "%COMSPEC%" : "$SHELL"}
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
                <Icon name="circuit-board" />
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
                      type="button"
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
                      <Icon name="refresh" />
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

          {error && (
            <div className="dialog-error session-dialog-error" role="alert">
              <Icon name="error" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={save} disabled={busy}>
            <Icon name="save" />
            Save
          </button>
          <button
            type="button"
            className="btn is-primary"
            onClick={connect}
            disabled={busy}
          >
            <Icon name="plug" />
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

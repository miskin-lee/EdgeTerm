import { useEffect, useMemo, useState } from "react";

import { openSession } from "../../actions";
import * as api from "../../api";
import { useStore } from "../../store";
import {
  colorForSession,
  type SessionProfile,
  type SshConfigEntry,
} from "../../types";

export const LOCAL_SHELL_PROFILE: SessionProfile = {
  id: "",
  name: "Local Shell",
  kind: "local",
  color: "#3fb950",
};

const SESSION_GROUPS = [
  { kind: "ssh", label: "SSH Sessions" },
  { kind: "ftp", label: "FTP Sessions" },
  { kind: "serial", label: "Serial Sessions" },
  { kind: "local", label: "Shell Sessions" },
] as const;

/** Converts an SSH config entry into a transient SessionProfile for direct connect. */
function configEntryToProfile(entry: SshConfigEntry): SessionProfile {
  return {
    id: "",
    name: entry.alias,
    kind: "ssh",
    color: null,
    host: entry.host,
    port: entry.port,
    username: entry.user,
    auth: entry.identityFile ? "publicKey" : "agent",
    privateKeyPath: entry.identityFile ?? null,
    password: null,
    passphrase: null,
    shell: null,
    cwd: null,
    portName: null,
    baudRate: null,
    dataBits: null,
    stopBits: null,
    parity: null,
    flowControl: null,
  };
}

/** Builds a tooltip showing the full hop chain for a config entry. */
function hopChainTooltip(entry: SshConfigEntry): string {
  if (entry.hops.length <= 1) {
    return `${entry.user}@${entry.host}:${entry.port}`;
  }
  const chain = entry.hops
    .map((h) => `${h.user}@${h.host}:${h.port}`)
    .join(" → ");
  return chain;
}

interface Props {
  onEditProfile: (profile: SessionProfile) => void;
  onNewSession: () => void;
}

export function SessionPanel({ onEditProfile, onNewSession }: Props) {
  const profiles = useStore((s) => s.profiles);
  const removeProfile = useStore((s) => s.removeProfile);
  const upsertProfile = useStore((s) => s.upsertProfile);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // SSH config state
  const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigEntry[]>([]);
  const [sshConfigError, setSshConfigError] = useState<string | null>(null);
  const [sshConfigCollapsed, setSshConfigCollapsed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // Load SSH config hosts on mount and when the panel is expanded.
  const refreshSshConfig = () => {
    api
      .listSshConfigHosts()
      .then((hosts) => {
        setSshConfigHosts(hosts);
        setSshConfigError(null);
      })
      .catch((e) => {
        setSshConfigHosts([]);
        setSshConfigError(String(e));
      });
  };

  useEffect(() => {
    refreshSshConfig();
  }, []);

  // Filter SSH config hosts alongside saved profiles.
  const filteredConfigHosts = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sshConfigHosts;
    return sshConfigHosts.filter((h) =>
      h.alias.toLowerCase().includes(needle),
    );
  }, [sshConfigHosts, filter]);

  // Show SSH config section only if there are hosts and no error.
  const showSshConfigSection =
    sshConfigHosts.length > 0 || sshConfigError !== null;

  // Build saved profile groups.
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = [LOCAL_SHELL_PROFILE, ...profiles].filter(
      (p) => !needle || p.name.toLowerCase().includes(needle),
    );
    return SESSION_GROUPS.map(
      ({ kind, label }) =>
        [label, all.filter((profile) => profile.kind === kind)] as const,
    );
  }, [profiles, filter]);

  // Import all SSH config hosts as saved profiles.
  const handleImportAll = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const imported = await api.importSshConfigHosts();
      if (imported.length > 0) {
        setImportResult(`Imported ${imported.length} host${imported.length > 1 ? "s" : ""}`);
      } else {
        setImportResult("All hosts already exist");
      }
      // Refresh profiles from store
      await useStore.getState().loadProfiles();
      setTimeout(() => setImportResult(null), 3000);
    } catch (e) {
      setImportResult(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  };

  // Connect directly to an SSH config host (without saving).
  const handleConfigHostConnect = (entry: SshConfigEntry) => {
    const profile = configEntryToProfile(entry);
    void openSession(profile);
  };

  // Save a single SSH config host as a profile.
  const handleConfigHostSave = async (entry: SshConfigEntry) => {
    const profile = configEntryToProfile(entry);
    await upsertProfile(profile);
    refreshSshConfig();
  };

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" style={{ background: "#e3b341" }} />
          Session
        </div>
        <button
          className="panel-action"
          onClick={onNewSession}
          title="New session"
        >
          ＋
        </button>
      </div>

      <div className="panel-filter">
        <input
          value={filter}
          placeholder="Filter"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="panel-body">
        {/* SSH Config Section */}
        {showSshConfigSection && (
          <div>
            <div
              className="row"
              onMouseDown={() => setSshConfigCollapsed((v) => !v)}
              title="Hosts parsed from ~/.ssh/config"
            >
              <span className="row-caret">
                {sshConfigCollapsed ? "▶" : "▼"}
              </span>
              <span className="row-label">SSH Config</span>
              <span className="row-meta">{sshConfigHosts.length}</span>
              <button
                className="panel-action"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  refreshSshConfig();
                }}
                title="Refresh from ~/.ssh/config"
              >
                ⟳
              </button>
              <button
                className="panel-action"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  void handleImportAll();
                }}
                title="Import all as saved sessions"
                disabled={importing}
              >
                ⬇
              </button>
            </div>

            {!sshConfigCollapsed && (
              <>
                {sshConfigError && (
                  <div
                    className="row"
                    style={{ paddingLeft: 26, opacity: 0.7 }}
                    title={sshConfigError}
                  >
                    <span className="row-dot" style={{ background: "#f85149" }} />
                    <span
                      className="row-label"
                      style={{ fontSize: "0.85em" }}
                    >
                      No config found
                    </span>
                  </div>
                )}
                {filteredConfigHosts.map((entry) => (
                  <div
                    key={entry.alias}
                    className="row"
                    style={{ paddingLeft: 26 }}
                    onDoubleClick={() => handleConfigHostConnect(entry)}
                    title={hopChainTooltip(entry)}
                  >
                    <span
                      className="row-dot"
                      style={{
                        background: colorForSession(entry.alias),
                      }}
                    />
                    <span className="row-label">{entry.alias}</span>
                    {entry.proxyJump && (
                      <span
                        className="row-meta"
                        style={{ opacity: 0.6, fontSize: "0.8em" }}
                        title={`ProxyJump: ${entry.proxyJump}`}
                      >
                        ↥
                      </span>
                    )}
                    <button
                      className="panel-action"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        void handleConfigHostSave(entry);
                      }}
                      title="Save as session"
                    >
                      ⬇
                    </button>
                  </div>
                ))}
                {importResult && (
                  <div
                    className="row"
                    style={{ paddingLeft: 26, opacity: 0.7 }}
                  >
                    <span className="row-label" style={{ fontSize: "0.85em" }}>
                      {importResult}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Saved Profile Groups */}
        {groups.map(([group, items]) => (
          <div key={group}>
            <div
              className="row"
              onMouseDown={() =>
                setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))
              }
            >
              <span className="row-caret">{collapsed[group] ? "▶" : "▼"}</span>
              <span className="row-label">{group}</span>
              <span className="row-meta">{items.length}</span>
            </div>

            {!collapsed[group] &&
              items.map((profile) => (
                <div
                  key={profile.id || profile.name}
                  className="row"
                  style={{ paddingLeft: 26 }}
                  onDoubleClick={() => void openSession(profile)}
                  title={
                    profile.kind === "ssh"
                      ? `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}`
                      : profile.kind === "ftp"
                        ? `${profile.username || "anonymous"}@${profile.host ?? ""}:${profile.port ?? 21}`
                      : profile.kind === "serial"
                        ? `${profile.portName ?? ""} @ ${profile.baudRate ?? 115200}`
                        : (profile.shell ?? "default shell")
                  }
                >
                  <span
                    className="row-dot"
                    style={{
                      background:
                        profile.color ??
                        colorForSession(profile.id || profile.name),
                    }}
                  />
                  <span className="row-label">{profile.name}</span>
                  {profile.id && (
                    <>
                      <button
                        className="panel-action"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          onEditProfile(profile);
                        }}
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        className="panel-action"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          void removeProfile(profile.id);
                        }}
                        title="Delete"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
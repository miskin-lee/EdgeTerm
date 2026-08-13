import { useMemo, useState } from "react";

import { openSession } from "../../actions";
import { useStore } from "../../store";
import { colorForSession, type SessionProfile } from "../../types";

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

interface Props {
  onEditProfile: (profile: SessionProfile) => void;
  onNewSession: () => void;
}

export function SessionPanel({ onEditProfile, onNewSession }: Props) {
  const profiles = useStore((s) => s.profiles);
  const removeProfile = useStore((s) => s.removeProfile);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

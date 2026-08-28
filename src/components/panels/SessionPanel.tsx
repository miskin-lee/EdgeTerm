import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { ask } from "@tauri-apps/plugin-dialog";

import { openSession, toggleSessionConnection } from "../../actions";
import * as api from "../../api";
import {
  byName,
  childGroups,
  describeLocation,
  effectiveGroupId,
  flattenGroups,
  sectionLabel,
  SESSION_SECTIONS,
} from "../../sessionGroups";
import { useStore } from "../../store";
import {
  colorForSession,
  type SavedCommand,
  type SessionGroup,
  type SessionKind,
  type SessionProfile,
  type SessionState,
} from "../../types";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { DeleteProfileDialog } from "../DeleteProfileDialog";
import { GroupNameDialog } from "../GroupNameDialog";

export const LOCAL_SHELL_PROFILE: SessionProfile = {
  id: "",
  name: "Local Shell",
  kind: "local",
  color: "#3fb950",
};

/** Tooltip of the power toggle, by the active tab's state. */
const POWER_TITLES: Record<SessionState, string> = {
  connected: "Disconnect",
  connecting: "Connecting…",
  closed: "Reconnect",
  error: "Reconnect",
};

/** Horizontal step per tree level; the kind headings sit at level 0. */
const INDENT = 18;

/** Folder glyph for group rows, drawn like the Filer's directory entries. */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="row-folder"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {open ? (
        <>
          <path
            d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.4a1 1 0 0 1 .7.3l1 1h5.4a1 1 0 0 1 1 1V7H3.2a1 1 0 0 0-.95.68L1.5 10V3.5Z"
            opacity="0.55"
          />
          <path d="M2.35 8.35A1 1 0 0 1 3.3 7.7h11.2a.75.75 0 0 1 .7 1l-1.6 4.1a1 1 0 0 1-.94.65H2.55a1 1 0 0 1-.95-1.3l.75-3.8Z" />
        </>
      ) : (
        <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.4a1 1 0 0 1 .7.3l1 1h5.4a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.5Z" />
      )}
    </svg>
  );
}

/** One-line connection target, used for the row tooltip and delete prompt. */
function describeProfile(profile: SessionProfile): string {
  switch (profile.kind) {
    case "ssh":
      return `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}`;
    case "sftp":
      return `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}`;
    case "ftp":
      return `${profile.username || "anonymous"}@${profile.host ?? ""}:${profile.port ?? 21}`;
    case "serial":
      return `${profile.portName ?? ""} @ ${profile.baudRate ?? 115200}`;
    default:
      return profile.shell ?? "default shell";
  }
}

type Row =
  | {
      type: "group";
      group: SessionGroup;
      depth: number;
      /** Profiles in the group and all of its subgroups. */
      count: number;
      collapsed: boolean;
    }
  | { type: "profile"; profile: SessionProfile; depth: number };

interface KindSection {
  kind: SessionKind;
  label: string;
  count: number;
  collapsed: boolean;
  rows: Row[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type GroupDialogState =
  | { mode: "create"; kind: SessionKind; parentId: string | null }
  | { mode: "rename"; group: SessionGroup };

interface Props {
  onEditProfile: (profile: SessionProfile) => void;
  onNewSession: () => void;
}

export function SessionPanel({ onEditProfile, onNewSession }: Props) {
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const removeProfile = useStore((s) => s.removeProfile);
  const moveProfileToGroup = useStore((s) => s.moveProfileToGroup);
  const upsertGroup = useStore((s) => s.upsertGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const setStatus = useStore((s) => s.setStatus);
  // The header's power toggle acts on the active tab, like Session →
  // Disconnect / Reconnect Session.
  const activeTab = useStore((s) =>
    s.tabs.find((tab) => tab.info.id === s.activeId),
  );

  const [filter, setFilter] = useState("");
  /** Keys are `kind:<kind>` for headings and `group:<id>` for groups. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /**
   * Profile awaiting the user's answer in the delete-confirmation dialog,
   * with how many Sender commands are scoped to it alone (they go with it,
   * and the dialog says so).
   */
  const [pendingDelete, setPendingDelete] = useState<{
    profile: SessionProfile;
    scopedCommands: number;
  } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(
    null,
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const filtering = filter.trim().length > 0;

  const sections = useMemo<KindSection[]>(() => {
    const needle = filter.trim().toLowerCase();
    const visible = [LOCAL_SHELL_PROFILE, ...profiles].filter(
      (p) => !needle || p.name.toLowerCase().includes(needle),
    );

    return SESSION_SECTIONS.map((section) => {
      const byGroup = new Map<string | null, SessionProfile[]>();
      for (const profile of visible) {
        if (!section.kinds.includes(profile.kind)) continue;
        const groupId = effectiveGroupId(groups, profile);
        byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), profile]);
      }
      for (const members of byGroup.values()) members.sort(byName);

      // Folders first, then the profiles at that level, both A→Z — the shape
      // of a file tree. While filtering, empty groups are dropped and
      // collapse state is ignored so every match is on screen.
      const walk = (
        parentId: string | null,
        depth: number,
      ): { rows: Row[]; count: number } => {
        const rows: Row[] = [];
        let count = 0;
        for (const group of childGroups(groups, section.kind, parentId)) {
          const sub = walk(group.id, depth + 1);
          if (needle && sub.count === 0) continue;
          const isCollapsed =
            !needle && Boolean(collapsed[`group:${group.id}`]);
          rows.push({
            type: "group",
            group,
            depth,
            count: sub.count,
            collapsed: isCollapsed,
          });
          if (!isCollapsed) rows.push(...sub.rows);
          count += sub.count;
        }
        for (const profile of byGroup.get(parentId) ?? []) {
          rows.push({ type: "profile", profile, depth });
          count++;
        }
        return { rows, count };
      };

      const { rows, count } = walk(null, 1);
      return {
        kind: section.kind,
        label: section.label,
        count,
        collapsed: !needle && Boolean(collapsed[`kind:${section.kind}`]),
        rows,
      };
    });
  }, [profiles, groups, filter, collapsed]);

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const report = (what: string, error: unknown) =>
    setStatus(`${what}: ${error}`);

  const listSenderCommands = () =>
    api.listSenderCommands().catch((): SavedCommand[] => []);

  /** Opens the delete dialog, counting the Sender commands that go with it. */
  const askDeleteProfile = async (profile: SessionProfile) => {
    const commands = await listSenderCommands();
    const scopedCommands = commands.filter(
      (command) =>
        command.scope.type === "profile" && command.scope.id === profile.id,
    ).length;
    setPendingDelete({ profile, scopedCommands });
  };

  const confirmDeleteGroup = async (group: SessionGroup) => {
    const inSubtree = (groupId: string | null) => {
      let cursor = groupId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === group.id) return true;
        seen.add(cursor);
        cursor = groups.find((g) => g.id === cursor)?.parentId ?? null;
      }
      return false;
    };
    const insideProfiles = profiles.filter((p) =>
      inSubtree(effectiveGroupId(groups, p)),
    );
    const insideIds = new Set(insideProfiles.map((p) => p.id));
    // Everything scoped to the subtree goes with it: commands of the groups
    // and commands of the sessions in them.
    const scopedCommands = (await listSenderCommands()).filter(
      (command) =>
        (command.scope.type === "group" && inSubtree(command.scope.id)) ||
        (command.scope.type === "profile" && insideIds.has(command.scope.id)),
    ).length;
    const plural = (count: number, noun: string) =>
      `${count} ${noun}${count === 1 ? "" : "s"}`;
    const contents = [
      insideProfiles.length > 0 && plural(insideProfiles.length, "session"),
      scopedCommands > 0 && plural(scopedCommands, "saved Sender command"),
    ].filter((part): part is string => typeof part === "string");
    const consequence =
      contents.length === 0
        ? "It contains no sessions."
        : `Its subgroups, ${contents.join(" and ")} will be deleted with it. This cannot be undone.`;
    const confirmed = await ask(
      `Delete the group "${group.name}" and everything in it? ${consequence}`,
      {
        title: "Delete Group",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;
    try {
      await removeGroup(group.id);
      setStatus(`Group "${group.name}" deleted`);
    } catch (error) {
      report("Failed to delete group", error);
    }
  };

  const kindMenu = (kind: SessionKind): MenuItem[] => [
    {
      label: "New Group…",
      action: () => setGroupDialog({ mode: "create", kind, parentId: null }),
    },
  ];

  const groupMenu = (group: SessionGroup): MenuItem[] => [
    {
      label: "New Subgroup…",
      action: () =>
        setGroupDialog({
          mode: "create",
          kind: group.kind,
          parentId: group.id,
        }),
    },
    "separator",
    {
      label: "Rename Group…",
      action: () => setGroupDialog({ mode: "rename", group }),
    },
    {
      label: "Delete Group…",
      danger: true,
      action: () => void confirmDeleteGroup(group),
    },
  ];

  const profileMenu = (profile: SessionProfile): MenuItem[] => {
    const connect: MenuItem = {
      label: "Connect",
      action: () => void openSession(profile),
    };
    // The built-in Local Shell is not a saved profile: nothing to edit or move.
    if (!profile.id) return [connect];

    const current = effectiveGroupId(groups, profile);
    const move = (groupId: string | null) => () =>
      moveProfileToGroup(profile.id, groupId).catch((error) =>
        report("Failed to move session", error),
      );
    const choices: MenuItem[] = [
      {
        label: `${sectionLabel(profile.kind)} (no group)`,
        checked: current === null,
        action: move(null),
      },
    ];
    const nodes = flattenGroups(groups, profile.kind);
    if (nodes.length > 0) {
      choices.push("separator");
      for (const { group, depth } of nodes) {
        choices.push({
          label: group.name,
          indent: depth,
          checked: current === group.id,
          action: move(group.id),
        });
      }
    } else {
      choices.push({ label: "No groups yet", disabled: true });
    }

    return [
      connect,
      { label: "Edit…", action: () => onEditProfile(profile) },
      { label: "Move to Group", children: choices },
      "separator",
      {
        label: "Delete…",
        danger: true,
        action: () => void askDeleteProfile(profile),
      },
    ];
  };

  const renderProfile = (profile: SessionProfile, depth: number) => (
    <div
      key={profile.id || profile.name}
      className="row"
      style={{ paddingLeft: 8 + INDENT * depth }}
      onDoubleClick={() => void openSession(profile)}
      onContextMenu={(event) => openMenu(event, profileMenu(profile))}
      title={describeProfile(profile)}
    >
      <span
        className="row-dot"
        style={{
          background:
            profile.color ?? colorForSession(profile.id || profile.name),
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
              void askDeleteProfile(profile);
            }}
            title="Delete"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );

  const renderGroup = (row: Extract<Row, { type: "group" }>) => (
    // Location breadcrumb doubles as the hint that a menu exists here.
    <div
      key={`group:${row.group.id}`}
      className="row is-group"
      style={{ paddingLeft: 8 + INDENT * row.depth }}
      onMouseDown={(event) => {
        if (event.button === 0) toggle(`group:${row.group.id}`);
      }}
      onContextMenu={(event) => openMenu(event, groupMenu(row.group))}
      title={`${describeLocation(
        groups,
        row.group.kind,
        row.group.id,
      )} · right-click for options`}
    >
      <span className="row-caret">{row.collapsed ? "▶" : "▼"}</span>
      <FolderIcon open={!row.collapsed} />
      <span className="row-label">{row.group.name}</span>
      <span className="row-meta">{row.count}</span>
    </div>
  );

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" style={{ background: "#e3b341" }} />
          Session
        </div>
        <button
          className={`panel-action panel-power${
            activeTab?.state === "connected" ? " is-connected" : ""
          }`}
          disabled={!activeTab || activeTab.state === "connecting"}
          onClick={() => {
            if (activeTab) toggleSessionConnection(activeTab.info.id);
          }}
          title={
            activeTab
              ? `${POWER_TITLES[activeTab.state]} · ${activeTab.info.name}`
              : "No active session"
          }
          aria-label={activeTab ? POWER_TITLES[activeTab.state] : "Disconnect"}
        >
          {/* Power symbol: an open ring with a bar through the gap. */}
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.1 2.9A3.3 3.3 0 1 0 6.9 2.9" />
            <path d="M5 0.9v4.3" />
          </svg>
        </button>
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
        {sections.map((section) => (
          <div key={section.kind}>
            <div
              className="row"
              onMouseDown={(event) => {
                if (event.button === 0) toggle(`kind:${section.kind}`);
              }}
              onContextMenu={(event) =>
                openMenu(event, kindMenu(section.kind))
              }
              title="Right-click to add a group"
            >
              <span className="row-caret">
                {section.collapsed ? "▶" : "▼"}
              </span>
              <span className="row-label">{section.label}</span>
              <span className="row-meta">{section.count}</span>
            </div>

            {!section.collapsed &&
              section.rows.map((row) =>
                row.type === "group"
                  ? renderGroup(row)
                  : renderProfile(row.profile, row.depth),
              )}
          </div>
        ))}
        {filtering && sections.every((section) => section.count === 0) && (
          <div className="panel-empty">
            No sessions match “{filter.trim()}”.
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={closeMenu}
        />
      )}

      {groupDialog &&
        (groupDialog.mode === "create" ? (
          <GroupNameDialog
            title={groupDialog.parentId ? "New Subgroup" : "New Group"}
            location={describeLocation(
              groups,
              groupDialog.kind,
              groupDialog.parentId,
            )}
            submitLabel="Create"
            onSubmit={async (name) => {
              const saved = await upsertGroup({
                id: "",
                name,
                kind: groupDialog.kind,
                parentId: groupDialog.parentId,
              });
              // A new group is empty, so make sure its parents are open.
              setCollapsed((prev) => ({
                ...prev,
                [`kind:${saved.kind}`]: false,
                ...(saved.parentId
                  ? { [`group:${saved.parentId}`]: false }
                  : {}),
              }));
              setGroupDialog(null);
            }}
            onCancel={() => setGroupDialog(null)}
          />
        ) : (
          <GroupNameDialog
            title="Rename Group"
            location={describeLocation(
              groups,
              groupDialog.group.kind,
              groupDialog.group.parentId,
            )}
            initialName={groupDialog.group.name}
            submitLabel="Rename"
            onSubmit={async (name) => {
              await upsertGroup({ ...groupDialog.group, name });
              setGroupDialog(null);
            }}
            onCancel={() => setGroupDialog(null)}
          />
        ))}

      {pendingDelete && (
        <DeleteProfileDialog
          profile={pendingDelete.profile}
          target={describeProfile(pendingDelete.profile)}
          scopedCommands={pendingDelete.scopedCommands}
          onConfirm={() => {
            // Dismiss first so a second Enter cannot re-enter removeProfile
            // while the backend delete is still in flight.
            setPendingDelete(null);
            void removeProfile(pendingDelete.profile.id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

import type { SessionGroup, SessionKind, SessionProfile } from "./types";

/**
 * Per-kind display names. The Session panel groups by section (see
 * `SESSION_SECTIONS`, which merges FTP and SFTP under one heading); these
 * single-kind labels are used where an individual kind is named, such as the
 * Sender's kind-scope description.
 */
export const KIND_LABELS: Record<SessionKind, string> = {
  ssh: "SSH Sessions",
  sftp: "SFTP Sessions",
  ftp: "FTP Sessions",
  serial: "Serial Sessions",
  local: "Shell Sessions",
};

/**
 * The grouping namespace a session kind belongs to. FTP and SFTP are both
 * remote-file sessions that share one panel section, so they share one set of
 * folders: a group can hold servers of either protocol. Groups are always
 * stored under the category's canonical kind (`ftp`), and membership and
 * nesting are compared by category rather than by exact kind — both here and
 * in the Rust store's `group_category`.
 */
export function groupCategory(kind: SessionKind): SessionKind {
  return kind === "sftp" ? "ftp" : kind;
}

/** A top-level Session-panel heading, covering one or more session kinds. */
export interface SessionSection {
  /** Canonical grouping kind — used to create groups and look them up. */
  kind: SessionKind;
  /** Profile kinds listed under this heading. */
  kinds: SessionKind[];
  label: string;
}

/** Top-level headings of the Session panel, in display order. */
export const SESSION_SECTIONS: readonly SessionSection[] = [
  { kind: "ssh", kinds: ["ssh"], label: "SSH Sessions" },
  { kind: "ftp", kinds: ["ftp", "sftp"], label: "(S)FTP Sessions" },
  { kind: "serial", kinds: ["serial"], label: "Serial Sessions" },
  { kind: "local", kinds: ["local"], label: "Shell Sessions" },
];

/** The heading a kind is listed under — merged for FTP / SFTP. */
export function sectionLabel(kind: SessionKind): string {
  return (
    SESSION_SECTIONS.find((section) => section.kinds.includes(kind))?.label ??
    KIND_LABELS[kind]
  );
}

/** A group with its nesting depth (0 = directly under the kind heading). */
export interface GroupNode {
  group: SessionGroup;
  depth: number;
}

/**
 * Case-insensitive, locale-aware name order. Every level of the Session tree
 * lists groups first, then profiles, each sorted with this comparator.
 */
export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * The parent a group is drawn under. A parent that no longer exists (a
 * hand-edited file) is treated as "none" so the group still shows up at the
 * kind root instead of silently disappearing with everything in it.
 */
export function effectiveParentId(
  groups: readonly SessionGroup[],
  group: SessionGroup,
): string | null {
  const parentId = group.parentId ?? null;
  if (parentId === null || parentId === group.id) return null;
  return groups.some(
    (g) =>
      g.id === parentId && groupCategory(g.kind) === groupCategory(group.kind),
  )
    ? parentId
    : null;
}

/** The group a profile is drawn in, or null for its kind's root. */
export function effectiveGroupId(
  groups: readonly SessionGroup[],
  profile: SessionProfile,
): string | null {
  const groupId = profile.groupId ?? null;
  if (groupId === null) return null;
  return groups.some(
    (g) =>
      g.id === groupId && groupCategory(g.kind) === groupCategory(profile.kind),
  )
    ? groupId
    : null;
}

/** Direct subgroups of `parentId` (null = kind root), sorted by name. */
export function childGroups(
  groups: readonly SessionGroup[],
  kind: SessionKind,
  parentId: string | null,
): SessionGroup[] {
  return groups
    .filter(
      (g) =>
        groupCategory(g.kind) === groupCategory(kind) &&
        effectiveParentId(groups, g) === parentId,
    )
    .sort(byName);
}

/** Every group of a kind, depth-first in the order the panel draws them. */
export function flattenGroups(
  groups: readonly SessionGroup[],
  kind: SessionKind,
): GroupNode[] {
  const out: GroupNode[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const group of childGroups(groups, kind, parentId)) {
      // Defensive against a cycle in a hand-edited file.
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      out.push({ group, depth });
      visit(group.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** Names from the kind root down to the group, e.g. ["prod", "eu"]. */
export function groupPath(
  groups: readonly SessionGroup[],
  id: string | null,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const group = groups.find((g) => g.id === cursor);
    if (!group) break;
    names.unshift(group.name);
    cursor = effectiveParentId(groups, group);
  }
  return names;
}

/** "SSH Sessions / prod / eu" — where a group or profile lives. */
export function describeLocation(
  groups: readonly SessionGroup[],
  kind: SessionKind,
  groupId: string | null,
): string {
  return [sectionLabel(kind), ...groupPath(groups, groupId)].join(" / ");
}

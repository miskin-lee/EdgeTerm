import {
  effectiveGroupId,
  effectiveParentId,
  groupPath,
  KIND_LABELS,
} from "./sessionGroups";
import type { Tab } from "./store";
import type {
  CommandScope,
  SessionGroup,
  SessionProfile,
} from "./types";

// Saved Sender commands live in one library but each carries a scope; the
// Sender lists the union of the scopes that apply to the active tab. This
// module resolves that chain and names its entries; the backend enforces the
// scope references and moves commands up when their target is deleted.

/** Stable identity of a scope, for comparisons, keys and select values. */
export function scopeKey(scope: CommandScope): string {
  switch (scope.type) {
    case "global":
      return "global";
    case "kind":
      return `kind:${scope.kind}`;
    case "group":
      return `group:${scope.id}`;
    case "profile":
      return `profile:${scope.id}`;
  }
}

export const sameScope = (a: CommandScope, b: CommandScope) =>
  scopeKey(a) === scopeKey(b);

export type ScopeLevel = CommandScope["type"];

const SAVE_LEVEL_KEY = "edgeterm.senderSaveLevel";
/** Broadest first, so a missing level falls through to the next one up. */
const LEVELS_NARROW_TO_BROAD: readonly ScopeLevel[] = [
  "profile",
  "group",
  "kind",
  "global",
];

/**
 * The scopes whose commands a tab sees, broadest first: global, its session
 * kind, the profile's groups from the outermost down to the one holding it,
 * then the saved profile itself. That order is used everywhere a scope is
 * listed. A tab without a saved profile (quick connect, or a profile deleted
 * since it was opened) ends at the kind; with no tab at all only global
 * commands are listed.
 */
export function scopeChain(
  tab: Tab | undefined,
  profiles: readonly SessionProfile[],
  groups: readonly SessionGroup[],
): CommandScope[] {
  if (!tab) return [{ type: "global" }];
  const chain: CommandScope[] = [
    { type: "global" },
    { type: "kind", kind: tab.info.kind },
  ];

  // The saved copy, not the tab's snapshot: the profile may have been moved
  // to another group since the tab was opened.
  const profile = tab.profile.id
    ? profiles.find((candidate) => candidate.id === tab.profile.id)
    : undefined;
  if (profile) {
    // Walk up from the profile's group, then list the groups outermost first.
    const lineage: CommandScope[] = [];
    const seen = new Set<string>();
    let groupId = effectiveGroupId(groups, profile);
    while (groupId !== null && !seen.has(groupId)) {
      seen.add(groupId);
      lineage.unshift({ type: "group", id: groupId });
      const group = groups.find((candidate) => candidate.id === groupId);
      groupId = group ? effectiveParentId(groups, group) : null;
    }
    chain.push(...lineage, { type: "profile", id: profile.id });
  }
  return chain;
}

/**
 * How a scope is named in the Save picker, the Scope submenu, tag sections
 * and tooltips. A nested group shows its whole path ("Prod / EU") so two
 * levels of the same tree are told apart at a glance.
 */
export function scopeLabel(
  scope: CommandScope,
  profiles: readonly SessionProfile[],
  groups: readonly SessionGroup[],
): string {
  switch (scope.type) {
    case "global":
      return "Everywhere";
    case "kind":
      return KIND_LABELS[scope.kind];
    case "group": {
      const path = groupPath(groups, scope.id);
      return path.length > 0 ? `Group “${path.join(" / ")}”` : "Group";
    }
    case "profile": {
      const profile = profiles.find((candidate) => candidate.id === scope.id);
      return profile ? `Session “${profile.name}”` : "Session";
    }
  }
}

/**
 * The chain entry for a remembered level, or the nearest broader one when
 * the tab has no such level (a quick-connect tab has no profile or group).
 * "group" means the innermost group, the one holding the profile.
 */
export function scopeForLevel(
  chain: readonly CommandScope[],
  level: ScopeLevel,
): CommandScope {
  const start = LEVELS_NARROW_TO_BROAD.indexOf(level);
  for (const candidate of LEVELS_NARROW_TO_BROAD.slice(start)) {
    const matches = chain.filter((scope) => scope.type === candidate);
    if (matches.length > 0) return matches[matches.length - 1];
  }
  return chain[0];
}

// The last choice in the Save picker is remembered as a level rather than a
// concrete scope, so "this session's group" carries over to the next tab's
// group; it only preselects the entry, the picker still asks every time.
// Everywhere is the initial default, matching how tags behaved before scopes.
export function loadSaveLevel(): ScopeLevel {
  try {
    const stored = localStorage.getItem(SAVE_LEVEL_KEY);
    if (
      stored === "profile" ||
      stored === "group" ||
      stored === "kind" ||
      stored === "global"
    ) {
      return stored;
    }
  } catch {
    // Use the default when storage is unavailable.
  }
  return "global";
}

export function storeSaveLevel(level: ScopeLevel): void {
  try {
    localStorage.setItem(SAVE_LEVEL_KEY, level);
  } catch {
    // The choice still applies for this run when storage is unavailable.
  }
}

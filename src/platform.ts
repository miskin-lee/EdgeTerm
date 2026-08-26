/**
 * True when built for macOS, where app shortcuts use ⌘ instead of Alt.
 * Resolved at build time (see `define` in vite.config.ts) rather than from
 * the user agent, so each platform ships only its own shortcut flow.
 */
export const IS_MAC: boolean = __EDGETERM_MAC__;

/** Pick the shortcut label for the current platform. */
export const shortcutLabel = (mac: string, other: string): string =>
  IS_MAC ? mac : other;

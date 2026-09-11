/**
 * True when built for macOS, where app shortcuts use ⌘ instead of Alt.
 * Resolved at build time (see `define` in vite.config.ts) rather than from
 * the user agent, so each platform ships only its own shortcut flow.
 */
export const IS_MAC: boolean = __EDGETERM_MAC__;

/** True when built for Windows (shell placeholder, path conventions). */
export const IS_WINDOWS: boolean = __EDGETERM_WINDOWS__;

/** True on macOS, where app shortcuts use ⌘ instead of Ctrl / Alt. */
export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

/** Pick the shortcut label for the current platform. */
export const shortcutLabel = (mac: string, other: string): string =>
  IS_MAC ? mac : other;

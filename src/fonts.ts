import { IS_MAC, IS_WINDOWS } from "./platform";

/**
 * Monospace font stack for the terminal buffer and code-like UI.
 *
 * EdgeTerm ships no fonts of its own; like VS Code it renders the buffer with
 * the platform's stock monospace face so it looks native on every machine.
 * The three stacks are VS Code's `editor.fontFamily` defaults verbatim (its
 * integrated terminal inherits the same value), picked at build time.
 */
export const MONO_FONT_FAMILY: string = IS_MAC
  ? "Menlo, Monaco, 'Courier New', monospace"
  : IS_WINDOWS
    ? "Consolas, 'Courier New', monospace"
    : "'Droid Sans Mono', 'monospace', monospace";

/**
 * Interface font stack: the system UI face of each platform with CJK
 * fallbacks. `styles.css` carries the same value as the pre-script default.
 */
export const UI_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', " +
  "'Microsoft YaHei', Roboto, sans-serif";

/**
 * Families Display Settings offers for the buffer. Nothing here is bundled:
 * the list is filtered down to what the machine actually has (see
 * `installedFonts`), so it can name all three platforms' stock faces and the
 * popular downloads at once. Alphabetical, which is the order the picker
 * shows them in.
 */
const MONO_CANDIDATES = [
  "Andale Mono",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Courier New",
  "DejaVu Sans Mono",
  "Droid Sans Mono",
  "Fira Code",
  "FiraCode Nerd Font",
  "Fira Mono",
  "Hack",
  "Hack Nerd Font",
  "IBM Plex Mono",
  "Inconsolata",
  "Iosevka",
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "Liberation Mono",
  "Lucida Console",
  "Maple Mono",
  "Menlo",
  "MesloLGS NF",
  "Monaco",
  "Monaspace Neon",
  "Noto Sans Mono",
  "PT Mono",
  "Roboto Mono",
  "Sarasa Mono SC",
  "SF Mono",
  "Source Code Pro",
  "Space Mono",
  "Ubuntu Mono",
  "Ubuntu Sans Mono",
  "Victor Mono",
];

/** The same idea for the interface: system UI faces plus common downloads. */
const UI_CANDIDATES = [
  "Arial",
  "Cantarell",
  "DejaVu Sans",
  "Helvetica Neue",
  "Inter",
  "Lato",
  "Microsoft YaHei",
  "Noto Sans",
  "Noto Sans SC",
  "Open Sans",
  "PingFang SC",
  "Roboto",
  "Segoe UI",
  "Source Han Sans SC",
  "Source Sans Pro",
  "Ubuntu",
  "Verdana",
];

/** Which list a font setting picks from. */
export type FontRole = "mono" | "ui";

/** Wraps a family name so a name with spaces survives as one CSS token. */
const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

/**
 * The value for `--font-mono` / `--font-ui` and for xterm's `fontFamily`:
 * the chosen family in front of the platform default, which stays as the
 * fallback for glyphs the chosen face has no coverage for. An empty choice
 * means the default alone.
 */
export const fontStack = (role: FontRole, family: string): string => {
  const base = role === "mono" ? MONO_FONT_FAMILY : UI_FONT_FAMILY;
  const chosen = family.trim();
  return chosen ? `${quote(chosen)}, ${base}` : base;
};

/** Publishes both stacks as CSS variables; xterm reads its own from here. */
export function applyFonts(
  monoFamily = "",
  uiFamily = "",
  root: HTMLElement = document.documentElement,
) {
  root.style.setProperty("--font-mono", fontStack("mono", monoFamily));
  root.style.setProperty("--font-ui", fontStack("ui", uiFamily));
}

// Rendering the same string in the candidate and in a generic family gives
// different widths exactly when the candidate resolves to a real face. It is
// the only way to ask a WebView which fonts a machine has: `queryLocalFonts`
// is Chromium-only and behind a permission prompt, and `document.fonts.check`
// answers for web fonts rather than installed ones.
const PROBE_TEXT = "MWimlt0O@#中文 ABCXYZabcxyz1234567890";
const PROBE_SIZE = 72;
const GENERIC_FAMILIES = ["monospace", "sans-serif", "serif"];

let probeContext: CanvasRenderingContext2D | null | undefined;

const measure = (context: CanvasRenderingContext2D, stack: string): number => {
  context.font = `${PROBE_SIZE}px ${stack}`;
  return context.measureText(PROBE_TEXT).width;
};

/** True when `family` names a face this machine can actually render. */
export function isFontInstalled(family: string): boolean {
  const name = family.trim();
  if (!name) return false;
  if (probeContext === undefined) {
    probeContext = document.createElement("canvas").getContext("2d");
  }
  const context = probeContext;
  if (!context) return false;
  return GENERIC_FAMILIES.some(
    (generic) =>
      measure(context, `${quote(name)}, ${generic}`) !==
      measure(context, generic),
  );
}

/**
 * The candidates this machine has, plus `keep` when it is a family the user
 * already chose: a setting imported from another machine must stay visible
 * (and selected) even where the font is missing.
 */
export function installedFonts(role: FontRole, keep = ""): string[] {
  const candidates = role === "mono" ? MONO_CANDIDATES : UI_CANDIDATES;
  const found = candidates.filter(isFontInstalled);
  const chosen = keep.trim();
  if (chosen && !found.includes(chosen)) {
    return [...found, chosen].sort((a, b) => a.localeCompare(b));
  }
  return found;
}

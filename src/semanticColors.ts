import type { ThemeMode } from "./types";

export interface SemanticRange {
  start: number;
  end: number;
  /** Foreground color for the span. */
  color: string;
  /** Draw a thin underline in `color` (links). */
  underline?: boolean;
}

export interface SemanticLine {
  ranges: SemanticRange[];
  /** Full-width tint behind the whole logical line, blended and opaque. */
  band?: string;
}

type SemanticPalette = Record<
  | "rose"
  | "red"
  | "coral"
  | "orange"
  | "amber"
  | "yellow"
  | "gold"
  | "lime"
  | "green"
  | "mint"
  | "cyan"
  | "sky"
  | "blue"
  | "violet"
  | "purple"
  | "orchid"
  | "pink"
  | "slate"
  | "gray",
  string
>;

// One palette per background. Both lean warm on purpose: the most frequent
// tokens in terminal output (paths, strings, numbers, options, prompts) sit in
// the yellow/orange/purple/pink range, and blue/cyan are reserved for the few
// classes where they carry meaning (links, network, commands, keys).
//
// Role map (same for both themes):
//   rose    prompt sign, fatal/panic class, signals, git conflicts
//   red     errors, root user, diff removals, executable permission bits
//   coral   environment variables, pending/transitional states
//   orange  command-line options (in output such as --help text)
//   amber   warnings, sizes/units/percentages, write permission bits, TODO
//   yellow  paths, filenames, prompt cwd
//   gold    quoted strings
//   lime    operators, bracket level 1, diff additions, prompt user, ls owner
//   green   success states, times, ✓ glyphs
//   mint    hostnames, domains, IP/MAC addresses, ls group
//   cyan    emails, HTTP methods, diff hunks
//   sky     keys and variables, table headers, read permission bits, option
//           values, URLs, progress verbs
//   blue    info class, bracket level 3
//   violet  versions, section headers, git renames
//   purple  numbers, booleans/null, permission type bits
//   orchid  dates, UUIDs, bracket level 2
//   pink    hashes
//   slate   debug class, HTTP versions, diff headers, timezone
//   gray    comments, muted permission bits, disabled states
export const SEMANTIC_PALETTES: Record<ThemeMode, SemanticPalette> = {
  // Monokai-derived, as WindTerm's dige-black scheme is, tuned so every entry
  // clears 4.5:1 on the #1f1f1f terminal background. That matters because the
  // renderer's minimum-contrast pass would otherwise shift these hues.
  dark: {
    rose: "#ff6188",
    red: "#ff5c57",
    coral: "#ff7f50",
    orange: "#fd971f",
    amber: "#ffb454",
    yellow: "#e6db74",
    gold: "#ffd866",
    lime: "#a6e22e",
    green: "#3fd463",
    mint: "#5fd7c0",
    cyan: "#66d9ef",
    sky: "#7fb4ff",
    blue: "#6796e6",
    violet: "#ab9df2",
    purple: "#ae81ff",
    orchid: "#da70d6",
    pink: "#f78fb3",
    slate: "#8a9bb0",
    gray: "#8c8c8c",
  },
  // The same hues pulled down to 4.5:1 on white. WindTerm's own light scheme
  // uses web-color names (Plum, DarkOrange, DodgerBlue) that fall well short
  // of that, so these are darker cousins rather than copies.
  light: {
    rose: "#d6336c",
    red: "#d32f2f",
    coral: "#c93d0a",
    orange: "#b85208",
    amber: "#9a6600",
    yellow: "#8a7000",
    gold: "#9a6b00",
    lime: "#4f7d00",
    green: "#22804e",
    mint: "#0b7f70",
    cyan: "#0a7ea4",
    sky: "#1a6fd0",
    blue: "#1e5bb8",
    violet: "#6f42c1",
    purple: "#7e3fbf",
    orchid: "#b23fb2",
    pink: "#c2185b",
    slate: "#5b6b7b",
    gray: "#767676",
  },
};

/** Terminal backgrounds the bands are blended against (see XTERM_THEMES). */
const TERMINAL_BACKGROUNDS: Record<ThemeMode, string> = {
  dark: "#1f1f1f",
  light: "#ffffff",
};

interface SemanticBands {
  header: string;
  error: string;
  warn: string;
  added: string;
  removed: string;
}

/** Mixes `alpha` of `color` over `base`; xterm drops decoration alpha. */
function blend(base: string, color: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const value = Math.round(
      channel(base, i) + (channel(color, i) - channel(base, i)) * alpha,
    );
    out += value.toString(16).padStart(2, "0");
  }
  return out;
}

function bandsFor(mode: ThemeMode): SemanticBands {
  const base = TERMINAL_BACKGROUNDS[mode];
  const palette = SEMANTIC_PALETTES[mode];
  const strength = mode === "dark" ? 1 : 0.7;
  return {
    header: blend(base, palette.sky, 0.09 * strength),
    error: blend(base, palette.red, 0.13 * strength),
    warn: blend(base, palette.amber, 0.11 * strength),
    added: blend(base, palette.lime, 0.11 * strength),
    removed: blend(base, palette.red, 0.11 * strength),
  };
}

export const SEMANTIC_BANDS: Record<ThemeMode, SemanticBands> = {
  dark: bandsFor("dark"),
  light: bandsFor("light"),
};

// Mutable bindings so semanticLine picks up the active theme without every
// call site threading it through. Decorations bake the colors they were
// created with, so TerminalController rebuilds them on a theme switch.
export let SEMANTIC_COLORS: SemanticPalette = SEMANTIC_PALETTES.dark;
let BANDS: SemanticBands = SEMANTIC_BANDS.dark;

export function setSemanticColorTheme(mode: ThemeMode) {
  SEMANTIC_COLORS = SEMANTIC_PALETTES[mode];
  BANDS = SEMANTIC_BANDS[mode];
}

function gitStatusColor(status: string): string {
  if (status.includes("D")) return SEMANTIC_COLORS.red;
  if (status.includes("?")) return SEMANTIC_COLORS.cyan;
  if (status.includes("A")) return SEMANTIC_COLORS.green;
  if (status.includes("R") || status.includes("C"))
    return SEMANTIC_COLORS.violet;
  if (status.includes("U")) return SEMANTIC_COLORS.rose;
  return SEMANTIC_COLORS.amber;
}

const PERMISSION_TOKEN = /[bcdlps-][rwxStTs-]{9}[+@.]?/;
const PERMISSION_LINE = new RegExp(`^${PERMISSION_TOKEN.source}(?:\\s|$)`);
/** PowerShell's Mode column: directory, archive, read-only, hidden, system, link. */
const POWERSHELL_MODE = /(?:^|\s)(?!-{6})([dl-][a-][r-][h-][s-][l-])(?=\s)/g;
const POWERSHELL_MODE_LINE = /^(?!-{6})[dl-][a-][r-][h-][s-][l-]\s/;

function powershellModeColor(ch: string): string {
  const C = SEMANTIC_COLORS;
  switch (ch) {
    case "d":
      return C.purple;
    case "a":
      return C.sky;
    case "r":
      return C.amber;
    case "h":
      return C.slate;
    case "s":
      return C.red;
    case "l":
      return C.mint;
    default:
      return C.gray;
  }
}

/** Adds one range per run of same-colored characters in `token`. */
function addColorRuns(
  add: (start: number, end: number, color: string) => void,
  base: number,
  token: string,
  colorAt: (index: number, ch: string) => string,
) {
  let runStart = 0;
  let runColor = colorAt(0, token[0]);
  for (let i = 1; i <= token.length; i += 1) {
    const color = i < token.length ? colorAt(i, token[i]) : "";
    if (color === runColor) continue;
    add(base + runStart, base + i, runColor);
    runStart = i;
    runColor = color;
  }
}

/** Colors an `ls -l` mode string bit by bit, WindTerm style. */
function permissionBitColor(index: number, ch: string): string {
  const C = SEMANTIC_COLORS;
  if (index === 0) return ch === "-" ? C.gray : C.purple;
  if (index > 9) return C.gray;
  switch (ch) {
    case "r":
      return C.sky;
    case "w":
      return C.amber;
    case "-":
      return C.gray;
    default:
      return C.red;
  }
}

/**
 * Tokens that make up a shell prompt: `user@host:cwd$`, `[user@host cwd]$`,
 * `user@host cwd %` and the like. Group 4 is the prompt sign.
 */
const USER_PROMPT =
  /^\[?([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)(?::|\s+)([^\]$#>%❯]*?)\]?\s*([$#>%❯])(?=\s|$)/;
/**
 * Prompts without a user@host: `$ ls`, `sh-4.2$ ls`, `~ % ls`, `❯ ls`, `>>>`.
 * A bare `#` is a comment, not a root prompt, so the sign needs a prefix then.
 */
const BARE_PROMPT = /^([A-Za-z~/][\w.~/-]*\s?)?(>>>|[$#%>❯➜])(?=\s)/;
/**
 * cmd.exe and PowerShell prompts: `C:\Users\x>dir`, `PS C:\Users\x> ls`,
 * `PS /home/x> ls`, `PS> ls`. Group 1 is the `PS` tag, group 2 or 3 the path.
 */
const WINDOWS_PROMPT =
  /^(?:(PS)\s?([A-Za-z]:\\[^<>|]*?|[/~][^<>|]*?)?|([A-Za-z]:\\[^<>|]*?))>/;

/**
 * Column-header rows from ls/ps/df/kubectl/docker/netstat: three or more
 * tokens, most of them capitalized, with no punctuation that would suggest
 * prose or key/value output.
 */
function isTableHeader(text: string): boolean {
  if (/[:=,"'`]/.test(text)) return false;
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 3) return false;
  // Prose in Title Case is not a header; columns are either upper-case or
  // padded apart by runs of spaces.
  if (!/\s{2,}/.test(text.trim()) && /[a-z]/.test(text)) return false;
  let capitalized = 0;
  for (const token of tokens) {
    if (/^[%A-Z][A-Za-z0-9%/()._+-]*$/.test(token)) capitalized += 1;
    else if (!/^[a-z][a-z]{0,3}$/.test(token)) return false;
  }
  return capitalized * 3 >= tokens.length * 2;
}

/**
 * Finds useful tokens in plain, single-width terminal output. ANSI-styled cells
 * are filtered by TerminalController before these ranges become decorations.
 */
/**
 * Every range becomes an xterm decoration, and the renderer walks a row's
 * decorations for each cell it paints, so dense lines are capped: punctuation
 * classes are skipped on very long lines and no line yields more than this
 * many ranges. Rules run in priority order, so what gets dropped is the least
 * informative (operators, brackets, stray numbers).
 */
const MAX_RANGES_PER_LINE = 240;
const PUNCTUATION_MAX_LENGTH = 1000;

export function semanticLine(text: string): SemanticLine {
  const C = SEMANTIC_COLORS;
  const ranges: SemanticRange[] = [];
  let band: string | undefined;
  // First rule to claim a character wins; a bitmap keeps that O(span) instead
  // of scanning every earlier range.
  const claimed = new Uint8Array(text.length);
  const add = (
    start: number,
    end: number,
    color: string,
    underline?: boolean,
  ) => {
    if (end > text.length) end = text.length;
    if (start < 0 || end <= start) return;
    if (ranges.length >= MAX_RANGES_PER_LINE) return;
    for (let i = start; i < end; i += 1) if (claimed[i]) return;
    claimed.fill(1, start, end);
    ranges.push(underline ? { start, end, color, underline } : { start, end, color });
  };
  const addMatches = (pattern: RegExp, color: string, underline?: boolean) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) {
        add(match.index, match.index + match[0].length, color, underline);
      }
    }
  };
  const addCaptureMatches = (
    pattern: RegExp,
    capture: number,
    color: string,
  ) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || !match[capture]) continue;
      const offset = match[0].indexOf(match[capture]);
      if (offset >= 0) {
        const start = match.index + offset;
        add(start, start + match[capture].length, color);
      }
    }
  };
  const addParts = (
    match: RegExpMatchArray,
    parts: readonly (readonly [string, string])[],
  ) => {
    if (match.index === undefined) return;
    let from = match.index;
    for (const [value, color] of parts) {
      if (!value) continue;
      const start = text.indexOf(value, from);
      if (start < 0) break;
      add(start, start + value.length, color);
      from = start + value.length;
    }
  };

  // Whole-line classes first: uncolored diffs, comments, section headers and
  // table headers. ANSI-colored git output is left untouched by the
  // controller's cell-style guard.
  const startsWithUnixPermissions = PERMISSION_LINE.test(text);
  const startsWithPowershellMode = POWERSHELL_MODE_LINE.test(text);
  let wholeLine = true;
  if (/^@@(?:\s|$)/.test(text)) {
    add(0, text.length, C.cyan);
  } else if (/^\+(?!\+\+)/.test(text)) {
    add(0, text.length, C.lime);
    band = BANDS.added;
  } else if (
    /^-(?!--)/.test(text) &&
    !startsWithUnixPermissions &&
    !startsWithPowershellMode &&
    // `- item` with a single space is a YAML or Markdown list, not a removal.
    !/^- \S/.test(text)
  ) {
    add(0, text.length, C.red);
    band = BANDS.removed;
  } else if (/^(?:\+\+\+|---)\s/.test(text)) {
    add(0, text.length, C.slate);
  } else if (/^\s*(?:#!|#+(?:\s|$)|\/\/(?:\s|$))/.test(text)) {
    add(0, text.length, C.gray);
  } else if (/^\s*\[[^\]\s][^\]]*\]\s*$/.test(text)) {
    add(0, text.length, C.violet);
  } else if (isTableHeader(text)) {
    add(0, text.length, C.sky);
    band = BANDS.header;
  } else {
    wholeLine = false;
  }

  // Severity bands: only unmistakable level tokens (upper-case or a
  // compiler-style `error:` prefix) tint the whole line, so prose that merely
  // mentions an error is left alone.
  if (!band) {
    if (
      /(?:^|[\s\[(|])(?:ERROR|FATAL|PANIC|CRIT(?:ICAL)?|EMERG(?:ENCY)?|SEVERE|Traceback)\b|^\s*error(?:\[E\d+\])?:/.test(
        text,
      )
    ) {
      band = BANDS.error;
    } else if (/(?:^|[\s\[(|])WARN(?:ING)?\b|^\s*warning:/.test(text)) {
      band = BANDS.warn;
    }
  }

  // `ls -l` mode strings: type bit, then r/w/x bits each in their own hue,
  // with runs of the same color merged into one range. On a long listing the
  // owner and group columns get the prompt's user/host hues.
  for (const match of text.matchAll(
    new RegExp(`(?:^|\\s)(${PERMISSION_TOKEN.source})(?=\\s|$)`, "g"),
  )) {
    if (match.index === undefined) continue;
    const token = match[1];
    addColorRuns(add, match.index + match[0].indexOf(token), token, permissionBitColor);
  }
  for (const match of text.matchAll(POWERSHELL_MODE)) {
    if (match.index === undefined) continue;
    const token = match[1];
    addColorRuns(add, match.index + match[0].indexOf(token), token, (_, ch) =>
      powershellModeColor(ch),
    );
  }
  if (startsWithUnixPermissions) {
    const columns = /^\S+\s+\d+\s+([\w.$-]+)\s+([\w.$-]+)\s/.exec(text);
    if (columns) {
      addParts(columns, [
        [columns[1], C.lime],
        [columns[2], C.mint],
      ]);
    }
  }

  // Shell prompts: user, host, working directory and prompt sign each get a
  // distinct hue when the shell theme itself did not provide one. Everything
  // after the sign is the user's input, which is deliberately left untouched:
  // it may be half-typed (a line left behind by tab completion or Ctrl-C),
  // and the shell's own highlighting owns it anyway.
  let commandFrom = -1;
  const windowsPrompt = wholeLine ? null : WINDOWS_PROMPT.exec(text);
  const userPrompt =
    wholeLine || windowsPrompt ? null : USER_PROMPT.exec(text);
  if (windowsPrompt) {
    addParts(windowsPrompt, [
      [windowsPrompt[1] ?? "", C.mint],
      [windowsPrompt[2] ?? windowsPrompt[3] ?? "", C.yellow],
    ]);
    add(windowsPrompt[0].length - 1, windowsPrompt[0].length, C.rose);
    commandFrom = windowsPrompt[0].length;
  } else if (userPrompt) {
    addParts(userPrompt, [
      [userPrompt[1], userPrompt[1] === "root" ? C.red : C.lime],
      [userPrompt[2], C.mint],
      [userPrompt[3].trim(), C.yellow],
      [userPrompt[4], C.rose],
    ]);
    commandFrom = userPrompt[0].length;
  } else if (!wholeLine) {
    const barePrompt = BARE_PROMPT.exec(text);
    if (barePrompt && (barePrompt[1] || barePrompt[2] !== "#")) {
      const sign = barePrompt[2];
      const signStart = barePrompt[0].length - sign.length;
      if (barePrompt[1]) add(0, barePrompt[1].trimEnd().length, C.yellow);
      add(signStart, signStart + sign.length, C.rose);
      commandFrom = barePrompt[0].length;
    }
  }
  if (commandFrom >= 0) {
    claimed.fill(1, commandFrom);
    return { ranges };
  }

  // Build-tool progress verbs (cargo, npm, git, pip) at the start of a line.
  addCaptureMatches(
    /^\s*(Compiling|Checking|Building|Bundling|Downloading|Downloaded|Fetching|Cloning|Resolving|Updating|Installing|Installed|Documenting|Packaging|Uploading|Verifying|Linking|Testing|Running|Generating|Collecting|Preparing|Extracting|Pulling|Pushing|Creating|Removing|Starting|Stopping)\b/g,
    1,
    C.sky,
  );
  addCaptureMatches(/^\s*(Finished|Done|Success|Succeeded|Passed)\b/g, 1, C.green);

  // A traditional date result gets token-by-token treatment.
  const unixDate =
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([A-Z]{2,5}|[+-]\d{4})\s+(\d{4})\b/g;
  for (const match of text.matchAll(unixDate)) {
    addParts(match, [
      [match[1], C.orchid],
      [match[2], C.orchid],
      [match[3], C.purple],
      [match[4], C.green],
      [match[5], C.slate],
      [match[6], C.purple],
    ]);
  }

  // Structured data and network locations are more useful as whole tokens than
  // as a collection of independently colored numbers. Links are underlined.
  addMatches(/\b(?:https?|ftp|ssh|ws|wss):\/\/[^\s<>"']+/gi, C.sky, true);
  addMatches(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, C.cyan, true);
  addMatches(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, C.mint);
  addCaptureMatches(
    /(?:^|[^\w:])((?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)*[0-9a-f]{0,4}::(?:[0-9a-f]{0,4}:)*[0-9a-f]{0,4})(?:%[A-Za-z0-9._-]+)?)(?![\w:])/gi,
    1,
    C.mint,
  );
  addMatches(
    /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:[12]?\d|3[0-2]))?\b/g,
    C.mint,
  );
  addMatches(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    C.orchid,
  );
  addMatches(
    /\b(?:sha(?:1|224|256|384|512):)?[0-9a-f]{7,64}\b/gi,
    C.pink,
  );
  addMatches(/\b0x[0-9a-f]+\b/gi, C.purple);

  // JSON/configuration keys stay distinct from quoted values; environment
  // variables and command-line options get their own warm hues.
  addCaptureMatches(/(["'][A-Za-z_][^"']*["'])\s*:/g, 1, C.sky);
  // Quoted strings are one token, so a keyword or number inside keeps the
  // string color. Single quotes only count when they cannot be apostrophes.
  addMatches(/"(?:\\.|[^"\\])*"/g, C.gold);
  addCaptureMatches(
    /(?:^|[^\w\p{L}])('(?:\\.|[^'\\])*')(?![\w\p{L}])/gu,
    1,
    C.gold,
  );
  addMatches(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, C.coral);
  addCaptureMatches(
    /(?:^|[\s\[|])(--?[A-Za-z][\w-]*)(?=[\s=,\]]|$)/g,
    1,
    C.orange,
  );
  addCaptureMatches(
    /(?:^|[\s,{])([A-Za-z_][\w.-]*)(?=\s*=)/g,
    1,
    C.sky,
  );

  // Filesystem artifacts and common source/config filenames. `\p{L}` keeps
  // path segments and filenames whole when they contain CJK or other
  // non-ASCII letters.
  addCaptureMatches(
    /(?:^|[\s=(\[{'"])((?:~|\.{1,2})?\/(?:[\w\p{L}.@%+,-]+\/)*[\w\p{L}.@%+,-]+\/?)/gu,
    1,
    C.yellow,
  );
  addCaptureMatches(
    /(?:^|[\s=(\[{'"])(?!HTTP\/\d|(?:req|ops)\/s\b)(?=[\w\p{L}.@%+,\/-]*\p{L})((?:[\w\p{L}.@%+,-]+\/)+[\w\p{L}.@%+,-]*)/gu,
    1,
    C.yellow,
  );
  addCaptureMatches(/(?:^|\s)(~)(?=\s|$)/g, 1, C.yellow);
  addMatches(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*\b/g, C.yellow);
  addCaptureMatches(
    /(?:^|[^\w\p{L}])([\w\p{L}@+-][\w\p{L}.@+-]*\.(?:bash|c|cc|conf|cpp|css|csv|go|h|hpp|html|ini|java|js|json|jsx|lock|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml|zsh))\b/giu,
    1,
    C.yellow,
  );
  addMatches(
    /\b(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|ai|cn|co|me|info|cloud|local|internal|lan|localdomain)|localhost)\b(?![.-]\w)/gi,
    C.mint,
  );

  // HTTP requests and responses use the familiar success/redirect/client/server
  // error progression without coloring unrelated three-digit numbers.
  addMatches(
    /\b(?:CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE)\b/g,
    C.cyan,
  );
  addMatches(/\bHTTP\/\d(?:\.\d)?\b/g, C.slate);
  for (const match of text.matchAll(
    /\bHTTP\/\d(?:\.\d)?\s+([1-5]\d{2})\b/g,
  )) {
    if (match.index === undefined) continue;
    const code = match[1];
    const start = match.index + match[0].lastIndexOf(code);
    const family = Number(code[0]);
    const color =
      family === 2
        ? C.green
        : family === 3
          ? C.cyan
          : family === 4
            ? C.orange
            : family === 5
              ? C.red
              : C.gray;
    add(start, start + code.length, color);
  }

  // Git porcelain status columns.
  const gitStatus = /^([ MADRCU?!]{1,2})(?=\s+\S)/.exec(text);
  if (gitStatus?.index !== undefined && gitStatus[1].trim()) {
    add(0, gitStatus[1].length, gitStatusColor(gitStatus[1]));
  }

  // Status glyphs and annotation tags.
  addMatches(/[✓✔✅]/gu, C.green);
  addMatches(/[✗✘❌⛔🚫]/gu, C.red);
  addMatches(/⚠/gu, C.amber);
  addMatches(/[→➜➔⇒▶►]/gu, C.lime);
  addMatches(/\b(?:TODO|FIXME|XXX|HACK|BUG)\b/g, C.amber);
  addMatches(/\bNOTE\b/g, C.blue);
  addMatches(/\bSIG[A-Z]{2,8}\b/g, C.rose);

  // Log levels and lifecycle states, including Kubernetes, Docker and systemd
  // vocabulary. More severe or specific classes run first so a generic
  // success/failure rule cannot mask them. The word lists extend WindTerm's
  // lexer, so negations like "not"/"no"/"cannot" read as failures and
  // "yes"/"ok"/"valid" as successes.
  addMatches(
    /\b(?:alert|crit(?:ical)?|emerg(?:ency)?|fatal|panic|segfault|traceback|aborted|corrupt(?:ed|ion)?|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|Evicted)\b/gi,
    C.rose,
  );
  addMatches(
    /\b(?:bad|cannot|can't|couldn't|denied|error|errors|exception|fail(?:ed|ure|ures|ing)?|forbidden|incorrect|invalid|missing|no|not|refused|rejected|timeout|timed out|unable|unhealthy|unreachable|unsupported|wrong|NotReady|BackOff|Degraded)\b/gi,
    C.red,
  );
  addMatches(
    /\b(?:caution|closed|deprecated|disconnected|exited|killed|terminated|terminating|unstable|warn(?:ing)?|paused|ContainerCreating|PodInitializing|Init:\d+\/\d+)\b/gi,
    C.amber,
  );
  addMatches(
    /\b(?:pending|queued|retrying|starting|waiting|restarting|updating|creating|scheduled|in progress)\b/gi,
    C.coral,
  );
  addMatches(
    /\b(?:active|available|completed?|connected|correct|done|enabled|healthy|loaded|ok|okay|online|pass(?:ed)?|ready|running|succe(?:ss|eded|ssful|ssfully)|supported|valid|yes)\b/gi,
    C.green,
  );
  // Docker's `Up 3 hours` status, case-sensitive so prose "up" stays plain.
  addMatches(/\bUp\b/g, C.green);
  addMatches(/\b(?:debug|trace|verbose)\b/gi, C.slate);
  addMatches(
    /\b(?:info|notice|access|authentication|connection|disconnection|login|logout|password|permissions?)\b/gi,
    C.blue,
  );
  addMatches(
    /\b(?:cancelled|canceled|disabled|inactive|dead|offline|skipped|stopped|unknown)\b/gi,
    C.gray,
  );

  // Dates, times, versions and measured values.
  for (const match of text.matchAll(
    /\b(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/g,
  )) {
    addParts(match, [
      [match[1], C.orchid],
      [match[2], C.green],
    ]);
  }
  addMatches(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, C.orchid);
  addMatches(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, C.orchid);
  // `file.rs:42:17` positions are numbers, not a clock time.
  for (const match of text.matchAll(/\.\w{1,5}:(\d+)(?::(\d+))?\b/g)) {
    addParts(match, [
      [match[1], C.purple],
      [match[2] ?? "", C.purple],
    ]);
  }
  addMatches(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g,
    C.orchid,
  );
  addMatches(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, C.orchid);
  addMatches(
    /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s?[AP]M)?\b/g,
    C.green,
  );
  addMatches(
    /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g,
    C.violet,
  );
  addMatches(/\b\d+(?:\.\d+)?e[+-]?\d+\b/gi, C.purple);
  addMatches(
    /\b\d+(?:\.\d+)?\s?(?:B|GB|GiB|KB|KiB|MB|MiB|TB|TiB|[KMGTP]|bps|d|fps|h|kHz|MHz|GHz|min|ms|ns|ops|req\/s|s|µs)(?![\w])/gi,
    C.amber,
  );
  addCaptureMatches(
    /(?:^|[^\w.])([-+]?\d+(?:\.\d+)?(?:%|°[CF]?))(?![\w])/gu,
    1,
    C.amber,
  );
  addMatches(/\b(?:\d+[dhms])+(?:\d+ms)?\b/g, C.amber);
  addMatches(/\b(?:false|null|nil|none|true|undefined)\b/gi, C.purple);

  // Otherwise-unclassified numeric values: thousands separators, scientific
  // notation and negatives included.
  addMatches(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, C.purple);
  addCaptureMatches(/(?:^|[\s=(\[,])(-\d+(?:\.\d+)?)\b/g, 1, C.purple);
  addMatches(/\b\d+(?:\.\d+)?\b/g, C.purple);

  // Option values (`--level=debug`), YAML keys and HTTP header names come after
  // the value classes so a path or number keeps its own color.
  addCaptureMatches(/\s--?[\w-]+=(\S+)/g, 1, C.sky);
  addCaptureMatches(
    /^\s*(?:-\s+)?([A-Za-z_][\w.-]*)\s*:(?:\s|$)/g,
    1,
    C.sky,
  );

  // Operators and brackets last, so they only pick up punctuation nothing
  // else claimed (a `:` inside a time or a `=` inside a URL stays put).
  // Brackets cycle through three hues by nesting depth.
  if (text.length <= PUNCTUATION_MAX_LENGTH) {
    addMatches(
      /-->|<--|&&|\|\||>>|<<|=>|->|::|==|!=|<=|>=|\+=|-=|\*\*|[|;&<>=:?*!^~]/g,
      C.lime,
    );
    addCaptureMatches(/(?:^|\s)([-+])(?=\s|$)/g, 1, C.lime);
    const bracketLevels = [C.lime, C.orchid, C.blue];
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "(" || ch === "[" || ch === "{") {
        add(i, i + 1, bracketLevels[depth % bracketLevels.length]);
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth = Math.max(0, depth - 1);
        add(i, i + 1, bracketLevels[depth % bracketLevels.length]);
      }
    }
  }

  // Adjacent same-style ranges collapse into one decoration (`):` or a run of
  // permission bits), which is what keeps the renderer's per-cell decoration
  // walk short.
  ranges.sort((a, b) => a.start - b.start);
  const merged: SemanticRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.end === range.start &&
      last.color === range.color &&
      !!last.underline === !!range.underline
    ) {
      last.end = range.end;
    } else {
      merged.push(range);
    }
  }
  return band ? { ranges: merged, band } : { ranges: merged };
}

import type { ThemeMode } from "./types";

export interface SemanticRange {
  start: number;
  end: number;
  color: string;
}

type SemanticPalette = Record<
  | "rose"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "violet"
  | "magenta"
  | "pink"
  | "slate"
  | "gray",
  string
>;

// One palette per background, both drawn from VS Code's colors so semantic
// decorations read like VS Code syntax highlighting.
export const SEMANTIC_PALETTES: Record<ThemeMode, SemanticPalette> = {
  // The dark set uses VS Code's dark syntax colors (keyword blue #569cd6,
  // variable blue #9cdcfe, type teal #4ec9b0, string salmon #ce9178, number
  // green #b5cea8, function khaki #dcdcaa, control purple, charts purple),
  // its dark terminal ANSI colors, and its dark UI colors (warning #cca700,
  // muted gray #9d9d9d).
  dark: {
    rose: "#f0648c",
    red: "#f14c4c",
    orange: "#ce9178",
    amber: "#cca700",
    yellow: "#dcdcaa",
    lime: "#b5cea8",
    green: "#0dbc79",
    teal: "#4ec9b0",
    cyan: "#29b8db",
    sky: "#9cdcfe",
    blue: "#569cd6",
    violet: "#b180d7",
    magenta: "#d670d6",
    pink: "#d670b0",
    slate: "#85a0b5",
    gray: "#9d9d9d",
  },
  // The light set draws on VS Code's light palette: its terminal ANSI colors
  // (red/green/yellow/blue/magenta/cyan), its light syntax colors (teal types
  // #267f99, constant blue #0070c1, purple #652d90), and its light UI colors
  // (warning #bf8803, git-added #587c0c, muted gray #616161).
  light: {
    rose: "#ad1457",
    red: "#cd3131",
    orange: "#bc4c00",
    amber: "#bf8803",
    yellow: "#949800",
    lime: "#587c0c",
    green: "#107c10",
    teal: "#267f99",
    cyan: "#0598bc",
    sky: "#0070c1",
    blue: "#0451a5",
    violet: "#652d90",
    magenta: "#bc05bc",
    pink: "#c41d7f",
    slate: "#546e7a",
    gray: "#616161",
  },
};

// Mutable binding so semanticRanges picks up the active theme without every
// call site threading it through. Decorations bake the color they were created
// with, so TerminalController rebuilds them on a theme switch.
export let SEMANTIC_COLORS: SemanticPalette = SEMANTIC_PALETTES.dark;

export function setSemanticColorTheme(mode: ThemeMode) {
  SEMANTIC_COLORS = SEMANTIC_PALETTES[mode];
}

function gitStatusColor(status: string): string {
  if (status.includes("D")) return SEMANTIC_COLORS.red;
  if (status.includes("?")) return SEMANTIC_COLORS.cyan;
  if (status.includes("A")) return SEMANTIC_COLORS.green;
  if (status.includes("R") || status.includes("C"))
    return SEMANTIC_COLORS.violet;
  if (status.includes("U")) return SEMANTIC_COLORS.rose;
  return SEMANTIC_COLORS.yellow;
}

/**
 * Finds useful tokens in plain, single-width terminal output. ANSI-styled cells
 * are filtered by TerminalController before these ranges become decorations.
 */
export function semanticRanges(text: string): SemanticRange[] {
  const ranges: SemanticRange[] = [];
  const add = (start: number, end: number, color: string) => {
    if (start < 0 || end <= start) return;
    if (ranges.some((range) => start < range.end && end > range.start)) return;
    ranges.push({ start, end, color });
  };
  const addMatches = (pattern: RegExp, color: string) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) {
        add(match.index, match.index + match[0].length, color);
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

  // Uncolored diffs become immediately scannable. ANSI-colored git output is
  // left untouched by the controller's cell-style guard.
  const startsWithUnixPermissions = /^[bcdlps-][rwxStTs-]{9}[+@.]?(?:\s|$)/.test(
    text,
  );
  if (/^@@(?:\s|$)/.test(text)) {
    add(0, text.length, SEMANTIC_COLORS.cyan);
  } else if (/^\+(?!\+\+)/.test(text)) {
    add(0, text.length, SEMANTIC_COLORS.green);
  } else if (/^-(?!--)/.test(text) && !startsWithUnixPermissions) {
    add(0, text.length, SEMANTIC_COLORS.red);
  } else if (/^(?:\+\+\+|---)\s/.test(text)) {
    add(0, text.length, SEMANTIC_COLORS.violet);
  }
  addCaptureMatches(
    /(?:^|\s)([bcdlps-][rwxStTs-]{9}[+@.]?)(?=\s|$)/g,
    1,
    SEMANTIC_COLORS.teal,
  );

  // Shell prompts: user, host, working directory and prompt marker each get a
  // distinct hue when the shell theme itself did not provide one.
  const prompt =
    /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)(?::|\s+)([^$#>%]*?)([$#>%])(?:\s|$)/.exec(
      text,
    );
  if (prompt) {
    addParts(prompt, [
      [prompt[1], SEMANTIC_COLORS.green],
      [prompt[2], SEMANTIC_COLORS.cyan],
      [prompt[3], SEMANTIC_COLORS.blue],
      [prompt[4], SEMANTIC_COLORS.magenta],
    ]);
  }

  // A traditional date result gets token-by-token treatment.
  const unixDate =
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([A-Z]{2,5}|[+-]\d{4})\s+(\d{4})\b/g;
  for (const match of text.matchAll(unixDate)) {
    addParts(match, [
      [match[1], SEMANTIC_COLORS.cyan],
      [match[2], SEMANTIC_COLORS.magenta],
      [match[3], SEMANTIC_COLORS.yellow],
      [match[4], SEMANTIC_COLORS.green],
      [match[5], SEMANTIC_COLORS.blue],
      [match[6], SEMANTIC_COLORS.yellow],
    ]);
  }

  // Structured data and network locations are more useful as whole tokens than
  // as a collection of independently colored numbers.
  addMatches(
    /\b(?:https?|ftp|ssh|ws|wss):\/\/[^\s<>"']+/gi,
    SEMANTIC_COLORS.sky,
  );
  addMatches(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    SEMANTIC_COLORS.cyan,
  );
  addMatches(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, SEMANTIC_COLORS.pink);
  addCaptureMatches(
    /(?:^|[^\w:])((?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)*[0-9a-f]{0,4}::(?:[0-9a-f]{0,4}:)*[0-9a-f]{0,4})(?:%[A-Za-z0-9._-]+)?)(?![\w:])/gi,
    1,
    SEMANTIC_COLORS.cyan,
  );
  addMatches(
    /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:[12]?\d|3[0-2]))?\b/g,
    SEMANTIC_COLORS.cyan,
  );
  addMatches(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    SEMANTIC_COLORS.violet,
  );
  addMatches(
    /\b(?:sha(?:1|224|256|384|512):)?[0-9a-f]{7,64}\b/gi,
    SEMANTIC_COLORS.pink,
  );
  addMatches(/\b0x[0-9a-f]+\b/gi, SEMANTIC_COLORS.magenta);

  // JSON/configuration keys stay distinct from quoted values.
  addCaptureMatches(
    /(["'][A-Za-z_][^"']*["'])\s*:/g,
    1,
    SEMANTIC_COLORS.pink,
  );
  addMatches(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, SEMANTIC_COLORS.magenta);
  addCaptureMatches(
    /(?:^|\s)(--?[A-Za-z][\w-]*)\b/g,
    1,
    SEMANTIC_COLORS.violet,
  );
  addCaptureMatches(
    /(?:^|[\s,{])([A-Za-z_][\w.-]*)(?=\s*=)/g,
    1,
    SEMANTIC_COLORS.sky,
  );

  // Filesystem artifacts, permissions and common source/config filenames.
  // `\p{L}` keeps path segments and filenames whole when they contain CJK or
  // other non-ASCII letters.
  addCaptureMatches(
    /(?:^|[\s=(\[{'"])((?:~|\.{1,2})?\/(?:[\w\p{L}.@%+,:=-]+\/)*[\w\p{L}.@%+,:=-]+\/?)/gu,
    1,
    SEMANTIC_COLORS.blue,
  );
  addMatches(
    /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*\b/g,
    SEMANTIC_COLORS.blue,
  );
  addCaptureMatches(
    /(?:^|[^\w\p{L}])([\w\p{L}@+-][\w\p{L}.@+-]*\.(?:bash|c|cc|conf|cpp|css|csv|go|h|hpp|html|ini|java|js|json|jsx|lock|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml|zsh))\b/giu,
    1,
    SEMANTIC_COLORS.teal,
  );

  // HTTP requests and responses use the familiar success/redirect/client/server
  // error progression without coloring unrelated three-digit numbers.
  addMatches(
    /\b(?:CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT|TRACE)\b/g,
    SEMANTIC_COLORS.blue,
  );
  addMatches(/\bHTTP\/\d(?:\.\d)?\b/g, SEMANTIC_COLORS.sky);
  for (const match of text.matchAll(
    /\bHTTP\/\d(?:\.\d)?\s+([1-5]\d{2})\b/g,
  )) {
    if (match.index === undefined) continue;
    const code = match[1];
    const start = match.index + match[0].lastIndexOf(code);
    const family = Number(code[0]);
    const color =
      family === 2
        ? SEMANTIC_COLORS.green
        : family === 3
          ? SEMANTIC_COLORS.cyan
          : family === 4
            ? SEMANTIC_COLORS.orange
            : family === 5
              ? SEMANTIC_COLORS.red
              : SEMANTIC_COLORS.gray;
    add(start, start + code.length, color);
  }

  // Git porcelain status columns.
  const gitStatus = /^([ MADRCU?!]{1,2})(?=\s+\S)/.exec(text);
  if (gitStatus?.index !== undefined && gitStatus[1].trim()) {
    add(0, gitStatus[1].length, gitStatusColor(gitStatus[1]));
  }

  // Log levels and lifecycle states. More severe or specific classes run first
  // so a generic success/failure rule cannot mask them.
  addMatches(
    /\b(?:alert|crit(?:ical)?|emerg(?:ency)?|fatal|panic|segfault|traceback|aborted|corrupt(?:ed|ion)?)\b/gi,
    SEMANTIC_COLORS.rose,
  );
  addMatches(
    /\b(?:denied|error|exception|fail(?:ed|ure)?|forbidden|invalid|rejected|timeout|unreachable)\b/gi,
    SEMANTIC_COLORS.red,
  );
  addMatches(
    /\b(?:caution|deprecated|unstable|warn(?:ing)?)\b/gi,
    SEMANTIC_COLORS.amber,
  );
  addMatches(
    /\b(?:pending|queued|retrying|starting|waiting)\b/gi,
    SEMANTIC_COLORS.orange,
  );
  addMatches(
    /\b(?:active|connected|done|healthy|ok|online|passed|ready|running|success(?:ful|fully)?|succeeded)\b/gi,
    SEMANTIC_COLORS.lime,
  );
  addMatches(
    /\b(?:debug|trace|verbose)\b/gi,
    SEMANTIC_COLORS.slate,
  );
  addMatches(/\b(?:info|notice)\b/gi, SEMANTIC_COLORS.sky);
  addMatches(
    /\b(?:cancelled|canceled|disabled|inactive|offline|skipped|stopped|unknown)\b/gi,
    SEMANTIC_COLORS.gray,
  );

  // Dates, times, versions and measured values.
  addMatches(/\b\d{4}-\d{2}-\d{2}\b/g, SEMANTIC_COLORS.magenta);
  addMatches(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g,
    SEMANTIC_COLORS.magenta,
  );
  addMatches(
    /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    SEMANTIC_COLORS.green,
  );
  addMatches(
    /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g,
    SEMANTIC_COLORS.violet,
  );
  addMatches(
    /\b\d+(?:\.\d+)?\s?(?:B|GB|GiB|KB|KiB|MB|MiB|TB|TiB|bps|d|fps|h|kHz|MHz|GHz|min|ms|ns|ops|req\/s|s|µs)(?![\w])/gi,
    SEMANTIC_COLORS.yellow,
  );
  addMatches(/\b\d+(?:\.\d+)?%(?![\w])/g, SEMANTIC_COLORS.yellow);
  addMatches(
    /\b(?:false|null|nil|none|true|undefined)\b/gi,
    SEMANTIC_COLORS.violet,
  );

  // Quoted values and finally otherwise-unclassified numeric values.
  addMatches(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    SEMANTIC_COLORS.green,
  );
  addMatches(/\b\d+(?:\.\d+)?\b/g, SEMANTIC_COLORS.yellow);

  return ranges.sort((a, b) => a.start - b.start);
}

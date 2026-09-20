/**
 * serialX's semantic coloring, ported from that project's `src/highlight.rs`
 * so its two themes bring their own reading of a line, not just their colors.
 *
 * Where the WindTerm-derived engine in `semanticColors.ts` names a token and
 * paints it whole, this one reads a line the way `tailspin` does: an ordered
 * list of patterns, each claiming the characters it recognizes that no
 * earlier pattern has, down to the parts of a token — the digits, letters and
 * separators of an address, a value and its unit, the bits of a mode string.
 * A late pattern fills in around the early ones, which is how the number
 * inside a quoted string keeps its own color while the quotes take theirs.
 *
 * Two things do not survive the trip. Decorations are overlays above glyphs
 * the renderer has already drawn, so the weights serialX sets (a level in
 * bold, a unit in italic) cannot be applied here; only color, the underline
 * and the pill ground carry over. And serialX tints no whole lines, so the
 * severity bands of the other engine are absent by design.
 */
import type { SemanticLine, SemanticRange } from "./semanticColors";
import { isLightTheme, type ThemeMode } from "./types";

/** How a role is drawn: a color per canvas, with the few extras we can draw. */
interface Ink {
  dark: string;
  light: string;
  /** A ground in both themes, for the roles set as a pill. */
  ground?: readonly [string, string];
  underlined?: boolean;
}

const ink = (dark: string, light: string): Ink => ({ dark, light });
const underlined = (base: Ink): Ink => ({ ...base, underlined: true });
/** Set on a ground of `ground`'s color: a pill. */
const on = (base: Ink, ground: Ink): Ink => ({
  ...base,
  ground: [ground.dark, ground.light],
});

// The wheel the roles are painted from, a dark and a light reading of each
// hue: the dark ones sit on the terminal's near-black, the light ones on
// white, and each pair reads as the same color across the switch. Hues step
// around the circle finely enough that neighbours in a line — a value and its
// unit, a host and its path — are never the same family.
const RED = ink("#ff6b6b", "#c62828");
const CORAL = ink("#ff8a80", "#d84a3a");
const ORANGE = ink("#ff9f5a", "#c65a10");
const PEACH = ink("#ffb08a", "#c66a2b");
const AMBER = ink("#ffb454", "#b45f06");
const SAFFRON = ink("#ffd166", "#a37b00");
const GOLD = ink("#f0c674", "#a8730f");
const SAND = ink("#e0b070", "#9c6f1d");
const LIME = ink("#b8e05a", "#6a8f0e");
const CHARTREUSE = ink("#c3e88d", "#5c8a12");
const GREEN = ink("#5be49b", "#1f8a4c");
const MINT = ink("#8ee6b0", "#2e9e6a");
const TEAL = ink("#4fd1c5", "#0f8a8a");
const AQUA = ink("#6fdccf", "#0f8f83");
const CYAN = ink("#5fd1d8", "#1a8a96");
const SKY = ink("#7dc4ff", "#1a6fc0");
const BLUE = ink("#7aa2f7", "#2f6fd6");
const STEEL = ink("#82aaff", "#3b6fd1");
const PERIWINKLE = ink("#9aa5ff", "#4b5ccf");
const INDIGO = ink("#8b87ff", "#5b57d8");
const VIOLET = ink("#b48cff", "#6f42c1");
const LILAC = ink("#c8a2ff", "#7e57c2");
const ORCHID = ink("#d18aff", "#8e24aa");
const MAGENTA = ink("#e08ae8", "#a03cb8");
const PINK = ink("#ff8ad0", "#c2409c");
const ROSE = ink("#ff8fa3", "#c2185b");
const GREY = ink("#6b7385", "#8a8f9c");
const DIM = ink("#5d6475", "#a0a4ad");
const SILVER = ink("#9aa3b5", "#6b7280");
const WHITE = ink("#c8cdd8", "#3b3b42");
/** The page itself, for text set on a colored ground. */
const PAGE = ink("#0b0d11", "#ffffff");

/**
 * What a stretch of a line is, as far as color is concerned. The roles are
 * finer than a reader would name them — an address is its digits, its letters
 * and its separators — because that is where the color goes.
 */
const ROLE_INK = {
  // Severity keeps the colors every log reader has learnt.
  error: RED,
  warning: AMBER,
  info: SKY,
  debug: VIOLET,
  trace: GREY,
  success: GREEN,
  // Literals that mean yes and no.
  true: MINT,
  null: ROSE,
  // Time is the blue-to-purple quarter: the date warm, the clock cool, the
  // zone a flag on the end.
  date: ORCHID,
  time: BLUE,
  zone: CORAL,
  timeSeparator: DIM,
  /** A time since boot: the kernel's `[    1.234567]`, ESP-IDF's `(1234)`. */
  uptime: PERIWINKLE,
  // Quantities: a value in a cool color, its unit a warm one, so `350ms`
  // reads as two things.
  number: CYAN,
  percent: SAFFRON,
  duration: BLUE,
  durationUnit: MAGENTA,
  size: AQUA,
  sizeUnit: PEACH,
  measure: CHARTREUSE,
  measureUnit: SAND,
  version: LIME,
  // Addresses: digits and letters in two colors so a hex word shows its
  // shape, separators in a third so the grouping does.
  hexPrefix: CORAL,
  hexDigit: STEEL,
  hexLetter: LILAC,
  hexByte: TEAL,
  ipDigit: STEEL,
  ipLetter: ORCHID,
  ipSeparator: CORAL,
  macDigit: AQUA,
  macLetter: LILAC,
  macSeparator: DIM,
  uuidDigit: PERIWINKLE,
  uuidLetter: MAGENTA,
  uuidSeparator: DIM,
  // Places.
  urlScheme: TEAL,
  urlHost: underlined(STEEL),
  urlPath: PERIWINKLE,
  queryKey: ORCHID,
  queryValue: CYAN,
  urlSymbol: SILVER,
  emailName: underlined(GREEN),
  emailSymbol: CORAL,
  emailDomain: underlined(GREEN),
  pathSegment: GREEN,
  pathSeparator: GOLD,
  /** `main.c` in `main.c:42`. */
  sourceFile: GOLD,
  lineNumber: CYAN,
  // Structure is quiet — keys, brackets and punctuation step back so the
  // values they frame step forward.
  processName: PEACH,
  processId: CYAN,
  processBracket: CORAL,
  /** A module or component name: `wifi:` in ESP-IDF, `[main]` in a log. */
  tag: TEAL,
  tagBracket: DIM,
  key: SILVER,
  keySeparator: WHITE,
  jsonKey: STEEL,
  punctuation: DIM,
  quote: SAND,
  // The device's own words.
  /** An AT command or its unsolicited reply: `AT+CWJAP`, `+CWJAP:`. */
  command: ORANGE,
  /** A peripheral or pin: `GPIO12`, `UART1`, `PA0`. */
  peripheral: PINK,
  checksum: INDIGO,
  /** A name in capitals: an error code, a state, a define. */
  constant: GOLD,
  // HTTP methods are pills: the page's ink on a ground that says what the
  // request does, green to read and red to remove.
  httpGet: on(PAGE, GREEN),
  httpPost: on(PAGE, AMBER),
  httpPut: on(PAGE, VIOLET),
  httpDelete: on(PAGE, RED),
  httpOther: on(PAGE, BLUE),
  // A listing keeps the colors `ls` itself would use, so a directory is the
  // blue it has always been; the mode string is read a letter at a time, as
  // `eza` sets it.
  directory: BLUE,
  symlink: TEAL,
  executable: GREEN,
  fileName: WHITE,
  /** A block or character device, a pipe, a socket. */
  special: MAGENTA,
  permRead: SAFFRON,
  permWrite: CORAL,
  permExec: GREEN,
  user: GOLD,
  group: SAND,
  host: STEEL,
  /** The `$` or `#` a shell waits with. */
  prompt: ORANGE,
  /** A command-line switch: `-la`, `--color`. */
  flag: PINK,
};

export type Role = keyof typeof ROLE_INK;

// Which canvas the roles are read on. Like the other engine's palette this is
// a module-level binding so callers do not thread the theme through.
let ON_PAPER = false;

export function setSerialxTheme(mode: ThemeMode) {
  ON_PAPER = isLightTheme(mode);
}

const inkColor = (value: Ink): string => (ON_PAPER ? value.light : value.dark);
const groundColor = (value: Ink): string | undefined =>
  value.ground && (ON_PAPER ? value.ground[1] : value.ground[0]);

/** How a matched stretch is colored. */
type Fill =
  /** One role throughout. */
  | { kind: "solid"; role: Role }
  /**
   * Digits, letters and everything else each their own role: how an address
   * is read, by the shape of its parts.
   */
  | { kind: "split"; digit: Role; letter: Role; other: Role }
  /** Text broken by delimiter characters, the two in their own roles. */
  | { kind: "delimited"; text: Role; delimiter: Role; delimiters: string }
  /** A URL query: `key=value&key=value`. */
  | { kind: "query" }
  /** A severity word, read to find which level it names. */
  | { kind: "level" }
  /**
   * A mode string, `drwxr-xr-x`: the type letter by what it is, then read,
   * write and execute each in their own color.
   */
  | { kind: "permissions" };

const solid = (role: Role): Fill => ({ kind: "solid", role });
const split = (digit: Role, letter: Role, other: Role): Fill => ({
  kind: "split",
  digit,
  letter,
  other,
});
const delimited = (text: Role, delimiter: Role, delimiters: string): Fill => ({
  kind: "delimited",
  text,
  delimiter,
  delimiters,
});
const QUERY: Fill = { kind: "query" };
const LEVEL: Fill = { kind: "level" };
const PERMISSIONS: Fill = { kind: "permissions" };

/** The level a severity word names, whichever log format spelt it. */
function levelRole(word: string): Role {
  switch (word.toLowerCase()) {
    case "e":
    case "err":
    case "error":
    case "fatal":
    case "critical":
    case "crit":
    case "panic":
    case "fail":
    case "failed":
    case "failure":
    case "assert":
    case "exception":
    case "traceback":
    case "emerg":
    case "alert":
      return "error";
    case "w":
    case "wrn":
    case "warn":
    case "warning":
      return "warning";
    case "i":
    case "inf":
    case "info":
    case "notice":
      return "info";
    case "d":
    case "dbg":
    case "debug":
      return "debug";
    case "v":
    case "trace":
    case "verbose":
      return "trace";
    default:
      return "success";
  }
}

/**
 * Gives the unclaimed characters of `segment`, which begins at index `start`
 * of the line, the roles this fill hands out.
 */
function applyFill(
  fill: Fill,
  segment: string,
  start: number,
  owner: (Role | null)[],
) {
  const level = fill.kind === "level" ? levelRole(segment) : null;
  let inValue = false;
  for (let offset = 0; offset < segment.length; offset += 1) {
    const ch = segment[offset];
    let role: Role;
    switch (fill.kind) {
      case "solid":
        role = fill.role;
        break;
      case "split":
        role = /[0-9]/.test(ch)
          ? fill.digit
          : /[A-Za-z]/.test(ch)
            ? fill.letter
            : fill.other;
        break;
      case "delimited":
        role = fill.delimiters.includes(ch) ? fill.delimiter : fill.text;
        break;
      case "query":
        if (ch === "&") {
          inValue = false;
          role = "urlSymbol";
        } else if (ch === "=" && !inValue) {
          inValue = true;
          role = "urlSymbol";
        } else {
          role = inValue ? "queryValue" : "queryKey";
        }
        break;
      case "level":
        role = level ?? "info";
        break;
      case "permissions":
        if (offset === 0) {
          role =
            ch === "d"
              ? "directory"
              : ch === "l"
                ? "symlink"
                : ch === "-"
                  ? "punctuation"
                  : "special";
        } else if (offset <= 9) {
          role =
            ch === "r"
              ? "permRead"
              : ch === "w"
                ? "permWrite"
                : "xsStT".includes(ch)
                  ? "permExec"
                  : "punctuation";
        } else {
          role = "punctuation";
        }
        break;
    }
    if (owner[start + offset] === null) owner[start + offset] = role;
  }
}

/**
 * One thing to look for, and how to color what is found. A null name means
 * the whole match, a string one of its named groups; fills are applied in
 * order, so a group listed before the whole match takes its characters first.
 */
interface Pattern {
  regex: RegExp;
  fills: readonly (readonly [string | null, Fill])[];
}

// `d` gives every named group its own start and end, which is the whole point
// of splitting a match into parts; `g` is what matchAll needs.
const pattern = (
  source: string,
  fills: readonly (readonly [string | null, Fill])[],
  flags = "",
): Pattern => ({ regex: new RegExp(source, `gd${flags}`), fills });

/** The whole match in one fill. */
const whole = (source: string, fill: Fill, flags = ""): Pattern =>
  pattern(source, [[null, fill]], flags);

/** Each named group in its own fill; what lies between them is left alone. */
const parts = (
  source: string,
  fills: readonly (readonly [string, Fill])[],
  flags = "",
): Pattern => pattern(source, fills, flags);

const TIME_FILL = delimited("time", "timeSeparator", ":.,");
const dateFill = (delimiters: string) =>
  delimited("date", "timeSeparator", delimiters);
const pathFill = (delimiters: string) =>
  delimited("pathSegment", "pathSeparator", delimiters);
const IP_FILL = split("ipDigit", "ipLetter", "ipSeparator");

// The columns of `ls -l` after the mode: link count, owner, group, size (or a
// device's major and minor), then the date as GNU, BusyBox, macOS or a
// localised `ls` prints it, with a clock or a year after it.
const LS_COLUMNS =
  "\\s+(?<links>\\d+)\\s+(?<user>[\\w.$-]+)\\s+(?<group>[\\w.$-]+)\\s+" +
  "(?<size>\\d+,\\s+\\d+|\\d[\\d,.]*[KMGTPE]?i?B?)\\s+" +
  "(?<date>[^\\s\\d]{1,9}\\.? {1,2}\\d{1,2}|\\d{1,2}月 {1,2}\\d{1,2}日?|\\d{4}-\\d{2}-\\d{2})\\s+" +
  "(?:(?<time>\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?)|(?<year>\\d{4}))(?: (?<zone>[+-]\\d{4}))?\\s+";

const LS_FILLS: readonly (readonly [string, Fill])[] = [
  ["perm", PERMISSIONS],
  ["links", solid("number")],
  ["user", solid("user")],
  ["group", solid("group")],
  ["size", solid("size")],
  ["date", solid("date")],
  ["time", TIME_FILL],
  ["year", solid("date")],
  ["zone", solid("zone")],
];

// One pattern per kind of entry, so the name takes the color of what it is;
// the last catches whatever the first three did not.
const listing = (
  mode: string,
  name: string,
  fills: readonly (readonly [string, Fill])[],
): Pattern =>
  parts(`^(?<perm>${mode}[.+@]?)${LS_COLUMNS}${name}$`, [
    ...LS_FILLS,
    ...fills,
  ]);

const PROMPT_FILLS: readonly (readonly [string, Fill])[] = [
  ["user", solid("user")],
  ["at", solid("emailSymbol")],
  ["host", solid("host")],
  ["colon", solid("punctuation")],
  ["path", pathFill("/")],
  ["sigil", solid("prompt")],
];

/**
 * The patterns, in the order they get to claim characters. Places come first
 * so a word inside a path or URL stays part of it; then the device's own
 * vocabulary and the keys of `key=value` pairs, which are what they are
 * whatever word they use; then the words that say how a line went; addresses
 * before times, because the tail of a MAC address looks like a clock; then
 * quantities; and last the numbers, punctuation and quotes that fill in
 * around everything else.
 */
const PATTERNS: readonly Pattern[] = [
  // ---- A shell's listings ------------------------------------------------
  listing("l[-rwxsStT]{9}", "(?<name>.+?) (?<arrow>->) (?<target>.+)", [
    ["name", solid("symlink")],
    ["arrow", solid("punctuation")],
    ["target", pathFill("/")],
  ]),
  listing("d[-rwxsStT]{9}", "(?<name>.+)", [["name", solid("directory")]]),
  listing("-[-rw]{2}[xs][-rwxsStT]{6}", "(?<name>.+)", [
    ["name", solid("executable")],
  ]),
  listing("[-dlbcps][-rwxsStT]{9}", "(?<name>.+)", [
    ["name", solid("fileName")],
  ]),
  // A mode string on its own, from `find -ls`, `stat` or `tar tv`.
  parts("(?:^|\\s)(?<perm>[-dlbcps][-rwxsStT]{9}[.+@]?)(?:\\s|$)", [
    ["perm", PERMISSIONS],
  ]),
  // The prompt a shell waits with: `user@host:~/dir$` or `[user@host dir]#`.
  parts(
    "^(?<user>[\\w.-]+)(?<at>@)(?<host>[\\w.-]+)(?<colon>:)(?<path>[~/][^\\s$#]*)?\\s?(?<sigil>[$#])(?:\\s|$)",
    PROMPT_FILLS,
  ),
  parts(
    "^\\[(?<user>[\\w.-]+)(?<at>@)(?<host>[\\w.-]+) (?<path>[^\\]]+)\\](?<sigil>[$#])(?:\\s|$)",
    PROMPT_FILLS,
  ),
  // ---- Places -------------------------------------------------------------
  parts(
    "\\b(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*)(?<colon>://)(?<host>[^\\s/?#\"'<>()\\[\\]]+)(?<path>/[^\\s?#\"'<>()\\[\\]]*)?(?:(?<question>\\?)(?<query>[^\\s#\"'<>()\\[\\]]*))?",
    [
      ["scheme", solid("urlScheme")],
      ["colon", solid("urlSymbol")],
      ["host", delimited("urlHost", "urlSymbol", ":")],
      ["path", delimited("urlPath", "urlSymbol", "/")],
      ["question", solid("urlSymbol")],
      ["query", QUERY],
    ],
  ),
  parts("\\b(?<name>[\\w.+-]+)(?<at>@)(?<domain>[\\w-]+(?:\\.[\\w-]+)+)\\b", [
    ["name", solid("emailName")],
    ["at", solid("emailSymbol")],
    ["domain", delimited("emailDomain", "emailSymbol", ".")],
  ]),
  // `main.c:42` — where an assert or a panic says it happened.
  parts(
    "\\b(?<file>[\\w-]+\\.(?:c|h|cc|cpp|cxx|hpp|hh|rs|py|js|ts|go|java|kt|swift|m|mm|lua|sh|ino|s|S|asm|ld|v|sv))(?<colon>:)(?<line>\\d+)\\b",
    [
      ["file", solid("sourceFile")],
      ["colon", solid("punctuation")],
      ["line", solid("lineNumber")],
    ],
  ),
  whole(
    "\\b[A-Za-z]:\\\\(?:[^\\\\\\s\"'<>|*?]+\\\\)*[^\\\\\\s\"'<>|*?]*",
    pathFill(":\\"),
  ),
  // A Unix path has to start a word: `ERROR/WARN` is not one.
  parts(
    "(?:^|[\\s\"'`(\\[<=,;:])(?<path>(?:~|\\.{1,2})?(?:/[\\w.@+~%-]+)+/?)",
    [["path", pathFill("/")]],
  ),
  // ---- The device's own words ---------------------------------------------
  whole("\\bAT(?:[+#$&%][A-Za-z0-9_]*|[A-Z][A-Z0-9]{0,4})?\\b", solid("command")),
  whole("^\\+[A-Z][A-Z0-9_]*:?", solid("command")),
  whole(
    "\\b(?:GPIO|IO|PIN|EXTI|P[A-K]|D|A)\\d{1,2}\\b|\\b(?:UART|USART|LPUART|SPI|QSPI|I2C|I2S|TIM|TIMER|ADC|DAC|DMA|CAN|FDCAN|USB|OTG|PWM|RTC|WDT|IWDG|WWDG|SDIO|SDMMC|FMC|ETH|MAC|PHY|CORE|CPU|IRQ|NVIC|FLASH|SRAM|PSRAM|EEPROM|NVS|SPIFFS|LittleFS|FATFS)\\d{0,2}\\b",
    solid("peripheral"),
  ),
  whole(
    "\\b(?:CRC|CRC8|CRC16|CRC32|crc|crc8|crc16|crc32|[Cc]hecksum|CHECKSUM|chksum|cksum|LRC|FCS|MD5|md5|SHA1|SHA256|SHA-256|sha256|[Hh]ash|HASH|XOR)\\b",
    solid("checksum"),
  ),
  whole("\\bGET\\b", solid("httpGet")),
  whole("\\bPOST\\b", solid("httpPost")),
  whole("\\b(?:PUT|PATCH)\\b", solid("httpPut")),
  whole("\\bDELETE\\b", solid("httpDelete")),
  whole("\\b(?:HEAD|OPTIONS|CONNECT)\\b", solid("httpOther")),
  // A switch on a command line: `-la`, `--color`. Before keys, so
  // `--color=auto` is a switch with a value rather than a key.
  parts("(?:^|\\s)(?<flag>--?[A-Za-z][\\w-]*)", [["flag", solid("flag")]]),
  // A key is a key whatever it is called: `err=null` and `"err": null` both
  // name a field.
  parts("\\b(?<key>[A-Za-z_][\\w.-]*)(?<eq>=)", [
    ["key", solid("key")],
    ["eq", solid("keySeparator")],
  ]),
  parts('(?<open>")(?<key>[^"]+)(?<close>")\\s*(?<colon>:)', [
    ["open", solid("punctuation")],
    ["key", solid("jsonKey")],
    ["close", solid("punctuation")],
    ["colon", solid("punctuation")],
  ]),
  // A name in capitals with an underscore in it is a code, a state, a define:
  // `ESP_ERR_INVALID_STATE`, `WL_CONNECTED`.
  whole("\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b", solid("constant")),
  // ---- How the line went --------------------------------------------------
  // ESP-IDF: `I (1234) wifi: connected`.
  parts("^(?<level>[EWIDV]) \\((?<uptime>\\d+)\\)(?: (?<tag>[\\w.:/-]+):)?", [
    ["level", LEVEL],
    ["uptime", solid("uptime")],
    ["tag", solid("tag")],
  ]),
  // Zephyr: `[00:00:01.234,567] <inf> main: Hello`.
  parts(
    "^(?:(?<open>\\[)(?<uptime>\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(?:,\\d{3})?)(?<close>\\]) )?(?<lt><)(?<level>err|wrn|inf|dbg)(?<gt>>)(?: (?<tag>[\\w.:/-]+):)?",
    [
      ["open", solid("tagBracket")],
      ["close", solid("tagBracket")],
      ["lt", solid("tagBracket")],
      ["gt", solid("tagBracket")],
      ["uptime", delimited("uptime", "timeSeparator", ":.,")],
      ["level", LEVEL],
      ["tag", solid("tag")],
    ],
  ),
  parts(
    "\\b(?<level>error|err|fatal|critical|crit|panic|fail|failed|failure|assert|exception|traceback|emerg|alert|warning|warn|info|notice|debug|dbg|verbose|trace)\\b",
    [["level", LEVEL]],
    "i",
  ),
  whole(
    "\\b(?:Guru Meditation Error|Backtrace|Segmentation fault|[Ss]tack overflow|Assertion failed|assert failed|[Cc]ore dump|Hard[Ff]ault|BusFault|UsageFault|MemManage|Rebooting|No such file or directory|Permission denied|command not found|Connection refused|Operation not permitted|Input/output error|Device or resource busy|not found)\\b|abort\\(\\)",
    solid("error"),
  ),
  whole(
    "\\b(?:[Ww]atchdog|WDT|[Bb]rownout|[Rr]etry(?:ing)?|[Tt]imeout|[Tt]imed out|[Dd]isconnected|[Ll]ost|[Dd]eprecated)\\b",
    solid("warning"),
  ),
  whole(
    "\\b(?:OK|SUCCESS|SUCCEEDED|PASS|PASSED|DONE|READY|CONNECTED|ONLINE|Success|Succeeded|Passed|Done|Ready|Connected|Online|success|succeeded|connected|ready|done)\\b",
    solid("success"),
  ),
  whole("\\b(?:true|TRUE|True|yes|YES|Yes|enabled|ENABLED|Enabled)\\b", solid("true")),
  whole(
    "\\b(?:false|FALSE|False|null|NULL|Null|nil|NIL|None|none|NONE|NaN|undefined|nullptr|disabled|DISABLED|Disabled)\\b",
    solid("null"),
  ),
  // ---- Addresses ----------------------------------------------------------
  // Before times: the tail of a MAC address looks like a clock.
  whole(
    "\\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b",
    split("macDigit", "macLetter", "macSeparator"),
  ),
  whole(
    "\\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\\b|\\b(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}\\b|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}\\b",
    IP_FILL,
    "i",
  ),
  whole("\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b", IP_FILL),
  whole(
    "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
    split("uuidDigit", "uuidLetter", "uuidSeparator"),
    "i",
  ),
  // `0x` after its digits, so the prefix is what is left for it.
  pattern("\\b0[xX](?<digits>[0-9a-fA-F]+)\\b", [
    ["digits", split("hexDigit", "hexLetter", "hexLetter")],
    [null, solid("hexPrefix")],
  ]),
  // ---- When ---------------------------------------------------------------
  parts(
    "\\b(?<date>\\d{4}[-/]\\d{2}[-/]\\d{2})(?:(?<t>[T ])(?<time>\\d{2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,9})?)(?<zone>Z|[+-]\\d{2}:?\\d{2})?)?\\b",
    [
      ["date", dateFill("-/")],
      ["t", solid("timeSeparator")],
      ["time", TIME_FILL],
      ["zone", solid("zone")],
    ],
  ),
  parts("\\b(?<date>\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4})\\b", [
    ["date", dateFill("/.-")],
  ]),
  whole(
    "\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* {1,2}\\d{1,2}(?:,? \\d{4})?\\b",
    solid("date"),
  ),
  // The kernel's seconds since boot: `[    1.234567] usb 1-1: ...`.
  parts("^(?<open>\\[)(?<uptime>\\s*\\d+\\.\\d{3,6})(?<close>\\])", [
    ["open", solid("tagBracket")],
    ["uptime", solid("uptime")],
    ["close", solid("tagBracket")],
  ]),
  parts(
    "\\b(?<time>\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,9})?)(?<zone>Z|[+-]\\d{2}:?\\d{2}| ?(?:UTC|GMT))?\\b",
    [
      ["time", TIME_FILL],
      ["zone", solid("zone")],
    ],
  ),
  // A dump of bytes: after times, since `10:20:30` is also three pairs of hex
  // digits. Separated by spaces or by colons, never a mixture: `19 17:15` in
  // a listing is a date and a clock, not three bytes.
  whole(
    "\\b(?:[0-9A-Fa-f]{2} ){2,}[0-9A-Fa-f]{2}\\b|\\b(?:[0-9A-Fa-f]{2}[:-]){2,}[0-9A-Fa-f]{2}\\b",
    split("hexByte", "hexLetter", "punctuation"),
  ),
  // ---- Who is talking -----------------------------------------------------
  parts("\\b(?<name>[A-Za-z_][\\w.-]*)(?<open>\\[)(?<pid>\\d+)(?<close>\\])", [
    ["name", solid("processName")],
    ["open", solid("processBracket")],
    ["pid", solid("processId")],
    ["close", solid("processBracket")],
  ]),
  parts("(?<open>\\[)(?<tag>[A-Za-z_][\\w:./ -]{0,31}?)(?<close>\\])", [
    ["open", solid("tagBracket")],
    ["tag", solid("tag")],
    ["close", solid("tagBracket")],
  ]),
  parts("^(?<tag>[A-Za-z_][\\w./-]{0,31}):(?:\\s|$)", [["tag", solid("tag")]]),
  // ---- How much -----------------------------------------------------------
  parts(
    "\\b(?<value>\\d+(?:\\.\\d+)?)(?<unit>ns|us|µs|μs|ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days?)\\b",
    [
      ["value", solid("duration")],
      ["unit", solid("durationUnit")],
    ],
  ),
  parts(
    "\\b(?<value>\\d+(?:\\.\\d+)?) ?(?<unit>B|KB|kB|KiB|MB|MiB|GB|GiB|TB|TiB|[Bb]ytes?|kb|mb|gb|Kb|Mb)\\b",
    [
      ["value", solid("size")],
      ["unit", solid("sizeUnit")],
    ],
  ),
  parts(
    "(?<value>-?\\b\\d+(?:\\.\\d+)?) ?(?<unit>Hz|kHz|KHz|MHz|GHz|mV|uV|V|uA|mA|A|mW|W|kW|dBm|dB|°C|℃|°F|C|F|K|bps|kbps|Mbps|Gbps|baud|Ω|ohm|kΩ|mAh|Wh|mWh|lux|hPa|kPa|Pa|bar|rpm|RPM|%RH|RH|ppm|ppb|deg|rad|mm|cm|km|kg|mg)\\b",
    [
      ["value", solid("measure")],
      ["unit", solid("measureUnit")],
    ],
  ),
  whole("-?\\b\\d+(?:\\.\\d+)?%", solid("percent")),
  whole("\\b[vV]?\\d+\\.\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][\\w.]+)?\\b", solid("version")),
  // ---- Structure ----------------------------------------------------------
  whole("-?\\b\\d+(?:\\.\\d+)?\\b", solid("number")),
  whole("[{}\\[\\]]", solid("punctuation")),
  // Quotes come last and fill in around what is already colored, so the
  // number inside a string keeps its color and the string its own.
  whole('"[^"]*"', solid("quote")),
  whole("`[^`]+`", solid("quote")),
];

/**
 * A match with the per-group offsets the `d` flag adds. It is ES2022 and the
 * tsconfig's lib stops at ES2020, so the shape is spelt out here rather than
 * widening the lib for one property.
 */
interface IndexedMatch {
  indices?: { groups?: Record<string, [number, number] | undefined> };
}

/** The role of each character of `text`, null where it is plain. */
export function serialxRoles(text: string): (Role | null)[] {
  const owner: (Role | null)[] = new Array(text.length).fill(null);
  if (!text) return owner;
  for (const { regex, fills } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const groups = (match as IndexedMatch).indices?.groups;
      for (const [name, fill] of fills) {
        let start: number;
        let end: number;
        if (name === null) {
          start = match.index;
          end = start + match[0].length;
        } else {
          const span = groups?.[name];
          if (!span) continue;
          [start, end] = span;
        }
        applyFill(fill, text.slice(start, end), start, owner);
      }
    }
  }
  return owner;
}

/**
 * Every range becomes a decoration and the renderer walks a row's decorations
 * for each cell it paints, so a line that splits into more than this — a long
 * hex dump reads two characters at a time — gives up the tail rather than the
 * frame rate. The same cap the other engine uses.
 */
const MAX_RANGES_PER_LINE = 240;

/** A line read serialX's way: runs of one role, each in that role's ink. */
export function serialxLine(text: string): SemanticLine {
  const owner = serialxRoles(text);
  const ranges: SemanticRange[] = [];
  let start = 0;
  while (start < owner.length && ranges.length < MAX_RANGES_PER_LINE) {
    const role = owner[start];
    let end = start + 1;
    while (end < owner.length && owner[end] === role) end += 1;
    if (role) {
      const style = ROLE_INK[role];
      const range: SemanticRange = { start, end, color: inkColor(style) };
      if (style.underlined) range.underline = true;
      const ground = groundColor(style);
      if (ground) range.background = ground;
      ranges.push(range);
    }
    start = end;
  }
  return { ranges };
}

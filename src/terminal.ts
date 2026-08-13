import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import { semanticRanges } from "./semanticColors";

export type GutterMode = "off" | "line" | "time" | "both";

const SCROLLBACK = 5000;

function openTerminalWebLink(event: MouseEvent, uri: string) {
  // Opening terminal output on an unmodified click makes accidental launches
  // too easy. Match native terminal behavior on macOS and other platforms.
  if (!event.metaKey && !event.ctrlKey) return;

  event.preventDefault();
  void openUrl(uri).catch((error) => {
    console.error(`Failed to open terminal link ${uri}`, error);
  });
}

/**
 * A vivid, dark-background 16-color palette. xterm.js supplies the remaining
 * 240 entries of the xterm-256color cube and grayscale ramp automatically.
 */
const XTERM_256_THEME = {
  background: "#16181d",
  foreground: "#d8dee9",
  cursor: "#7fc4ff",
  cursorAccent: "#16181d",
  selectionBackground: "#31567a",
  selectionInactiveBackground: "#25384d",
  selectionForeground: "#ffffff",
  black: "#1e222a",
  red: "#ff5f6d",
  green: "#8bd450",
  yellow: "#f0c674",
  blue: "#5aa9fa",
  magenta: "#c678dd",
  cyan: "#56d4dd",
  white: "#d8dee9",
  brightBlack: "#6b7280",
  brightRed: "#ff7a85",
  brightGreen: "#a6e75f",
  brightYellow: "#ffe082",
  brightBlue: "#7fc4ff",
  brightMagenta: "#dd8ceb",
  brightCyan: "#78e5ec",
  brightWhite: "#ffffff",
};

interface Callbacks {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onCursorMove: (line: number, column: number) => void;
}

/**
 * Owns one xterm.js instance plus the WindTerm-style gutter that runs down the
 * left edge showing a timestamp and line number for every row.
 *
 * The gutter is plain DOM updated on xterm's render tick rather than React
 * state, because it changes on every frame of scrolling output.
 */
export class TerminalController {
  readonly term: Terminal;
  readonly fitAddon = new FitAddon();
  readonly searchAddon = new SearchAddon();

  private root: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private gutter: HTMLElement | null = null;
  private rowPool: HTMLElement[] = [];

  /** Wall-clock time each buffer line was produced, parallel to buffer lines. */
  private lineTimes: number[] = [];
  /** Absolute line number of buffer line 0; grows as scrollback is trimmed. */
  private firstLineNumber = 1;

  private gutterMode: GutterMode = "both";
  private pendingShellClear = false;
  private pendingSemanticLines = new Set<number>();
  private disposed = false;
  /**
   * Cached so the per-frame gutter sync never reads layout. Recomputed only on
   * fit/resize, which is the only time it can change.
   */
  private cellHeight = 0;

  constructor(
    readonly sessionId: string,
    private readonly callbacks: Callbacks,
  ) {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: SCROLLBACK,
      theme: XTERM_256_THEME,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new WebLinksAddon(openTerminalWebLink));
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    this.term.onData((data) => this.callbacks.onData(data));
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      const mode = params[0];
      if (
        (mode === 2 || mode === 3) &&
        this.term.buffer.active.type === "normal"
      ) {
        this.pendingShellClear = true;
      }
      return false;
    });
    this.term.onWriteParsed(() => {
      if (this.pendingShellClear) {
        this.pendingShellClear = false;
        this.term.clear();
        this.resetLineMetadata();
        return;
      }
      this.applySemanticColors();
    });

    this.term.onResize(({ cols, rows }) => {
      this.callbacks.onResize(cols, rows);
      this.measureCell();
      this.syncGutter();
    });

    this.term.onLineFeed(() => this.recordLine());
    this.term.onRender(() => this.syncGutter());
    this.term.onScroll(() => this.syncGutter());
    this.term.onCursorMove(() => {
      const buf = this.term.buffer.active;
      this.callbacks.onCursorMove(
        this.firstLineNumber + buf.baseY + buf.cursorY,
        buf.cursorX + 1,
      );
    });

    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mod = event.metaKey || (event.ctrlKey && event.shiftKey);
      if (mod && event.key.toLowerCase() === "c" && this.term.hasSelection()) {
        // Let the browser emit its native copy event. xterm handles that event
        // and writes the current selection to the clipboard exactly once.
        return false;
      }
      if (mod && event.key.toLowerCase() === "v") {
        // Let the browser emit its native paste event. xterm handles newline
        // normalization and bracketed paste before forwarding the text through
        // onData. Reading and forwarding it here as well would paste it twice.
        return false;
      }
      return true;
    });

    this.lineTimes.push(Date.now());
  }

  attach(root: HTMLElement) {
    if (this.disposed || this.root === root) return;

    // Re-parenting keeps the existing xterm instance (and its scrollback)
    // alive if React ever hands us a fresh container node.
    if (this.root && this.gutter && this.host) {
      root.replaceChildren(this.gutter, this.host);
      this.root = root;
      this.fit();
      return;
    }

    this.root = root;
    root.replaceChildren();

    this.gutter = document.createElement("div");
    this.gutter.className = "term-gutter";

    this.host = document.createElement("div");
    this.host.className = "term-host";

    root.appendChild(this.gutter);
    root.appendChild(this.host);

    this.term.open(this.host);

    // WebGL is a large win on heavy output but is unavailable in some
    // environments; the canvas/DOM renderer remains a working fallback.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* fall back to the default renderer */
    }

    this.fit();
    this.applyGutterMode();
  }

  fit(): { cols: number; rows: number } | null {
    if (!this.host || this.host.clientWidth === 0) return null;
    try {
      this.fitAddon.fit();
    } catch {
      return null;
    }
    this.measureCell();
    this.syncGutter();
    return { cols: this.term.cols, rows: this.term.rows };
  }

  write(data: Uint8Array) {
    this.term.write(data);
  }

  writeText(text: string) {
    this.term.write(text);
  }

  focus() {
    this.term.focus();
  }

  clear() {
    this.term.clear();
    this.resetLineMetadata();
  }

  private resetLineMetadata() {
    this.lineTimes = [Date.now()];
    this.firstLineNumber = 1;
    this.pendingSemanticLines.clear();
    this.syncGutter();
  }

  setGutterMode(mode: GutterMode) {
    this.gutterMode = mode;
    this.applyGutterMode();
    this.syncGutter();
  }

  search(query: string, forward = true) {
    if (!query) return;
    if (forward) this.searchAddon.findNext(query);
    else this.searchAddon.findPrevious(query);
  }

  scrollToLine(absoluteLine: number) {
    this.term.scrollToLine(Math.max(0, absoluteLine - this.firstLineNumber));
  }

  dispose() {
    this.disposed = true;
    this.term.dispose();
    this.root = null;
    this.host = null;
    this.gutter = null;
    this.rowPool = [];
  }

  // --- internals ------------------------------------------------------------

  private applyGutterMode() {
    if (!this.gutter) return;
    this.gutter.classList.toggle("is-hidden", this.gutterMode === "off");
    this.gutter.classList.toggle(
      "no-time",
      this.gutterMode === "line" || this.gutterMode === "off",
    );
    this.gutter.classList.toggle(
      "no-line",
      this.gutterMode === "time" || this.gutterMode === "off",
    );
  }

  private recordLine() {
    const buf = this.term.buffer.active;
    const index = buf.baseY + buf.cursorY;
    const now = Date.now();
    if (buf.type === "normal" && index > 0) {
      this.pendingSemanticLines.add(index - 1);
    }
    while (this.lineTimes.length <= index) this.lineTimes.push(now);
    this.lineTimes[index] = now;

    // xterm drops the oldest lines once scrollback is full; keep the parallel
    // array aligned and carry the discarded count into the line numbering.
    const max = this.term.rows + SCROLLBACK;
    if (this.lineTimes.length > max) {
      const dropped = this.lineTimes.length - max;
      this.lineTimes.splice(0, dropped);
      this.firstLineNumber += dropped;
    }
  }

  /**
   * WindTerm-style semantic coloring for output that did not set its own ANSI
   * foreground color. Decorations keep the byte stream untouched, so cursor
   * movement, copying and full-screen applications continue to behave normally.
   */
  private applySemanticColors() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || this.pendingSemanticLines.size === 0) return;

    const cursorIndex = buf.baseY + buf.cursorY;
    for (const lineIndex of this.pendingSemanticLines) {
      const line = buf.getLine(lineIndex);
      const text = line?.translateToString(true) ?? "";
      // The rules below use JavaScript string offsets as terminal columns.
      // Restrict them to single-width ASCII so decorations always align.
      if (!line || !text || !/^[\x20-\x7e]*$/.test(text)) continue;

      const ranges = semanticRanges(text);
      if (ranges.length === 0) continue;
      const marker = this.term.registerMarker(lineIndex - cursorIndex);
      if (!marker) continue;

      for (const range of ranges) {
        let isUnstyled = true;
        for (let x = range.start; x < range.end; x += 1) {
          const cell = line.getCell(x);
          if (!cell?.isFgDefault() || !cell.isBgDefault()) {
            isUnstyled = false;
            break;
          }
        }
        if (!isUnstyled) continue;
        this.term.registerDecoration({
          marker,
          x: range.start,
          width: range.end - range.start,
          foregroundColor: range.color,
          layer: "top",
        });
      }
    }
    this.pendingSemanticLines.clear();
  }

  /**
   * `.xterm-screen` spans exactly `rows` cells, so its height divided by the
   * row count is the exact cell height — no reaching into xterm's renderer.
   */
  private measureCell() {
    const screen = this.host?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || this.term.rows === 0) return;
    const height = screen.clientHeight / this.term.rows;
    if (Number.isFinite(height) && height > 0) this.cellHeight = height;
  }

  private syncGutter() {
    if (!this.gutter || !this.host || this.gutterMode === "off") return;
    if (this.cellHeight <= 0) this.measureCell();
    const cellHeight = this.cellHeight;
    if (cellHeight <= 0) return;

    const buf = this.term.buffer.active;
    const cursorIndex = buf.baseY + buf.cursorY;
    const rows = this.term.rows;
    // Full-screen programs (vim, top) paint into the alternate buffer, where
    // line numbers and produced-at times are meaningless.
    const alternate = buf.type === "alternate";

    while (this.rowPool.length < rows) {
      const row = document.createElement("div");
      row.className = "gutter-row";
      const time = document.createElement("span");
      time.className = "gutter-time";
      const line = document.createElement("span");
      line.className = "gutter-line";
      row.append(time, line);
      this.gutter.appendChild(row);
      this.rowPool.push(row);
    }
    while (this.rowPool.length > rows) {
      this.rowPool.pop()?.remove();
    }

    for (let i = 0; i < rows; i++) {
      const row = this.rowPool[i];
      const index = buf.viewportY + i;
      row.style.height = `${cellHeight}px`;
      row.style.lineHeight = `${cellHeight}px`;

      // `buf.length` always spans the whole viewport, so it cannot tell a
      // written line from blank padding below the last one. A recorded
      // timestamp can: only produced lines have one.
      const written = !alternate && index < this.lineTimes.length;
      row.classList.toggle("is-empty", !written);
      row.classList.toggle("is-cursor", written && index === cursorIndex);

      const time = row.children[0] as HTMLElement;
      const line = row.children[1] as HTMLElement;
      if (written) {
        time.textContent = formatTime(this.lineTimes[index]);
        line.textContent = String(this.firstLineNumber + index);
      } else {
        time.textContent = "";
        line.textContent = "";
      }
    }
  }
}

function formatTime(epochMs: number | undefined): string {
  if (!epochMs) return "[--:--:--.---]";
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${milliseconds}]`;
}

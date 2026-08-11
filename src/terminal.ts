import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type { OutlineItem } from "./types";

export type GutterMode = "off" | "line" | "time" | "both";

const SCROLLBACK = 5000;

const THEME = {
  background: "#16181d",
  foreground: "#c8ccd4",
  cursor: "#f5c04a",
  cursorAccent: "#16181d",
  selectionBackground: "#38414f",
  black: "#2b2f38",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#ff7b72",
  brightGreen: "#b5e08d",
  brightYellow: "#f0d399",
  brightBlue: "#7fc4ff",
  brightMagenta: "#dc9ff2",
  brightCyan: "#78d5df",
  brightWhite: "#e6e9ef",
};

interface Callbacks {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onCursorMove: (line: number, column: number) => void;
  onOutline: (items: OutlineItem[]) => void;
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

  private outline: OutlineItem[] = [];
  private gutterMode: GutterMode = "both";
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
      theme: THEME,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new WebLinksAddon());
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    this.term.onData((data) => {
      if (data.includes("\r")) this.captureCommand();
      this.callbacks.onData(data);
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
        navigator.clipboard.writeText(this.term.getSelection());
        return false;
      }
      if (mod && event.key.toLowerCase() === "v") {
        navigator.clipboard.readText().then((text) => {
          if (text) this.callbacks.onData(text);
        });
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
    this.lineTimes = [Date.now()];
    this.firstLineNumber = 1;
    this.outline = [];
    this.callbacks.onOutline(this.outline);
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

  private captureCommand() {
    const buf = this.term.buffer.active;
    const index = buf.baseY + buf.cursorY;
    const text = buf.getLine(index)?.translateToString(true).trim();
    if (!text) return;
    this.outline = [
      ...this.outline.slice(-199),
      { line: this.firstLineNumber + index, text },
    ];
    this.callbacks.onOutline(this.outline);
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
  if (!epochMs) return "[--:--:--]";
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

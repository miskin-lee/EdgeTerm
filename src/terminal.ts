import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  Terminal,
  type IBufferCell,
  type IBufferLine,
  type IDecoration,
  type IMarker,
} from "@xterm/xterm";

import { semanticRanges } from "./semanticColors";
import {
  ZmodemController,
  type ZmodemNoticeKind,
} from "./zmodem";

export type GutterMode = "off" | "line" | "time" | "both";

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
  onStatus: (message: string, error?: boolean) => void;
}

interface SemanticRow {
  /** Tracks the row across scrolling and scrollback trimming. */
  marker: IMarker;
  /** The row's text when it was last processed; a change forces a recolor. */
  text: string;
  decorations: IDecoration[];
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
  private readonly zmodem: ZmodemController;
  private readonly zmodemNotice: HTMLElement;
  private zmodemNoticeTimer: number | null = null;

  private root: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private gutter: HTMLElement | null = null;
  private rowPool: HTMLElement[] = [];

  /** Wall-clock time each buffer line was produced, parallel to buffer lines. */
  private lineTimes: number[] = [];
  /** Absolute line number of buffer line 0; grows as scrollback is trimmed. */
  private firstLineNumber = 1;

  private gutterMode: GutterMode = "both";
  private scrollback: number;
  private pendingShellClear = false;
  /**
   * Semantic coloring is render-driven: only rows in and around the viewport
   * are colored, on the frame they become visible or change. Keeping the
   * live marker count near the viewport size (instead of one per scrollback
   * line) is what keeps write throughput flat — xterm walks every live
   * marker each time the buffer trims a line.
   */
  private semanticRows: SemanticRow[] = [];
  /** Reused cell for buffer walks, to avoid per-cell allocation. */
  private workCell: IBufferCell | undefined;
  private disposed = false;
  /**
   * Cached so the per-frame gutter sync never reads layout. Recomputed only on
   * fit/resize, which is the only time it can change.
   */
  private cellHeight = 0;

  constructor(
    readonly sessionId: string,
    private readonly callbacks: Callbacks,
    fontSize: number,
    scrollback: number,
  ) {
    this.scrollback = scrollback;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback,
      theme: XTERM_256_THEME,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    this.zmodemNotice = document.createElement("div");
    this.zmodemNotice.className = "zmodem-notice is-hidden";
    this.zmodemNotice.setAttribute("role", "status");
    this.zmodemNotice.setAttribute("aria-live", "polite");

    this.zmodem = new ZmodemController(sessionId, {
      toTerminal: (bytes) => this.term.write(bytes),
      onStatus: callbacks.onStatus,
      onNotice: (message, kind) => this.showZmodemNotice(message, kind),
    });

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new WebLinksAddon(openTerminalWebLink));
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    // ZMODEM owns the byte stream while a transfer is active. Forwarding
    // keystrokes or paste data in the middle of a binary frame corrupts it.
    this.term.onData((data) => {
      if (!this.zmodem.isActive()) this.callbacks.onData(data);
    });
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
        this.clearBufferAndMetadata();
      }
    });

    this.term.onResize(({ cols, rows }) => {
      this.callbacks.onResize(cols, rows);
      this.trimLineMetadata();
      this.measureCell();
      this.syncGutter();
    });

    this.term.onLineFeed(() => this.recordLine());
    this.term.onRender(() => {
      this.refreshSemanticColors();
      this.syncGutter();
    });
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
      root.replaceChildren(this.gutter, this.host, this.zmodemNotice);
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
    root.appendChild(this.zmodemNotice);

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
    this.zmodem.consume(data);
  }

  writeText(text: string) {
    this.term.write(text);
  }

  isZmodemActive(): boolean {
    return this.zmodem.isActive();
  }

  cancelZmodem(): boolean {
    return this.zmodem.cancel();
  }

  focus() {
    this.term.focus();
  }

  clear() {
    this.clearBufferAndMetadata();
  }

  private clearBufferAndMetadata() {
    // Dispose our decorations while their markers still hold valid lines.
    // term.clear()'s own mass marker disposal invalidates the marker first,
    // which corrupts the decoration service's sorted-by-line lookups whenever
    // decorated markers die out of line order.
    this.disposeAllSemanticColors();
    this.term.clear();
    this.resetLineMetadata();
  }

  private resetLineMetadata() {
    this.lineTimes = [Date.now()];
    this.firstLineNumber = 1;
    this.syncGutter();
  }

  setGutterMode(mode: GutterMode) {
    this.gutterMode = mode;
    this.applyGutterMode();
    this.syncGutter();
  }

  setFontSize(fontSize: number) {
    if (this.term.options.fontSize === fontSize) return;
    this.term.options.fontSize = fontSize;
    this.cellHeight = 0;
    this.fit();
  }

  setScrollback(scrollback: number) {
    if (this.scrollback === scrollback) return;
    this.scrollback = scrollback;
    this.term.options.scrollback = scrollback;
    this.trimLineMetadata();
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
    if (this.zmodemNoticeTimer !== null) {
      window.clearTimeout(this.zmodemNoticeTimer);
      this.zmodemNoticeTimer = null;
    }
    this.zmodem.dispose();
    this.term.dispose();
    this.root = null;
    this.host = null;
    this.gutter = null;
    this.rowPool = [];
    this.semanticRows = [];
  }

  // --- internals ------------------------------------------------------------

  private showZmodemNotice(message: string, kind: ZmodemNoticeKind) {
    if (this.disposed) return;
    if (this.zmodemNoticeTimer !== null) {
      window.clearTimeout(this.zmodemNoticeTimer);
      this.zmodemNoticeTimer = null;
    }

    this.zmodemNotice.textContent = message;
    this.zmodemNotice.className = `zmodem-notice is-${kind}`;
    if (kind !== "active") {
      this.zmodemNoticeTimer = window.setTimeout(
        () => {
          this.zmodemNotice.classList.add("is-hidden");
          this.zmodemNoticeTimer = null;
        },
        kind === "error" ? 7000 : 4500,
      );
    }
  }

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
    this.trimLineMetadata();
  }

  private trimLineMetadata() {
    const max = this.term.rows + this.scrollback;
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
  /**
   * Recolors the viewport after each render. Rows keep their state (marker,
   * last-seen text, decorations) while they stay near the viewport; a row is
   * only re-processed when its text changes, so an idle screen costs a few
   * string compares per frame and a full-speed flood costs one viewport of
   * regex work per frame instead of per line.
   */
  private refreshSemanticColors() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || this.term.rows === 0) return;

    const top = buf.viewportY;
    const bottom = Math.min(top + this.term.rows - 1, buf.length - 1);
    // A margin above and below the viewport keeps ordinary scrolling from
    // dropping and recoloring the same rows frame after frame.
    const keepFirst = top - this.term.rows;
    const keepLast = bottom + this.term.rows;

    const byLine = new Map<number, SemanticRow>();
    for (const state of this.semanticRows) {
      if (state.marker.isDisposed) continue;
      const line = state.marker.line;
      if (line < keepFirst || line > keepLast || byLine.has(line)) {
        this.disposeSemanticRow(state);
        continue;
      }
      byLine.set(line, state);
    }

    // The cursor's logical line is still being written (echoed keystrokes,
    // prompt redraws); it is colored once the cursor has left it.
    const cursorIndex = buf.baseY + buf.cursorY;
    let cursorFirst = cursorIndex;
    while (cursorFirst > 0 && buf.getLine(cursorFirst)?.isWrapped) {
      cursorFirst -= 1;
    }

    let row = top;
    while (row <= bottom) {
      // The logical line containing `row`: soft-wrapped rows join their
      // neighbors so tokens split by wrapping are matched whole.
      let first = row;
      while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;
      let last = row;
      while (buf.getLine(last + 1)?.isWrapped) last += 1;
      row = last + 1;

      let changed = false;
      for (let r = first; r <= last && !changed; r += 1) {
        const state = byLine.get(r);
        const text = buf.getLine(r)?.translateToString(true) ?? "";
        changed = state ? state.text !== text : text.length > 0;
      }
      if (!changed) continue;

      for (let r = first; r <= last; r += 1) {
        const state = byLine.get(r);
        if (state) {
          this.disposeSemanticRow(state);
          byLine.delete(r);
        }
      }
      if (last < cursorFirst || first > cursorIndex) {
        this.colorLogicalLine(first, last, byLine);
      }
    }

    this.semanticRows = [...byLine.values()];
  }

  /**
   * Colors one logical line (rows [first..last] joined across soft wraps) and
   * records one SemanticRow per member row. The text is rebuilt from cells
   * with a string-index → column map so decorations align across wide (CJK)
   * glyphs and wrapped rows instead of assuming one column per code unit.
   */
  private colorLogicalLine(
    first: number,
    last: number,
    byLine: Map<number, SemanticRow>,
  ) {
    const buf = this.term.buffer.active;
    const work = (this.workCell ??= buf.getNullCell());

    let text = "";
    const rows: number[] = [];
    const cols: number[] = [];
    const widths: number[] = [];
    for (let row = first; row <= last && text.length <= 4000; row += 1) {
      const line = buf.getLine(row);
      if (!line) break;
      for (let col = 0; col < line.length; ) {
        const cell = line.getCell(col, work);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) {
          col += 1;
          continue;
        }
        const chars = cell.getChars() || " ";
        for (let i = 0; i < chars.length; i += 1) {
          rows.push(row);
          cols.push(col);
          widths.push(width);
        }
        text += chars;
        col += width;
      }
    }
    text = text.replace(/\s+$/, "");
    // Pathological logical lines (minified assets, base64 blobs) are not
    // worth the regex cost; their rows are still recorded below so they are
    // not re-examined every frame.
    const ranges =
      text && text.length <= 4000 ? semanticRanges(text) : [];

    const cursorIndex = buf.baseY + buf.cursorY;
    const rowMarkers = new Map<number, IMarker>();
    const rowDecorations = new Map<number, IDecoration[]>();

    for (const range of ranges) {
      // A range that crosses a soft wrap becomes one decoration per row.
      let start = range.start;
      while (start < range.end) {
        const row = rows[start];
        let end = start;
        while (end < range.end && rows[end] === row) end += 1;
        const startCol = cols[start];
        const endCol = cols[end - 1] + widths[end - 1];
        start = end;

        const line = buf.getLine(row);
        if (!line || !isUnstyledSpan(line, startCol, endCol, work)) continue;

        let marker = rowMarkers.get(row);
        if (!marker) {
          marker = this.term.registerMarker(row - cursorIndex);
          if (!marker) continue;
          rowMarkers.set(row, marker);
        }
        const decoration = this.term.registerDecoration({
          marker,
          x: startCol,
          width: endCol - startCol,
          foregroundColor: range.color,
          layer: "top",
        });
        if (!decoration) continue;
        let list = rowDecorations.get(row);
        if (!list) rowDecorations.set(row, (list = []));
        list.push(decoration);
      }
    }

    for (let row = first; row <= last; row += 1) {
      const rowText = buf.getLine(row)?.translateToString(true) ?? "";
      const decorations = rowDecorations.get(row) ?? [];
      // Blank rows carry no state; they are skipped by the change check.
      if (!rowText && decorations.length === 0) continue;
      let marker = rowMarkers.get(row);
      if (!marker) {
        marker = this.term.registerMarker(row - cursorIndex);
        if (!marker) continue;
      }
      byLine.set(row, { marker, text: rowText, decorations });
    }
  }

  private disposeSemanticRow(state: SemanticRow) {
    if (state.marker.isDisposed) return;
    // Decorations first: the decoration service unindexes them by the
    // marker's line, which the marker's own dispose() resets to -1.
    for (const decoration of state.decorations) decoration.dispose();
    state.marker.dispose();
  }

  private disposeAllSemanticColors() {
    for (const state of this.semanticRows) this.disposeSemanticRow(state);
    this.semanticRows = [];
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

/** Semantic colors must never repaint output that styled itself via ANSI. */
function isUnstyledSpan(
  line: IBufferLine,
  start: number,
  end: number,
  work: IBufferCell,
): boolean {
  for (let x = start; x < end; x += 1) {
    const cell = line.getCell(x, work);
    if (!cell?.isFgDefault() || !cell.isBgDefault()) return false;
  }
  return true;
}

function formatTime(epochMs: number | undefined): string {
  if (!epochMs) return "[--:--:--.---]";
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${milliseconds}]`;
}

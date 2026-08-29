import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  Terminal,
  type IBufferCell,
  type IBufferLine,
  type IDecoration,
  type IMarker,
  type ITheme,
} from "@xterm/xterm";

import type { CommandSuggestion } from "./history";
import { IS_MAC } from "./platform";
import { matchAppShortcut } from "./shortcuts";
import { semanticLine, type SemanticRange } from "./semanticColors";
import type { ThemeMode } from "./types";
import {
  ZmodemController,
  type ZmodemNoticeKind,
} from "./zmodem";

export type GutterMode = "off" | "line" | "time" | "both";

/**
 * What a right click in the terminal does, when no program has taken over
 * the mouse. `copyPaste` is the Windows console convention (copy the
 * selection if there is one, otherwise paste), `menu` the macOS one (a
 * context menu; the word under the pointer is selected first, as in
 * VS Code).
 */
export type RightClickAction = "copyPaste" | "menu";

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
 * VS Code's terminal palettes, one per theme, on the matching editor
 * backgrounds (kept in sync with --bg-terminal in styles.css). xterm.js
 * supplies the remaining 240 entries of the xterm-256color cube and grayscale
 * ramp automatically, and the enforced minimum contrast ratio keeps
 * low-contrast entries legible, as VS Code does.
 */
const XTERM_THEMES: Record<ThemeMode, ITheme> = {
  dark: {
    background: "#1f1f1f",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1f1f1f",
    selectionBackground: "#264f78",
    selectionInactiveBackground: "#22374c",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    background: "#ffffff",
    foreground: "#3b3b3b",
    cursor: "#005fb8",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    selectionInactiveBackground: "#e5ebf1",
    black: "#000000",
    red: "#cd3131",
    green: "#107c10",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};

type SearchDecorations = NonNullable<ISearchOptions["decorations"]>;

/**
 * Find-in-buffer highlights, per theme. Enabling decorations is also what
 * makes the search addon report the match index / count.
 */
const SEARCH_DECORATIONS: Record<ThemeMode, SearchDecorations> = {
  dark: {
    matchBackground: "#623315",
    matchOverviewRuler: "#d18616",
    activeMatchBackground: "#9e6a03",
    activeMatchColorOverviewRuler: "#ffb700",
  },
  light: {
    matchBackground: "#f5d3b0",
    matchOverviewRuler: "#d18616",
    activeMatchBackground: "#a8ac94",
    activeMatchColorOverviewRuler: "#ffb700",
  },
};

/** The search addon stops highlighting (and counting) past this many matches. */
export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export interface SearchResults {
  /** Zero-based index of the selected match; -1 when it is not among the highlighted ones. */
  resultIndex: number;
  /** Highlighted match count, capped at SEARCH_HIGHLIGHT_LIMIT. */
  resultCount: number;
}

interface Callbacks {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onStatus: (message: string, error?: boolean) => void;
  /** An executed command line, captured from the buffer after Enter. */
  onCommand: (command: string) => void;
  /** Ranked history completions for the current input; [] when none. */
  suggest: (input: string) => CommandSuggestion[];
}

/**
 * Where the user's typing begins on the prompt line. Captured on the first
 * keystroke after a fresh prompt, before the shell has echoed anything, so the
 * cursor still sits at the prompt's end. The marker tracks the row across
 * scrolling; the column is fixed because prompts do not move.
 */
interface InputAnchor {
  marker: IMarker;
  col: number;
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
  readonly searchAddon = new SearchAddon({
    highlightLimit: SEARCH_HIGHLIGHT_LIMIT,
  });
  /** Fires after every search and whenever buffer changes shift the matches. */
  readonly onSearchResults = this.searchAddon.onDidChangeResults;
  private lastSearch: string | null = null;
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
  private themeMode: ThemeMode;
  private scrollback: number;
  private pendingShellClear = false;
  private locked = false;
  /** Command history capture + completion popup. Opt-in via the Edit menu. */
  private suggestionsOn = false;
  private inputAnchor: InputAnchor | null = null;
  private readonly popup: HTMLElement;
  /** Rows currently displayed; [] while the popup is hidden. */
  private candidates: CommandSuggestion[] = [];
  /** Selected row, or -1 while the popup is passive (keys pass through). */
  private popupIndex = -1;
  /** The input the current candidates were computed for. */
  private popupInput = "";
  /** Input the user dismissed the popup for (Esc / accept); "" = none. */
  private dismissedInput = "";
  private popupSyncScheduled = false;
  /**
   * Semantic coloring is viewport-driven: only rows in and around the
   * viewport are colored, on the frame they become visible or change. Three
   * hooks feed it, each timed to run before the paint it affects: new output
   * via `onWriteParsed`, user scrolling via the viewport's DOM `scroll`
   * event, and `onRender` as the after-paint catch-all. Keeping the live
   * marker count near the viewport size (instead of one per scrollback line)
   * is what keeps write throughput flat — xterm walks every live marker each
   * time the buffer trims a line.
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
    theme: ThemeMode = "dark",
  ) {
    this.scrollback = scrollback;
    this.themeMode = theme;
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
      theme: XTERM_THEMES[theme],
      // VS Code's approach to palette legibility: rather than hand-tuning
      // every ANSI entry per background, let the renderer nudge foregrounds
      // that fall below 4.5:1 against the current background.
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      // Set by setRightClickAction: only the "menu" mode wants the
      // word under the pointer selected first.
      rightClickSelectsWord: false,
    });

    this.zmodemNotice = document.createElement("div");
    this.zmodemNotice.className = "zmodem-notice is-hidden";
    this.zmodemNotice.setAttribute("role", "status");
    this.zmodemNotice.setAttribute("aria-live", "polite");

    this.popup = document.createElement("div");
    this.popup.className = "term-suggest is-hidden";
    this.popup.setAttribute("role", "listbox");

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
      if (this.zmodem.isActive()) return;
      this.trackInput(data);
      this.callbacks.onData(data);
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
      // New output: xterm has updated the buffer and queued its repaint but
      // not painted yet, so decorations registered here land in that same
      // frame. Coloring only from `onRender` (which fires *after* the
      // renderer has drawn) showed every freshly written row plain for one
      // frame before it was recolored — a visible flash on `ls -la`.
      //
      // This fires once per parse slice (xterm parses for up to 12 ms, then
      // yields), so during an output flood it runs about once per frame and
      // takes over the work the `onRender` pass would otherwise do; that
      // pass then finds the rows unchanged and costs a viewport of string
      // compares. Two slices in one frame cost one extra viewport of regex
      // work (~0.5 ms); a throttle would bring back a half-viewport flash
      // when a listing arrives split across slices, so there is none.
      this.refreshSemanticColors();
      // The shell's echo of a keystroke lands here; recompute the suggestions
      // from the buffer only while the user is composing a command.
      if (this.inputAnchor) this.schedulePopupSync();
    });

    this.term.onResize(({ cols, rows }) => {
      this.callbacks.onResize(cols, rows);
      // Line bands span the column count they were created with; drop
      // everything so the next render rebuilds decorations at the new width.
      this.disposeAllSemanticColors();
      this.trimLineMetadata();
      this.measureCell();
      this.syncGutter();
    });

    this.term.onLineFeed(() => this.recordLine());
    this.term.onRender(() => {
      // Catch-all for rows the write and scroll hooks did not see (resize
      // rebuilds, the cursor leaving a line, a second parse slice in the
      // same frame). Runs after the paint, so anything it colors shows up a
      // frame late; in the steady state it finds nothing to do.
      this.refreshSemanticColors();
      this.syncGutter();
    });
    this.term.onScroll(() => {
      this.syncGutter();
      if (this.inputAnchor || this.candidates.length) this.schedulePopupSync();
    });
    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();

      // IDE-style completion popup. While it is *passive* every key still
      // reaches the shell (so ↑ history, Tab completion and a remote shell's
      // own → autosuggest keep working); only ↓ (step into the list) and Esc
      // (dismiss) are taken. Once a row is selected the list owns ↑/↓ and
      // Enter/Tab accept — the user opted in by stepping into it.
      if (
        this.candidates.length > 0 &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (key === "escape") {
          event.preventDefault();
          this.dismissedInput = this.popupInput;
          this.hidePopup();
          return false;
        }
        if (key === "arrowdown") {
          event.preventDefault();
          this.setPopupIndex(
            this.popupIndex >= this.candidates.length - 1
              ? this.candidates.length - 1
              : this.popupIndex + 1,
          );
          return false;
        }
        if (this.popupIndex >= 0) {
          if (key === "arrowup") {
            event.preventDefault();
            this.setPopupIndex(this.popupIndex - 1);
            return false;
          }
          if (key === "enter" || key === "tab") {
            event.preventDefault();
            this.acceptSuggestion(this.popupIndex);
            return false;
          }
        }
      }

      if (IS_MAC) {
        // Only ⌘ combinations are app keys on macOS. Option types characters
        // and Ctrl belongs to the shell, so both go straight to xterm.
        if (!event.metaKey) return true;
        if (key === "c" && this.term.hasSelection()) {
          // Let the browser emit its native copy event. xterm handles that
          // event and writes the current selection to the clipboard once.
          return false;
        }
        if (key === "v") {
          // Let the browser emit its native paste event. xterm handles newline
          // normalization and bracketed paste before forwarding the text
          // through onData. Reading and forwarding it here as well would paste
          // it twice.
          return false;
        }
        // ⌘N / W / F / G / K, ⌘[ / ⌘] and ⌘1–9 are app shortcuts. Leave
        // them unhandled so the window-level handler receives them.
        if (matchAppShortcut(event)) return false;
        return true;
      }

      // Windows / Linux: Ctrl+Shift+A / C / V select all, copy and paste, as
      // in WindTerm, GNOME Terminal and VS Code. Plain Ctrl+A/C/V keep
      // reaching the shell (^A is readline beginning-of-line, ^C is SIGINT,
      // ^V is quoted-insert), and Alt+letter is left alone because it is
      // readline's Meta layer. (xterm itself maps ⌘A to select-all on macOS.)
      const ctrlShiftOnly =
        event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      if (ctrlShiftOnly && key === "a") {
        event.preventDefault();
        this.term.selectAll();
        return false;
      }
      if (ctrlShiftOnly && key === "c") {
        // Consumed even without a selection so it never reaches the shell
        // as an accidental ^C.
        event.preventDefault();
        this.copySelection();
        return false;
      }
      if (ctrlShiftOnly && key === "v") {
        event.preventDefault();
        this.pasteFromClipboard();
        return false;
      }

      // Ctrl+Shift+W / F / G, Alt+N / K, Alt+[ / Alt+] and Alt+1–9 are app
      // shortcuts. Leave them unhandled so the window-level handler receives
      // them instead of xterm sending ESC-prefixed input.
      if (matchAppShortcut(event)) return false;
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
    // Inside the host (not the root) so the completion popup positions
    // against the terminal content, past the gutter, and survives
    // re-parenting above.
    this.host.appendChild(this.popup);

    // User scrolling (wheel, trackpad, scrollbar drag) reaches xterm through
    // the viewport element's DOM `scroll` event and never fires
    // `term.onScroll`. Coloring only on `onRender` would paint the rows
    // that just scrolled in plain first and recolor them a frame later,
    // which shows as a visible color pass during a fast scroll. This
    // listener is registered after xterm's own, so it runs once xterm has
    // updated `viewportY` and queued its repaint but before that frame's
    // animation-frame callbacks: the decorations land in the same paint.
    // The browser coalesces `scroll` events to one per frame per element,
    // so during an output flood (xterm sets `scrollTop` itself) this is at
    // most one viewport of string compares per frame; rows colored here
    // keep their state and are skipped by the `onRender` pass. New output
    // is handled by the `onWriteParsed` hook in the constructor.
    this.term.element
      ?.querySelector(".xterm-viewport")
      ?.addEventListener("scroll", () => {
        if (!this.disposed) this.refreshSemanticColors();
      });

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
    if (this.inputAnchor || this.candidates.length) this.schedulePopupSync();
    return { cols: this.term.cols, rows: this.term.rows };
  }

  write(data: Uint8Array) {
    this.zmodem.consume(data);
  }

  writeText(text: string) {
    this.term.write(text);
  }

  /**
   * Locks the terminal once its session has ended: keystrokes, paste and
   * completions no longer reach `onData`, and the cursor is hidden so the
   * pane does not look like it is waiting for input. Unlocking restores both
   * for a reconnect.
   */
  setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.locked = locked;
    this.term.options.disableStdin = locked;
    this.term.write(locked ? "\x1b[?25l" : "\x1b[?25h");
    if (locked) this.hidePopup();
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

  /**
   * `rightClickSelectsWord` follows the right-click mode: in "menu" mode a
   * right click selects the word under the pointer so the menu's Copy has
   * something to copy (VS Code on macOS); in "copyPaste" mode it must stay
   * off, or a right click meant to paste would select a word and copy it
   * instead.
   */
  setRightClickAction(rightClick: RightClickAction) {
    this.term.options.rightClickSelectsWord = rightClick === "menu";
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  /** Copies the selection to the clipboard; false when there is none. */
  copySelection(): boolean {
    if (!this.term.hasSelection()) return false;
    void navigator.clipboard.writeText(this.term.getSelection());
    return true;
  }

  clearSelection() {
    this.term.clearSelection();
  }

  selectAll() {
    this.term.selectAll();
  }

  /**
   * Pastes the clipboard as typed input. xterm applies bracketed paste and
   * drops it while the terminal is locked (`disableStdin`).
   */
  pasteFromClipboard() {
    void navigator.clipboard.readText().then((text) => {
      if (text) this.term.paste(text);
    });
  }

  /**
   * True while a program in the terminal (vim, tmux, htop…) has enabled
   * mouse reporting, in which case clicks belong to it rather than to the
   * app's copy / paste handling.
   */
  isMouseTracked(): boolean {
    return this.term.modes.mouseTrackingMode !== "none";
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
    this.dropAnchor();
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

  setSuggestions(enabled: boolean) {
    if (this.suggestionsOn === enabled) return;
    this.suggestionsOn = enabled;
    if (!enabled) this.dropAnchor();
  }

  setFontSize(fontSize: number) {
    if (this.term.options.fontSize === fontSize) return;
    this.term.options.fontSize = fontSize;
    this.cellHeight = 0;
    // Underline elements are sized in pixels at creation time.
    this.disposeAllSemanticColors();
    this.fit();
  }

  setTheme(theme: ThemeMode) {
    if (this.themeMode === theme) return;
    this.themeMode = theme;
    this.term.options.theme = XTERM_THEMES[theme];
    // Decorations baked the previous palette's colors; drop them so the next
    // render recolors the viewport with the palette matching the new theme.
    this.disposeAllSemanticColors();
    this.refreshSearch();
    if (this.term.rows > 0) this.term.refresh(0, this.term.rows - 1);
  }

  setScrollback(scrollback: number) {
    if (this.scrollback === scrollback) return;
    this.scrollback = scrollback;
    this.term.options.scrollback = scrollback;
    this.trimLineMetadata();
    this.syncGutter();
  }

  /**
   * Find `query` in the buffer and highlight every match. `incremental`
   * keeps the current match selected while the query is still being typed,
   * instead of jumping to the next one.
   */
  search(query: string, forward = true, incremental = false) {
    if (!query) {
      this.clearSearch();
      return;
    }
    this.lastSearch = query;
    const options: ISearchOptions = {
      incremental,
      decorations: SEARCH_DECORATIONS[this.themeMode],
    };
    if (forward) this.searchAddon.findNext(query, options);
    else this.searchAddon.findPrevious(query, options);
  }

  /** Drop the match highlights; also stops re-searching on every write. */
  clearSearch() {
    this.lastSearch = null;
    this.searchAddon.clearDecorations();
  }

  /**
   * Re-run the last search so highlights pick up the current theme colors.
   * The addon only re-highlights when the term or matching options change,
   * so the decorations are cleared first.
   */
  private refreshSearch() {
    if (this.lastSearch === null) return;
    this.searchAddon.clearDecorations();
    this.searchAddon.findPrevious(this.lastSearch, {
      incremental: true,
      decorations: SEARCH_DECORATIONS[this.themeMode],
    });
  }

  scrollToLine(absoluteLine: number) {
    this.term.scrollToLine(Math.max(0, absoluteLine - this.firstLineNumber));
  }

  dispose() {
    this.disposed = true;
    this.dropAnchor();
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

  // --- command history & inline suggestions --------------------------------

  /**
   * Follows the user's keystrokes to delimit the command being composed.
   * Keystroke echo comes back from the shell, so the buffer — not the raw
   * input — is the source of truth for the command text; this only decides
   * *where* that text starts and *when* it was submitted.
   */
  private trackInput(data: string) {
    if (!this.suggestionsOn) return;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") {
      this.dropAnchor();
      return;
    }
    if (data === "\r") {
      this.captureCommand();
    } else if (data === "\x03") {
      // Ctrl+C abandons the line.
      this.dropAnchor();
    } else if (data.includes("\r")) {
      // A multi-line paste executed commands we did not watch being typed;
      // the anchor no longer describes anything real.
      this.dropAnchor();
    } else if (!this.inputAnchor) {
      const marker = this.term.registerMarker(0);
      if (marker) this.inputAnchor = { marker, col: buf.cursorX };
    }
    this.schedulePopupSync();
  }

  /**
   * Reads the command submitted with Enter. The buffer is read again after a
   * short delay so echoes still in flight from the remote (the last
   * keystrokes of a fast typist, or a shell erasing its own autosuggestion)
   * have settled; the immediate snapshot is the fallback in case the line is
   * gone by then (e.g. a `clear` in the executed command's output).
   */
  private captureCommand() {
    const anchor = this.inputAnchor;
    this.inputAnchor = null;
    this.dismissedInput = "";
    this.hidePopup();
    if (!anchor) return;

    const snapshot = this.readInput(anchor);
    window.setTimeout(() => {
      const settled = this.disposed ? null : this.readInput(anchor);
      anchor.marker.dispose();
      const command = (settled ?? snapshot ?? "")
        // A zsh-style right prompt shares the input row, separated from the
        // command by a run of padding spaces; cut it off. Three-plus literal
        // spaces inside a real command line are vanishingly rare.
        .replace(/ {3,}\S.*$/, "")
        .trimEnd();
      // A leading space opts out of history, mirroring the shells'
      // `ignorespace` convention. Length guards against captured output.
      if (!command || command.startsWith(" ") || command.length > 500) return;
      if (!this.disposed) this.callbacks.onCommand(command);
    }, 150);
  }

  /**
   * The typed text: anchor column to the end of the (soft-wrapped) line, or
   * to `end` (a buffer position, normally the cursor) when given. The popup
   * passes the cursor so trailing spaces the user typed survive (right-
   * trimming would corrupt the accepted remainder), a zsh-style right prompt
   * on the same row is never read as input, and a remote shell's own inline
   * autosuggestion after the cursor is ignored. Returns null when `end` does
   * not lie on the anchor's logical line.
   */
  private readInput(
    anchor: InputAnchor,
    end?: { row: number; col: number },
  ): string | null {
    if (anchor.marker.isDisposed) return null;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    let row = anchor.marker.line;
    const first = buf.getLine(row);
    if (!first) return null;

    const lines: { line: IBufferLine; start: number }[] = [
      { line: first, start: anchor.col },
    ];
    let next = buf.getLine(row + 1);
    while (next?.isWrapped && lines.length <= 10) {
      lines.push({ line: next, start: 0 });
      row += 1;
      next = buf.getLine(row + 1);
    }

    const lastIndex = end
      ? end.row - anchor.marker.line
      : lines.length - 1;
    if (lastIndex < 0 || lastIndex >= lines.length) return null;

    let text = "";
    for (let i = 0; i <= lastIndex; i += 1) {
      const { line, start } = lines[i];
      if (i < lastIndex) {
        // A wrapped row is filled edge to edge; every cell is content.
        text += line.translateToString(false, start);
      } else if (end) {
        text += line.translateToString(false, start, Math.max(end.col, start));
      } else {
        text += line.translateToString(true, start);
      }
    }
    return text;
  }

  private schedulePopupSync() {
    if (this.popupSyncScheduled || this.disposed) return;
    this.popupSyncScheduled = true;
    requestAnimationFrame(() => {
      this.popupSyncScheduled = false;
      if (!this.disposed) this.syncPopup();
    });
  }

  /**
   * Shows history matches for the typed input as a floating completion list
   * anchored to the cursor, IDE-style. The input is read up to the cursor
   * only, so a remote shell's own inline autosuggestion (fish,
   * zsh-autosuggestions) after the cursor never feeds back into ours.
   */
  private syncPopup() {
    const anchor = this.inputAnchor;
    if (!this.suggestionsOn || !anchor || !this.host) {
      this.hidePopup();
      return;
    }
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || anchor.marker.isDisposed) {
      this.hidePopup();
      return;
    }

    const cursorRow = buf.baseY + buf.cursorY;
    const input = this.readInput(anchor, {
      row: cursorRow,
      col: buf.cursorX,
    });
    if (!input || input === this.dismissedInput) {
      this.hidePopup();
      return;
    }

    const candidates = this.callbacks.suggest(input);
    if (candidates.length === 0) {
      this.hidePopup();
      return;
    }

    const viewRow = cursorRow - buf.viewportY;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (
      viewRow < 0 ||
      viewRow >= this.term.rows ||
      !screen ||
      this.term.cols === 0
    ) {
      this.hidePopup();
      return;
    }
    if (this.cellHeight <= 0) this.measureCell();
    if (this.cellHeight <= 0) {
      this.hidePopup();
      return;
    }

    const inputChanged = input !== this.popupInput;
    this.popupInput = input;
    this.candidates = candidates;
    // New input returns the popup to passive so stray navigation state never
    // survives a keystroke; stepping into the list is always deliberate.
    if (inputChanged) this.popupIndex = -1;
    else if (this.popupIndex >= candidates.length) {
      this.popupIndex = candidates.length - 1;
    }
    this.renderPopup();

    // Horizontally at the input's start (IDE convention), vertically under
    // the cursor row, flipped above when there is no room below.
    const screenRect = screen.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const cellWidth = screenRect.width / this.term.cols;
    const anchorCol = cursorRow === anchor.marker.line ? anchor.col : 0;
    const screenLeft = screenRect.left - hostRect.left;
    const screenTop = screenRect.top - hostRect.top;

    this.popup.classList.remove("is-hidden");
    this.popup.style.maxWidth = `${Math.max(120, hostRect.width - 12)}px`;
    const width = this.popup.offsetWidth;
    const height = this.popup.offsetHeight;
    const left = Math.max(
      0,
      Math.min(screenLeft + anchorCol * cellWidth, hostRect.width - width - 6),
    );
    let top = screenTop + (viewRow + 1) * this.cellHeight + 2;
    if (top + height > hostRect.height) {
      const above = screenTop + viewRow * this.cellHeight - height - 2;
      if (above >= 0) top = above;
    }
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  private renderPopup() {
    this.popup.replaceChildren();
    this.candidates.forEach((candidate, index) => {
      const row = document.createElement("div");
      row.className = `term-suggest-item${
        index === this.popupIndex ? " is-selected" : ""
      }`;
      row.setAttribute("role", "option");

      const { command, matchStart } = candidate;
      const matchEnd = matchStart + this.popupInput.length;
      const pre = document.createElement("span");
      pre.textContent = command.slice(0, matchStart);
      const match = document.createElement("span");
      match.className = "term-suggest-match";
      match.textContent = command.slice(matchStart, matchEnd);
      const post = document.createElement("span");
      post.textContent = command.slice(matchEnd);
      row.append(pre, match, post);

      row.addEventListener("mousedown", (event) => {
        // preventDefault keeps focus in the terminal.
        event.preventDefault();
        this.acceptSuggestion(index);
      });
      this.popup.appendChild(row);
    });
  }

  private setPopupIndex(index: number) {
    this.popupIndex = Math.max(
      -1,
      Math.min(index, this.candidates.length - 1),
    );
    const rows = this.popup.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle("is-selected", i === this.popupIndex);
    }
  }

  private acceptSuggestion(index: number) {
    const candidate = this.candidates[index] ?? this.candidates[0];
    if (!candidate) return;
    const input = this.popupInput;
    // A prefix match completes in place. Any other match erases the typed
    // input first — one backspace per code point, so the shell edits its own
    // line — then sends the full command.
    const data = candidate.command.startsWith(input)
      ? candidate.command.slice(input.length)
      : "\x7f".repeat([...input].length) + candidate.command;
    this.dismissedInput = candidate.command;
    this.hidePopup();
    if (data && !this.locked && !this.zmodem.isActive()) {
      this.callbacks.onData(data);
    }
  }

  private hidePopup() {
    if (this.candidates.length === 0) return;
    this.candidates = [];
    this.popupIndex = -1;
    this.popup.replaceChildren();
    this.popup.classList.add("is-hidden");
  }

  private dropAnchor() {
    this.inputAnchor?.marker.dispose();
    this.inputAnchor = null;
    this.dismissedInput = "";
    this.hidePopup();
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
   * Recolors the viewport. Rows keep their state (marker, last-seen text,
   * decorations) while they stay near the viewport; a row is only
   * re-processed when its text changes, so calling this from several hooks
   * per frame is cheap: an idle screen costs a few string compares per call
   * and a full-speed flood costs one viewport of regex work per frame
   * instead of per line.
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
    const { ranges, band }: { ranges: SemanticRange[]; band?: string } =
      text && text.length <= 4000 ? semanticLine(text) : { ranges: [] };

    const cursorIndex = buf.baseY + buf.cursorY;
    const rowMarkers = new Map<number, IMarker>();
    const rowDecorations = new Map<number, IDecoration[]>();
    const markerFor = (row: number): IMarker | undefined => {
      let marker = rowMarkers.get(row);
      if (!marker) {
        marker = this.term.registerMarker(row - cursorIndex) ?? undefined;
        if (marker) rowMarkers.set(row, marker);
      }
      return marker;
    };
    const record = (row: number, decoration: IDecoration) => {
      let list = rowDecorations.get(row);
      if (!list) rowDecorations.set(row, (list = []));
      list.push(decoration);
    };

    // A line band tints every row of the logical line behind the text. It is
    // painted on the bottom layer so selection still shows through, and only
    // on rows that carry no ANSI styling of their own, since a bottom-layer
    // decoration background replaces the cell's own background.
    if (band) {
      for (let row = first; row <= last; row += 1) {
        const line = buf.getLine(row);
        if (!line || !isUnstyledSpan(line, 0, line.length, work)) continue;
        const marker = markerFor(row);
        if (!marker) continue;
        const decoration = this.term.registerDecoration({
          marker,
          x: 0,
          width: this.term.cols,
          backgroundColor: band,
          layer: "bottom",
        });
        if (decoration) record(row, decoration);
      }
    }

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

        const marker = markerFor(row);
        if (!marker) continue;
        const decoration = this.term.registerDecoration({
          marker,
          x: startCol,
          width: endCol - startCol,
          foregroundColor: range.color,
          layer: "top",
        });
        if (!decoration) continue;
        if (range.underline) {
          // The decoration element is an empty overlay sized to the span;
          // a bottom border on it draws the underline.
          const color = range.color;
          decoration.onRender((element) => {
            element.classList.add("semantic-underline");
            element.style.borderBottomColor = color;
          });
        }
        record(row, decoration);
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

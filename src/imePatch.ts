import type { Terminal } from "@xterm/xterm";

/**
 * Exactly-once delivery of IME text for xterm.js 6.0.
 *
 * xterm reads keyboard input through a hidden textarea. Characters that an
 * input method commits reach it in three ways — the `input` event, the
 * textarea diff xterm takes on a keyCode-229 keydown, and the deferred read
 * of the textarea after `compositionend` — and each of those paths decides
 * on its own whether it should send. They were written against Chromium's
 * event order; WKWebView delivers `input` before the matching `keydown`,
 * and modern Chinese input methods keep every key on the IME path
 * (keyCode 229) even in English mode. The fallout, all still open upstream
 * on 6.0.0 and the 6.1 betas:
 *
 * - Fast English typing under WeChat / Doubao IME drops the second key of a
 *   rollover (issue #24 here; xtermjs/xterm.js#5887, #6045): the `input`
 *   path refuses to send while the previous key is still held.
 * - The first full-width punctuation after a held Shift is dropped
 *   (xtermjs/xterm.js#6144), same gate.
 * - A pinyin word confirmed with Space can arrive twice: a keydown that the
 *   IME did not claim sends the composition immediately and `compositionend`
 *   sends it again (xtermjs/xterm.js#5778), or an `input` that follows
 *   `compositionend` is sent by both the input path and the deferred read.
 * - Two compositions finishing before the deferred read runs lose one of
 *   them, because a single boolean guards every pending send
 *   (xtermjs/xterm.js#6089).
 * - The textarea is never cleared except on Enter and Ctrl+C, so the diff
 *   path can re-send everything typed since then (xtermjs/xterm.js#6078).
 *
 * This module replaces the composition helper and the `input` handler of a
 * terminal instance with one state machine built on a single invariant:
 * the textarea holds only text that has not been sent yet. Every send takes
 * the textarea's content past a high-water mark, moves the mark, and clears
 * the textarea once no composition is active. Which event triggers a send
 * no longer matters, so neither the event order nor how often the IME
 * reports keyCode 229 can duplicate or drop text.
 *
 * It reaches into xterm's private `_core`; the members it touches have been
 * stable since 5.x and are verified before anything is replaced. When they
 * are missing the terminal is left as xterm shipped it and a warning names
 * the reason, so an xterm upgrade fails loud rather than half-patched.
 */

/** The composition-helper surface `CoreBrowserTerminal` calls. */
interface CompositionHelperLike {
  readonly isComposing: boolean;
  compositionstart(): void;
  compositionupdate(ev: { data: string }): void;
  compositionend(): void;
  /** Returns whether xterm should keep processing the keydown. */
  keydown(ev: KeyboardEvent): boolean;
  updateCompositionElements(dontRecurse?: boolean): void;
}

/** The private members of xterm's `Terminal._core` the patch relies on. */
interface CoreLike {
  _compositionHelper?: CompositionHelperLike;
  _compositionView?: HTMLElement;
  _inputEvent?: (ev: InputEvent) => boolean;
  _keyPress?: (ev: KeyboardEvent) => boolean;
  _unprocessedDeadKey?: boolean;
}

/** keyCode values that never end a composition. */
const COMPOSITION_KEYCODES = new Set([
  229, // the IME is processing this key
  16, // Shift
  17, // Control
  18, // Alt
  20, // CapsLock
]);

class ImeInput implements CompositionHelperLike {
  private composing = false;
  /** Textarea offset where the active composition's text begins. */
  private compositionStart = 0;
  /** Textarea offset up to which text has already been sent. */
  private sent = 0;
  /**
   * The deferred send scheduled by the latest `compositionend`. Each one is
   * its own token: a newer composition supersedes it, and a keydown that
   * flushes cancels it, without touching any other timer's decision.
   */
  private pending: object | null = null;
  /**
   * The character xterm's keypress handler just sent. The browser inserts
   * it into the textarea right after, and the `input` event that reports
   * that insertion must not send it a second time.
   */
  private keypressChar: string | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly textarea: HTMLTextAreaElement,
    private readonly view: HTMLElement,
  ) {}

  get isComposing() {
    return this.composing;
  }

  compositionstart() {
    this.composing = true;
    const length = this.textarea.value.length;
    this.compositionStart = length;
    // xterm empties the textarea itself on Enter and Ctrl+C.
    if (this.sent > length) this.sent = length;
    this.view.textContent = "";
    this.view.classList.add("active");
    this.updateCompositionElements();
  }

  compositionupdate(ev: { data: string }) {
    this.view.textContent = ev.data;
    this.updateCompositionElements();
  }

  compositionend() {
    this.composing = false;
    this.view.classList.remove("active");
    this.view.textContent = "";
    // The browsers update the textarea after this event; read it on the
    // next task, when the committed text is in place. An `input` event that
    // lands in between (some IMEs clear the marked text, then insert the
    // final text) is left in the textarea for this read to pick up.
    const token = {};
    this.pending = token;
    setTimeout(() => {
      if (this.pending !== token) return;
      this.pending = null;
      this.sendUnsent();
    }, 0);
  }

  keydown(ev: KeyboardEvent): boolean {
    if (this.composing || this.pending) {
      if (COMPOSITION_KEYCODES.has(ev.keyCode)) return false;
      // A key the IME did not claim ends the composition from the
      // terminal's point of view: Enter's newline, an F-key's sequence or
      // the Japanese eisuu switch must follow the text that was being
      // composed, and `compositionend`, if it comes, then sends only what
      // is new. Modifier chords are left alone: the IME keeps composing
      // through them.
      if (!ev.ctrlKey && !ev.metaKey) {
        this.pending = null;
        this.sendUnsent(true);
      }
      return true;
    }
    // An IME-processed key outside a composition. Whatever text it
    // produces arrives through the `input` event; there is nothing to diff.
    return ev.keyCode !== 229;
  }

  /** Replaces `CoreBrowserTerminal._inputEvent`. */
  inputEvent(ev: InputEvent): boolean {
    if (
      !ev.data ||
      ev.inputType !== "insertText" ||
      this.term.options.screenReaderMode
    ) {
      return false;
    }
    // Text inserted while a composition is active, or while its committed
    // text is waiting to be read, belongs to the composition.
    if (ev.isComposing || this.composing || this.pending) return false;
    if (this.keypressChar === ev.data) {
      // Uppercase letters, Space and Option-composed characters go out from
      // xterm's keypress handler and land in the textarea afterwards.
      this.keypressChar = null;
      this.clearTextarea();
      return false;
    }
    this.send(ev.data);
    this.clearTextarea();
    return true;
  }

  /** Records what xterm's keypress handler sent; see `keypressChar`. */
  noteKeypress(ev: KeyboardEvent) {
    // The same derivation as xterm's `_keyPress`.
    const code =
      ev.charCode ||
      (ev.which === null || ev.which === undefined
        ? ev.keyCode
        : ev.which !== 0 && ev.charCode !== 0
          ? ev.which
          : 0);
    if (!code) return;
    this.keypressChar = String.fromCharCode(code);
    // The matching `input` event is dispatched in the same task.
    setTimeout(() => {
      this.keypressChar = null;
    }, 0);
  }

  /**
   * Positions the composition overlay on the cursor and the textarea under
   * it, so the IME's candidate window opens where the text will appear.
   */
  updateCompositionElements(dontRecurse?: boolean) {
    if (!this.composing) return;
    const screen = this.term.element?.querySelector<HTMLElement>(
      ".xterm-screen",
    );
    const { cols, rows } = this.term;
    if (screen && cols > 0 && rows > 0) {
      const buf = this.term.buffer.active;
      const row = buf.baseY + buf.cursorY - buf.viewportY;
      if (row >= 0 && row < rows) {
        // The screen spans exactly cols × rows cells.
        const cellWidth = screen.clientWidth / cols;
        const cellHeight = screen.clientHeight / rows;
        const left = `${Math.min(buf.cursorX, cols - 1) * cellWidth}px`;
        const top = `${row * cellHeight}px`;
        const view = this.view.style;
        view.left = left;
        view.top = top;
        view.height = `${cellHeight}px`;
        view.lineHeight = `${cellHeight}px`;
        view.fontFamily = this.term.options.fontFamily ?? "";
        view.fontSize = `${this.term.options.fontSize ?? 15}px`;
        const bounds = this.view.getBoundingClientRect();
        const textarea = this.textarea.style;
        textarea.left = left;
        textarea.top = top;
        // At least 1×1, or some IMEs refuse to open.
        textarea.width = `${Math.max(bounds.width, 1)}px`;
        textarea.height = `${Math.max(bounds.height, 1)}px`;
        textarea.lineHeight = `${bounds.height}px`;
      }
    }
    // Composition events are not consistently ordered across browsers;
    // a second pass on the next task catches up with the late ones.
    if (!dontRecurse) {
      setTimeout(() => this.updateCompositionElements(true), 0);
    }
  }

  /**
   * Sends the textarea's unsent text. An open composition is left out (it
   * is sent when it commits) unless `includeComposition` asks for it, as a
   * keydown that ends the composition does.
   */
  private sendUnsent(includeComposition = false) {
    const value = this.textarea.value;
    const end =
      this.composing && !includeComposition
        ? this.compositionStart
        : value.length;
    const start = Math.min(this.sent, value.length);
    const text = value.substring(start, Math.max(start, end));
    this.sent = Math.max(start, end);
    if (text) this.send(text);
    this.clearTextarea();
  }

  private send(text: string) {
    this.term.input(text, true);
  }

  private clearTextarea() {
    if (this.composing) return;
    this.textarea.value = "";
    this.sent = 0;
  }
}

/**
 * Installs the exactly-once IME handling on an opened terminal. Returns
 * false, leaving the terminal untouched, when xterm's internals are not the
 * ones this patch was written against.
 */
export function patchImeInput(term: Terminal): boolean {
  const core = (term as unknown as { _core?: CoreLike })._core;
  const missing = (() => {
    if (!core) return "_core";
    if (typeof core._compositionHelper?.keydown !== "function") {
      return "_core._compositionHelper";
    }
    if (!(core._compositionView instanceof HTMLElement)) {
      return "_core._compositionView";
    }
    if (typeof core._inputEvent !== "function") return "_core._inputEvent";
    if (typeof core._keyPress !== "function") return "_core._keyPress";
    if (!term.textarea) return "textarea";
    return null;
  })();
  if (missing || !core) {
    console.warn(
      `xterm IME patch not applied: ${missing ?? "unknown"} is missing; ` +
        "IME input runs on xterm's own handling",
    );
    return false;
  }

  const ime = new ImeInput(term, term.textarea!, core._compositionView!);
  core._compositionHelper = ime;
  core._inputEvent = (ev) => {
    const sent = ime.inputEvent(ev);
    // As in xterm's own handler: input arriving means no dead key is
    // pending any more.
    if (sent && "_unprocessedDeadKey" in core) core._unprocessedDeadKey = false;
    return sent;
  };
  const keyPress = core._keyPress!;
  core._keyPress = (ev) => {
    const handled = keyPress.call(core, ev);
    if (handled) ime.noteKeypress(ev);
    return handled;
  };
  return true;
}

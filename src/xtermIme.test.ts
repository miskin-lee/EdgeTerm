import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { patchImeInput } from "./imePatch";

/**
 * Replays the keyboard, input and composition events a browser dispatches on
 * xterm's hidden textarea, with the textarea's value updated the way the
 * browser would, and checks what the terminal sends through `onData`.
 *
 * The sequences are the ones traced in the upstream reports linked from
 * imePatch.ts: WKWebView fires `input` before the keydown of the same key,
 * IMEs in English mode report keyCode 229 for every key, and so on.
 */

type KeyInit = KeyboardEventInit & { keyCode?: number; charCode?: number };

function keyEvent(type: string, init: KeyInit) {
  const ev = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  // jsdom accepts the legacy fields only on some versions.
  if (init.keyCode !== undefined && ev.keyCode !== init.keyCode) {
    Object.defineProperty(ev, "keyCode", { get: () => init.keyCode });
  }
  if (init.charCode !== undefined && ev.charCode !== init.charCode) {
    Object.defineProperty(ev, "charCode", { get: () => init.charCode });
  }
  return ev;
}

const IME_KEYCODE = 229;

class Harness {
  readonly term: Terminal;
  readonly out: string[] = [];
  readonly textarea: HTMLTextAreaElement;
  private markStart = 0;

  constructor() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    this.term = new Terminal({ allowProposedApi: true });
    this.term.onData((data) => this.out.push(data));
    this.term.open(host);
    expect(patchImeInput(this.term)).toBe(true);
    this.textarea = this.term.textarea!;
  }

  dispose() {
    this.term.dispose();
  }

  keydown(key: string, keyCode: number, extra: KeyboardEventInit = {}) {
    this.textarea.dispatchEvent(
      keyEvent("keydown", { key, keyCode, ...extra }),
    );
  }

  keyup(key: string, keyCode: number, extra: KeyboardEventInit = {}) {
    this.textarea.dispatchEvent(keyEvent("keyup", { key, keyCode, ...extra }));
  }

  keypress(charCode: number) {
    this.textarea.dispatchEvent(
      keyEvent("keypress", {
        key: String.fromCharCode(charCode),
        charCode,
        keyCode: charCode,
      }),
    );
  }

  /** The browser inserting text at the end of the textarea. */
  insert(text: string, inputType = "insertText") {
    this.textarea.value += text;
    this.textarea.dispatchEvent(
      new InputEvent("input", {
        inputType,
        data: text,
        isComposing: false,
        bubbles: true,
      }),
    );
  }

  compositionStart() {
    this.markStart = this.textarea.value.length;
    this.textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { data: "", bubbles: true }),
    );
  }

  /** The IME replacing the marked text. */
  compositionUpdate(marked: string) {
    this.textarea.value = this.textarea.value.slice(0, this.markStart) + marked;
    this.textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", {
        data: marked,
        bubbles: true,
      }),
    );
    this.textarea.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: marked,
        isComposing: true,
        bubbles: true,
      }),
    );
  }

  /**
   * The IME committing `committed` in place of the marked text, the way
   * WebKit's confirmComposition does: the value changes, `compositionend`
   * fires, then an `input` of type insertFromComposition.
   */
  compositionEnd(committed: string) {
    this.textarea.value =
      this.textarea.value.slice(0, this.markStart) + committed;
    this.textarea.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: committed,
        bubbles: true,
      }),
    );
    this.textarea.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertFromComposition",
        data: committed,
        isComposing: false,
        bubbles: true,
      }),
    );
  }

  /** A pinyin word typed and confirmed with Space on WKWebView. */
  typePinyinWord(pinyin: string, committed: string) {
    this.compositionStart();
    for (let i = 1; i <= pinyin.length; i += 1) {
      this.compositionUpdate(pinyin.slice(0, i));
      this.keydown(pinyin[i - 1], IME_KEYCODE);
      this.keyup(pinyin[i - 1], pinyin.toUpperCase().charCodeAt(i - 1));
    }
    this.compositionEnd(committed);
    this.keydown(" ", IME_KEYCODE);
    this.keyup(" ", 32);
  }
}

describe("IME input on xterm", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = new Harness();
  });

  afterEach(() => {
    h.dispose();
    vi.useRealTimers();
  });

  it("sends a plain key through xterm's own path", () => {
    h.keydown("a", 65);
    expect(h.out).toEqual(["a"]);
  });

  it("keeps every key of a fast English rollover under an IME (WKWebView order)", () => {
    // WeChat / Doubao IME in English mode: keyCode 229 on every key, the
    // input event before the keydown, keyups only once the burst is over.
    for (const c of "docker") {
      h.insert(c);
      h.keydown(c, IME_KEYCODE);
    }
    for (const c of "docker") h.keyup(c, c.toUpperCase().charCodeAt(0));
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["d", "o", "c", "k", "e", "r"]);
    expect(h.textarea.value).toBe("");
  });

  it("keeps an IME-processed key in Chromium order too", () => {
    h.keydown("j", IME_KEYCODE);
    h.insert("j");
    h.keyup("j", 74);
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["j"]);
    expect(h.textarea.value).toBe("");
  });

  it("keeps the first full-width punctuation typed with Shift held", () => {
    h.keydown("Shift", 16, { shiftKey: true });
    h.insert("！");
    h.keydown("！", IME_KEYCODE, { shiftKey: true });
    h.keyup("！", 49, { shiftKey: true });
    h.insert("！");
    h.keydown("！", IME_KEYCODE, { shiftKey: true });
    h.keyup("！", 49, { shiftKey: true });
    h.keyup("Shift", 16);
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["！", "！"]);
  });

  it("sends keypress-typed characters once and leaves the textarea empty", () => {
    // Uppercase letters and Space go out from xterm's keypress handler and
    // are then inserted into the textarea by the browser.
    h.keydown("H", 72, { shiftKey: true });
    h.keypress(72);
    h.insert("H");
    h.keyup("H", 72, { shiftKey: true });
    h.keydown(" ", 32);
    h.keypress(32);
    h.insert(" ");
    h.keyup(" ", 32);
    // An IME-processed key that inserts nothing must not replay anything.
    h.keydown("Process", IME_KEYCODE);
    h.keyup("Process", 229);
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["H", " "]);
    expect(h.textarea.value).toBe("");
  });

  it("sends a pinyin word confirmed with Space exactly once", () => {
    h.typePinyinWord("nihao", "你好");
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["你好"]);
    expect(h.textarea.value).toBe("");
    // Typing goes on normally afterwards.
    h.keydown("a", 65);
    expect(h.out).toEqual(["你好", "a"]);
  });

  it("sends a word once when the IME clears the marked text and inserts the result", () => {
    h.compositionStart();
    h.compositionUpdate("nihao");
    // Marked text withdrawn: compositionend reports what is left (nothing).
    h.textarea.value = "";
    h.textarea.dispatchEvent(
      new CompositionEvent("compositionend", { data: "", bubbles: true }),
    );
    h.insert("你好");
    h.keydown(" ", IME_KEYCODE);
    h.keyup(" ", 32);
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["你好"]);
    expect(h.textarea.value).toBe("");
  });

  it("does not repeat a composition ended by a key the IME did not claim", () => {
    // xtermjs/xterm.js#5778: eisuu (here F7) ends the composition; xterm
    // sends it on the keydown and again after compositionend.
    h.compositionStart();
    h.compositionUpdate("こんにちは");
    h.keydown("F7", 118);
    h.compositionEnd("こんにちは");
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["こんにちは", "\x1b[18~"]);
    expect(h.textarea.value).toBe("");
  });

  it("sends a committed word before the Enter that follows it", () => {
    h.compositionStart();
    h.compositionUpdate("nihao");
    h.compositionEnd("你好");
    h.keydown("Enter", 13);
    expect(h.out).toEqual(["你好", "\r"]);
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["你好", "\r"]);
    expect(h.textarea.value).toBe("");
  });

  it("loses nothing when two compositions finish before the deferred read", () => {
    // xtermjs/xterm.js#6089: Korean commits a syllable the moment the next
    // one starts; under load both finish before any timer runs.
    h.compositionStart();
    h.compositionUpdate("니");
    h.compositionEnd("니");
    h.compositionStart();
    h.compositionUpdate("다");
    h.compositionEnd("다");
    h.keydown(".", 190);
    vi.advanceTimersByTime(10);
    expect(h.out.join("")).toBe("니다.");
    expect(h.out[h.out.length - 1]).toBe(".");
    expect(h.textarea.value).toBe("");
  });

  it("sends each composition once when the timer runs between them", () => {
    h.compositionStart();
    h.compositionUpdate("니");
    h.compositionEnd("니");
    vi.advanceTimersByTime(10);
    h.compositionStart();
    h.compositionUpdate("다");
    h.compositionEnd("다");
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["니", "다"]);
  });

  it("sends the text before a new composition and the rest after it", () => {
    // The deferred read runs while the next composition is already open:
    // only the committed text goes out, the new marked text stays.
    h.compositionStart();
    h.compositionUpdate("니");
    h.compositionEnd("니");
    h.compositionStart();
    h.compositionUpdate("ㄷ");
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["니"]);
    h.compositionUpdate("다");
    h.compositionEnd("다");
    vi.advanceTimersByTime(10);
    expect(h.out).toEqual(["니", "다"]);
  });

  it("leaves a Ctrl chord during composition to xterm without flushing", () => {
    h.compositionStart();
    h.compositionUpdate("nihao");
    h.keydown("c", 67, { ctrlKey: true });
    expect(h.out).toEqual(["\x03"]);
  });
});

describe("patchImeInput", () => {
  it("declines a terminal whose internals it does not recognise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Not opened: xterm has not created its composition helper yet.
    expect(patchImeInput(new Terminal())).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

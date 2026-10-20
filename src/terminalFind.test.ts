import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { TerminalController } from "./terminal";
import { TerminalFind } from "./terminalFind";
import {
  compileQuery,
  DEFAULT_FIND_OPTIONS,
  findInText,
  queryError,
  setFindCloser,
  type FindOptions,
  type SearchResults,
} from "./terminalSearch";

const COLORS = { match: "#623315", activeMatch: "#9e6a03", scope: "#2b2d30" };

const options = (overrides: Partial<FindOptions> = {}): FindOptions => ({
  ...DEFAULT_FIND_OPTIONS,
  ...overrides,
});

const matches = (text: string, query: string, opts = options()) =>
  findInText(text, compileQuery(query, opts), opts.wholeWord).map(([s, e]) =>
    text.slice(s, e),
  );

const offsets = (text: string, query: string, opts = options()) =>
  findInText(text, compileQuery(query, opts), opts.wholeWord).map(([s]) => s);

describe("matching a line", () => {
  it("ignores case unless Match Case is on", () => {
    expect(matches("Error error ERROR", "error")).toEqual([
      "Error",
      "error",
      "ERROR",
    ]);
    expect(
      matches("Error error ERROR", "error", options({ caseSensitive: true })),
    ).toEqual(["error"]);
  });

  it("takes plain text literally", () => {
    expect(matches("a.b axb (x)", "a.b")).toEqual(["a.b"]);
    expect(matches("a.b axb (x)", "(x)")).toEqual(["(x)"]);
  });

  it("keeps looking past a hit inside a longer word", () => {
    const whole = options({ wholeWord: true });
    expect(offsets("foobar foo", "foo", whole)).toEqual([7]);
    expect(offsets("foo_bar foo-bar", "foo", whole)).toEqual([8]);
    expect(offsets("foo", "foo", whole)).toEqual([0]);
  });

  it("counts a separator at the edge of the match as a boundary", () => {
    const whole = options({ wholeWord: true });
    expect(offsets("ls -v", "-v", whole)).toEqual([3]);
    expect(offsets("x=1", "x=", whole)).toEqual([0]);
  });

  it("anchors ^ and $ to the line, not to the previous hit", () => {
    const regex = options({ regex: true });
    expect(offsets("aaaa", "^a", regex)).toEqual([0]);
    expect(offsets("a a a", "a$", regex)).toEqual([4]);
  });

  it("skips empty matches", () => {
    expect(matches("bab", "a*", options({ regex: true }))).toEqual(["a"]);
    expect(matches("abc", "^", options({ regex: true }))).toEqual([]);
  });

  it("applies Whole Word to regular expressions as well", () => {
    expect(
      matches("eth0 eth10 veth1", "eth\\d", options({ regex: true, wholeWord: true })),
    ).toEqual(["eth0"]);
  });

  it("explains a malformed regular expression and accepts text", () => {
    expect(queryError("(", options({ regex: true }))).toMatch(/./);
    expect(queryError("(", options())).toBeNull();
    expect(queryError("", options({ regex: true }))).toBeNull();
  });
});

// --- the engine on a real terminal -------------------------------------------

const terminals: Terminal[] = [];
const finders: TerminalFind[] = [];

function setup(cols = 20, rows = 5) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 100 });
  term.open(host);
  const find = new TerminalFind(term, COLORS);
  const results: SearchResults[] = [];
  find.onResults((r) => results.push(r));
  terminals.push(term);
  finders.push(find);
  return { term, find, results, last: () => results[results.length - 1] };
}

const write = (term: Terminal, text: string) =>
  new Promise<void>((resolve) => term.write(text, resolve));

const lines = (...rows: string[]) => rows.join("\r\n");

afterEach(() => {
  for (const find of finders.splice(0)) find.dispose();
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
  setFindCloser(null);
});

describe("finding in the buffer", () => {
  it("counts the matches and selects the first", async () => {
    const { term, find, last } = setup();
    await write(term, lines("one foo", "two", "foo foo"));

    find.find("foo", options(), true, true);

    expect(last()).toEqual({ resultIndex: 0, resultCount: 3 });
    expect(term.getSelectionPosition()).toEqual({
      start: { x: 4, y: 0 },
      end: { x: 7, y: 0 },
    });
  });

  it("steps forward and back, wrapping at either end", async () => {
    const { term, find, last } = setup();
    await write(term, lines("foo", "foo", "foo"));

    find.find("foo", options(), true, true);
    find.find("foo", options(), true, false);
    expect(last().resultIndex).toBe(1);
    find.find("foo", options(), true, false);
    find.find("foo", options(), true, false);
    expect(last().resultIndex).toBe(0);
    find.find("foo", options(), false, false);
    expect(last().resultIndex).toBe(2);
    expect(term.getSelection()).toBe("foo");
  });

  it("finds whole words after a non-word hit on the same row", async () => {
    const { term, find, last } = setup();
    await write(term, "foobar foo");

    find.find("foo", options({ wholeWord: true }), true, true);

    expect(last()).toEqual({ resultIndex: 0, resultCount: 1 });
    expect(term.getSelectionPosition()?.start).toEqual({ x: 7, y: 0 });
  });

  it("selects wide characters by their cells", async () => {
    const { term, find } = setup();
    await write(term, "中文 foo");

    find.find("foo", options(), true, true);
    expect(term.getSelectionPosition()?.start).toEqual({ x: 5, y: 0 });

    find.find("文", options(), true, true);
    expect(term.getSelectionPosition()).toEqual({
      start: { x: 2, y: 0 },
      end: { x: 4, y: 0 },
    });
  });

  it("matches across a wrapped row", async () => {
    const { term, find, last } = setup(10);
    await write(term, "0123456789needle");

    find.find("89needle", options(), true, true);

    expect(last().resultCount).toBe(1);
    expect(term.getSelection()).toBe("89needle");
  });

  it("clears the highlights for an invalid regex and leaves the selection", async () => {
    const { term, find, last } = setup();
    await write(term, "foo (bar");
    find.find("foo", options({ regex: true }), true, true);

    find.find("(", options({ regex: true }), true, true);

    expect(last()).toEqual({ resultIndex: -1, resultCount: 0 });
    expect(term.getSelection()).toBe("foo");
  });

  it("drops the selection when nothing matches", async () => {
    const { term, find, last } = setup();
    await write(term, "foo");
    find.find("foo", options(), true, true);

    find.find("bar", options(), true, true);

    expect(last()).toEqual({ resultIndex: -1, resultCount: 0 });
    expect(term.hasSelection()).toBe(false);
  });
});

describe("while output arrives", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  /** The engine's decorations, which must never overlap. */
  const decorations = (find: TerminalFind) => {
    const internals = find as unknown as {
      highlights: { isDisposed: boolean }[][];
      activeDecorations: { isDisposed: boolean }[];
    };
    const live = (list: { isDisposed: boolean }[]) =>
      list.filter((item) => !item.isDisposed).length;
    return {
      highlights: internals.highlights.reduce((n, list) => n + live(list), 0),
      active: live(internals.activeDecorations),
    };
  };

  it("paints the current match apart from the others", async () => {
    const { term, find } = setup();
    await write(term, lines("foo", "foo", "foo"));

    find.find("foo", options(), true, true);
    expect(decorations(find)).toEqual({ highlights: 2, active: 1 });
    find.find("foo", options(), true, false);
    expect(decorations(find)).toEqual({ highlights: 2, active: 1 });
  });

  it("recounts once output pauses, keeping the current match", async () => {
    const { term, find, last } = setup();
    await write(term, lines("foo", "bar"));
    find.find("foo", options(), true, true);

    await write(term, "\r\nfoo");
    await settle();

    expect(last()).toEqual({ resultIndex: 0, resultCount: 2 });
    expect(decorations(find)).toEqual({ highlights: 1, active: 1 });
  });

  it("follows the current match as the scrollback is trimmed", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3, scrollback: 3 });
    term.open(host);
    terminals.push(term);
    const find = new TerminalFind(term, COLORS);
    finders.push(find);
    let latest: SearchResults | null = null;
    find.onResults((r) => (latest = r));
    await write(term, lines("foo a", "foo b", "x"));
    find.find("foo", options(), true, true);
    find.find("foo", options(), true, false);
    expect(term.getSelection()).toBe("foo");

    // Seven rows in a buffer of six: "foo a" is trimmed, "foo b" moves up.
    await write(term, "\r\n1\r\n2\r\n3\r\n4");
    await settle();

    expect(latest).toEqual({ resultIndex: 0, resultCount: 1 });
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("foo b");
  });
});

describe("Find in Selection", () => {
  const rows = lines("foo 0", "foo 1", "foo 2", "foo 3");

  it("searches only the selected rows", async () => {
    const { term, find, last } = setup();
    await write(term, rows);
    term.selectLines(1, 2);

    expect(find.setScope(true)).toBe(true);
    find.find("foo", options(), true, true);

    expect(last()).toEqual({ resultIndex: 0, resultCount: 2 });
    expect(term.getSelectionPosition()?.start).toEqual({ x: 0, y: 1 });
    find.find("foo", options(), true, false);
    find.find("foo", options(), true, false);
    expect(term.getSelectionPosition()?.start).toEqual({ x: 0, y: 1 });
  });

  it("takes the selection a search replaced", async () => {
    const { term, find, last } = setup();
    await write(term, rows);
    term.selectLines(2, 3);
    // Typed first: the query's first match now holds the selection.
    find.find("foo", options(), true, true);
    expect(term.getSelectionPosition()?.start).toEqual({ x: 0, y: 2 });

    expect(find.setScope(true)).toBe(true);
    find.find("foo", options(), true, true);

    expect(last().resultCount).toBe(2);
  });

  it("respects partial rows at the ends of the range", async () => {
    const { term, find, last } = setup();
    await write(term, "foo foo foo");
    term.select(2, 0, 6);

    find.setScope(true);
    find.find("foo", options(), true, true);

    expect(last()).toEqual({ resultIndex: 0, resultCount: 1 });
    expect(term.getSelectionPosition()?.start).toEqual({ x: 4, y: 0 });
  });

  it("does not turn on without a selection, and turns off", async () => {
    const { term, find, last } = setup();
    await write(term, rows);

    expect(find.setScope(true)).toBe(false);

    term.selectLines(0, 0);
    find.setScope(true);
    find.setScope(false);
    find.find("foo", options(), true, true);
    expect(last().resultCount).toBe(4);
  });

  it("keeps the range when the query is emptied", async () => {
    const { term, find, last } = setup();
    await write(term, rows);
    term.selectLines(3, 3);
    find.setScope(true);
    find.find("foo", options(), true, true);

    find.find("", options(), true, true);
    find.find("foo", options(), true, true);

    expect(last().resultCount).toBe(1);
  });
});

describe("Esc in the terminal", () => {
  function controller() {
    return new TerminalController(
      "find-test",
      {
        onData() {},
        onResize() {},
        onStatus() {},
        onCommand() {},
        onCommandState() {},
        suggest: () => [],
        forgetSuggestion() {},
        onReconnect() {},
      },
      13,
      100,
    );
  }

  const filterKey = (target: TerminalController, init: KeyboardEventInit) =>
    (
      target as unknown as { filterKey: (event: KeyboardEvent) => boolean }
    ).filterKey(new KeyboardEvent("keydown", init));

  it("closes the find box instead of reaching the shell", () => {
    const target = controller();
    const close = vi.fn();
    setFindCloser(close);

    expect(filterKey(target, { key: "Escape" })).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    target.dispose();
  });

  it("goes to the shell when the box is closed or with a modifier", () => {
    const target = controller();
    expect(filterKey(target, { key: "Escape" })).toBe(true);

    const close = vi.fn();
    setFindCloser(close);
    expect(filterKey(target, { key: "Escape", shiftKey: true })).toBe(true);
    expect(close).not.toHaveBeenCalled();
    target.dispose();
  });
});

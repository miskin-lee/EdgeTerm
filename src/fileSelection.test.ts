import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  TYPE_SELECT_RESET_MS,
  batchCollisions,
  batchItemName,
  clickMode,
  replacePrompt,
  selectEntry,
  selectForMenu,
  selectedEntries,
  typeToSelect,
  type TypeRun,
} from "./fileSelection";
import type { FileEntry } from "./types";

const entry = (name: string, isDir = false, isSymlink = false): FileEntry => ({
  name,
  path: `/srv/${name}`,
  isDir,
  isSymlink,
  size: 1,
  modified: null,
  permissions: null,
  owner: null,
  group: null,
});

const press = (
  modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {},
  button = 0,
) => ({
  button,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...modifiers,
});

const order = ["/a", "/b", "/c", "/d", "/e"];

describe("clickMode", () => {
  it("toggles with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(clickMode(press({ metaKey: true }), true)).toBe("toggle");
    expect(clickMode(press({ ctrlKey: true }), false)).toBe("toggle");
    expect(clickMode(press({ metaKey: true }), false)).toBe("replace");
  });

  it("extends with Shift and replaces on a plain click", () => {
    expect(clickMode(press({ shiftKey: true }), true)).toBe("range");
    expect(clickMode(press({ shiftKey: true }), false)).toBe("range");
    expect(clickMode(press(), true)).toBe("replace");
  });

  it("leaves right clicks and macOS Control-click to the context menu", () => {
    expect(clickMode(press({}, 2), false)).toBeNull();
    expect(clickMode(press({}, 1), true)).toBeNull();
    expect(clickMode(press({ ctrlKey: true }), true)).toBeNull();
  });
});

describe("selectEntry", () => {
  it("replaces the selection with a plain click", () => {
    const selection = { paths: ["/a", "/c"], anchor: "/c" };
    expect(selectEntry(selection, order, "/d", "replace")).toEqual({
      paths: ["/d"],
      anchor: "/d",
    });
  });

  it("adds and drops single entries with a toggle", () => {
    let selection = selectEntry(EMPTY_SELECTION, order, "/b", "replace");
    selection = selectEntry(selection, order, "/d", "toggle");
    expect(selection).toEqual({ paths: ["/b", "/d"], anchor: "/d" });
    selection = selectEntry(selection, order, "/b", "toggle");
    expect(selection).toEqual({ paths: ["/d"], anchor: "/b" });
  });

  it("selects the span from the anchor in either direction", () => {
    const down = selectEntry(
      { paths: ["/b"], anchor: "/b" },
      order,
      "/d",
      "range",
    );
    expect(down).toEqual({ paths: ["/b", "/c", "/d"], anchor: "/b" });
    // The anchor stays, so a second Shift-click re-spans from it.
    expect(selectEntry(down, order, "/a", "range")).toEqual({
      paths: ["/a", "/b"],
      anchor: "/b",
    });
  });

  it("starts over when there is no anchor or it is no longer listed", () => {
    expect(selectEntry(EMPTY_SELECTION, order, "/c", "range")).toEqual({
      paths: ["/c"],
      anchor: "/c",
    });
    expect(
      selectEntry({ paths: ["/z"], anchor: "/z" }, order, "/c", "range"),
    ).toEqual({ paths: ["/c"], anchor: "/c" });
  });
});

describe("selectForMenu", () => {
  it("keeps a selection the clicked entry belongs to", () => {
    const selection = { paths: ["/a", "/c"], anchor: "/c" };
    expect(selectForMenu(selection, "/a")).toBe(selection);
    expect(selectForMenu(selection, "/b")).toEqual({
      paths: ["/b"],
      anchor: "/b",
    });
  });
});

describe("selectedEntries", () => {
  it("returns entries in list order, not in click order", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const picked = selectedEntries(entries, {
      paths: ["/srv/c", "/srv/a", "/srv/gone"],
      anchor: "/srv/a",
    });
    expect(picked.map((item) => item.name)).toEqual(["a", "c"]);
  });
});

describe("typeToSelect", () => {
  const key = (
    name: string,
    modifiers: Partial<
      Record<"ctrlKey" | "metaKey" | "altKey" | "isComposing", boolean>
    > = {},
  ) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...modifiers,
  });

  /**
   * Types `text` into a list of `names`, a key every `gap` ms, the way the
   * panels do; the name selected after each key, or "-" for none.
   */
  const typeInto = (names: string[], text: string, gap = 100) => {
    const entries = names.map((name) => entry(name));
    let selection = EMPTY_SELECTION;
    let run: TypeRun | null = null;
    return [...text].map((char, index) => {
      const typed = typeToSelect(
        entries,
        selection,
        run,
        key(char),
        index * gap,
      );
      if (!typed) throw new Error(`"${char}" was not taken as typing`);
      run = typed.run;
      const picked = entries[typed.index];
      if (!picked) return "-";
      selection = { paths: [picked.path], anchor: picked.path };
      return picked.name;
    });
  };

  const home = ["Desktop", "docs", "Downloads", "etc", "Music"];

  it("selects the first name starting with what was typed, ignoring case", () => {
    expect(typeInto(home, "dow")).toEqual(["Desktop", "docs", "Downloads"]);
    expect(typeInto(home, "MU")).toEqual(["Music", "Music"]);
  });

  it("starts over after a pause, moving on from the selected entry", () => {
    expect(typeInto(home, "dd", TYPE_SELECT_RESET_MS)).toEqual([
      "Desktop",
      "docs",
    ]);
    expect(typeInto(home, "ddd", TYPE_SELECT_RESET_MS)).toEqual([
      "Desktop",
      "docs",
      "Downloads",
    ]);
  });

  it("steps through the names a repeated letter starts", () => {
    expect(typeInto(["a", "s1", "s2", "s3"], "ssss")).toEqual([
      "s1",
      "s2",
      "s3",
      "s1",
    ]);
    // Unless a name starts with the repeats themselves.
    expect(typeInto(["s3.txt", "src", "ssh", "sudo"], "sss")).toEqual([
      "s3.txt",
      "ssh",
      "sudo",
    ]);
  });

  it("keeps the selection when no name matches", () => {
    expect(typeInto(home, "dx")).toEqual(["Desktop", "-"]);
    expect(typeInto(home, "q")).toEqual(["-"]);
  });

  it("takes a space only inside a run", () => {
    const entries = [entry("Mydata"), entry("My Documents")];
    expect(
      typeToSelect(entries, EMPTY_SELECTION, null, key(" "), 0),
    ).toBeNull();
    expect(typeInto(["Mydata", "My Documents"], "my d")).toEqual([
      "Mydata",
      "Mydata",
      "My Documents",
      "My Documents",
    ]);
  });

  it("matches a decomposed name against a composed key", () => {
    expect(typeInto(["etc", "E\u0301cran.png"], "\u00e9")).toEqual([
      "E\u0301cran.png",
    ]);
  });

  it("leaves shortcuts, named keys and composition alone", () => {
    const entries = home.map((name) => entry(name));
    const ignored = [
      key("d", { metaKey: true }),
      key("d", { ctrlKey: true }),
      key("d", { altKey: true }),
      key("d", { isComposing: true }),
      key("Enter"),
      key("ArrowDown"),
    ];
    for (const press of ignored) {
      expect(typeToSelect(entries, EMPTY_SELECTION, null, press, 0)).toBeNull();
    }
  });
});

describe("batchCollisions", () => {
  it("lists names already taken by the same kind", () => {
    const result = batchCollisions(
      [entry("app.log"), entry("conf", true), entry("new.txt")],
      [entry("app.log"), entry("conf", true), entry("other")],
      "local",
    );
    expect(result.blocked).toBeNull();
    expect(result.existing.map((item) => item.name)).toEqual([
      "app.log",
      "conf",
    ]);
  });

  it("stops the whole batch on a clash with the other kind", () => {
    const result = batchCollisions(
      [entry("ok.txt"), entry("data")],
      [entry("ok.txt"), entry("data", true)],
      "local",
    );
    expect(result.blocked).toBe("A local folder named “data” already exists.");
    expect(result.existing).toEqual([]);
  });

  it("refuses local links and names that would leave the folder", () => {
    expect(
      batchCollisions([entry("x")], [entry("x", false, true)], "local").blocked,
    ).toBe("Refusing to replace local symlink “x”.");
    for (const name of ["..", ".", "", "a/b", "a\\b", "nul\0"]) {
      expect(batchCollisions([entry(name)], [], "local").blocked).toContain(
        "is not a file name",
      );
    }
    // Uploads write through the server, which handles its own links.
    expect(
      batchCollisions([entry("x")], [entry("x", false, true)], "remote")
        .blocked,
    ).toBeNull();
  });

  it("matches names case-insensitively when asked", () => {
    const items = [entry("README.md")];
    const present = [entry("readme.md")];
    expect(batchCollisions(items, present, "local").existing).toEqual([]);
    expect(
      batchCollisions(items, present, "local", true).existing.map(
        (item) => item.name,
      ),
    ).toEqual(["README.md"]);
  });
});

describe("replacePrompt", () => {
  it("keeps the single-item wording", () => {
    expect(replacePrompt([entry("a.txt")], "remote")).toEqual({
      message: "Replace remote file “a.txt”?",
      okLabel: "Replace",
    });
    expect(replacePrompt([entry("logs", true)], "local").okLabel).toBe("Merge");
  });

  it("names the first few items of a batch and counts the rest", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const prompt = replacePrompt(
      names.map((name) => entry(name)),
      "local",
    );
    expect(prompt.message).toContain(
      "7 items already exist in the local folder: “a”, “b”, “c”, “d”, “e”, and 2 more.",
    );
    expect(prompt.okLabel).toBe("Replace");
  });
});

describe("batchItemName", () => {
  it("numbers items only when there are several", () => {
    expect(batchItemName("a.txt", 0, 1)).toBe("a.txt");
    expect(batchItemName("b.txt", 1, 3)).toBe("b.txt (2/3)");
  });
});

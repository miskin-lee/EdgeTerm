import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController(scrollback = 1000) {
  const controller = new TerminalController(
    "paint-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
    },
    13,
    scrollback,
  );
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function write(controller: TerminalController, text: string): Promise<void> {
  return new Promise((resolve) => controller.term.write(text, resolve));
}

/** The first buffer row whose text starts with `prefix`. */
function rowOf(controller: TerminalController, prefix: string): number {
  const buf = controller.term.buffer.active;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf.getLine(i)?.translateToString(true).startsWith(prefix)) return i;
  }
  throw new Error(`no row starts with ${prefix}`);
}

function cell(controller: TerminalController, row: number, col: number) {
  const cell = controller.term.buffer.active.getLine(row)?.getCell(col);
  if (!cell) throw new Error(`no cell at ${row}:${col}`);
  return cell;
}

/** The cell's foreground as "#rrggbb", or null for anything but truecolor. */
function fg(controller: TerminalController, row: number, col: number): string | null {
  const c = cell(controller, row, col);
  return c.isFgRGB() ? `#${c.getFgColor().toString(16).padStart(6, "0")}` : null;
}

function bg(controller: TerminalController, row: number, col: number): string | null {
  const c = cell(controller, row, col);
  return c.isBgRGB() ? `#${c.getBgColor().toString(16).padStart(6, "0")}` : null;
}

/** Lets the backlog pass run: it waits for output to pause, then slices. */
async function settle(controller: TerminalController) {
  const internals = controller as unknown as {
    backlogTimer: number | null;
    visible: boolean;
  };
  internals.visible = true;
  (controller as unknown as { scheduleBacklog: () => void }).scheduleBacklog();
  for (let i = 0; i < 200 && internals.backlogTimer !== null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(internals.backlogTimer).toBeNull();
}

/** How the dark theme colors an IPv4 address. */
const IP_COLOR = "#5fd7c0";

describe("semantic colors painted into the cells (issue #80)", () => {
  it("colors a finished line and keeps the color in the scrollback", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\n");
    const row = rowOf(controller, "host");
    expect(fg(controller, row, 5)).toBe(IP_COLOR);
    expect(fg(controller, row, 12)).toBe(IP_COLOR);
    expect(fg(controller, row, 0)).toBeNull();
    expect(fg(controller, row, 13)).toBeNull();

    // Scrolled well out of the viewport, line by line.
    for (let i = 0; i < 100; i += 1) await write(controller, `filler ${i}\r\n`);
    expect(controller.term.buffer.active.viewportY).toBeGreaterThan(row + 50);
    expect(fg(controller, row, 5)).toBe(IP_COLOR);
  });

  it("colors rows a flood scrolled past once output settles", async () => {
    const controller = createController();
    let flood = "";
    for (let i = 0; i < 200; i += 1) flood += `line ${i} at 10.0.0.${i % 250}\r\n`;
    await write(controller, flood);
    const row = rowOf(controller, "line 3 ");
    expect(controller.term.buffer.active.viewportY).toBeGreaterThan(row);
    // The viewport pass never saw it.
    expect(fg(controller, row, 10)).toBeNull();

    await settle(controller);
    expect(fg(controller, row, 10)).toBe(IP_COLOR);
  });

  it("never repaints a span the program styled itself", async () => {
    const controller = createController();
    await write(controller, "host \x1b[31m10.0.0.1\x1b[0m up\r\n");
    const row = rowOf(controller, "host");
    const c = cell(controller, row, 5);
    expect(c.isFgPalette()).toBe(true);
    expect(c.getFgColor()).toBe(1);
  });

  it("keeps a program's ANSI color when it rewrites a previously painted span", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\nnext\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);

    await write(controller, "\x1b[2A\rhost \x1b[31m10.0.0.1\x1b[0m up\x1b[2B");
    const c = cell(controller, 0, 5);
    expect(c.isFgPalette()).toBe(true);
    expect(c.getFgColor()).toBe(1);
  });

  it("leaves underlined and inverse text alone", async () => {
    const controller = createController();
    await write(controller, "a \x1b[4m10.0.0.1\x1b[0m b \x1b[7m10.0.0.2\x1b[0m\r\n");
    const row = rowOf(controller, "a ");
    expect(fg(controller, row, 2)).toBeNull();
    expect(fg(controller, row, 13)).toBeNull();
  });

  it("underlines links in their own color", async () => {
    const controller = createController();
    await write(controller, "see https://example.com/x now\r\n");
    const row = rowOf(controller, "see");
    const c = cell(controller, row, 4);
    expect(c.isUnderline()).toBeTruthy();
    expect(fg(controller, row, 4)).toBe("#7fb4ff");
    expect(cell(controller, row, 0).isUnderline()).toBeFalsy();
  });

  it("paints a band behind the whole row in the normal buffer", async () => {
    const controller = createController();
    await write(controller, "ERROR: disk full\r\n");
    const row = rowOf(controller, "ERROR");
    expect(fg(controller, row, 0)).toBe("#ff5c57");
    expect(bg(controller, row, 0)).toBe("#3c2726");
    expect(bg(controller, row, controller.term.cols - 1)).toBe("#3c2726");
  });

  it("colors a live shell prompt without coloring the command being typed", async () => {
    const controller = createController();
    await write(controller, "PS C:\\Users\\pinery> dir");
    expect(fg(controller, 0, 3)).toBe("#e6db74");
    expect(fg(controller, 0, 18)).toBe("#ff6188");
    expect(fg(controller, 0, 20)).toBeNull();
    await write(controller, "\r\n");
    expect(fg(controller, 0, 3)).toBe("#e6db74");
  });

  it("colors a live cmd prompt and stops when the line becomes dynamic output", async () => {
    const controller = createController();
    await write(controller, "C:\\Users\\pinery>");
    expect(fg(controller, 0, 0)).toBe("#e6db74");
    expect(fg(controller, 0, 15)).toBe("#ff6188");

    await write(controller, "\r\x1b[2Kworking at 10.0.0.1");
    expect(fg(controller, 0, 11)).toBeNull();
  });

  it("leaves a changing non-prompt line plain until the cursor leaves", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up");
    expect(fg(controller, 0, 5)).toBeNull();
    await write(controller, "\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
  });

  it("removes paint when the cursor returns to a colored line without rewriting it", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\nnext\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);

    await write(controller, "\x1b[2A");
    expect(fg(controller, 0, 5)).toBeNull();

    await write(controller, "\x1b[2B");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
  });

  it("takes stale paint off a line that is rewritten", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\nnext\r\n");
    expect(fg(controller, 0, 12)).toBe(IP_COLOR);
    // Back to the first line; overwrite its start, leaving "0.1 up" in place.
    await write(controller, "\x1b[3A\x1b[1;1Hplain words abc\r\n");
    expect(controller.term.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "plain words abcp",
    );
    for (let col = 0; col < 16; col += 1) expect(fg(controller, 0, col)).toBeNull();
  });

  it("colors the alternate screen, without bands", async () => {
    const controller = createController();
    await write(controller, "\x1b[?1049h\x1b[H\x1b[2Jhost 10.0.0.1 up\r\nERROR: disk full\r\n");
    expect(controller.term.buffer.active.type).toBe("alternate");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
    expect(fg(controller, 1, 0)).toBe("#ff5c57");
    expect(bg(controller, 1, 0)).toBeNull();
    expect(bg(controller, 1, 20)).toBeNull();
  });

  it("keeps the normal screen's colors after leaving the alternate screen", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);

    await write(controller, "\x1b[?1049h\x1b[Hhost 10.0.0.2 up\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
    await write(controller, "\x1b[?1049l");
    expect(controller.term.buffer.active.type).toBe("normal");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
  });

  it("repaints the history in the new palette on a theme switch", async () => {
    const controller = createController();
    for (let i = 0; i < 100; i += 1) await write(controller, `line ${i} at 10.0.0.1\r\n`);
    const row = rowOf(controller, "line 2 ");
    expect(fg(controller, row, 10)).toBe(IP_COLOR);

    controller.setTheme("light");
    await settle(controller);
    const light = fg(controller, row, 10);
    expect(light).not.toBeNull();
    expect(light).not.toBe(IP_COLOR);
    // The new color is the one a fresh light terminal paints.
    const fresh = createController();
    fresh.setTheme("light");
    await write(fresh, "line 2 at 10.0.0.1\r\n");
    expect(light).toBe(fg(fresh, 0, 10));
  });

  it("keeps the colors through a reflow", async () => {
    const controller = createController();
    await write(controller, "host 10.0.0.1 up\r\n");
    controller.term.resize(40, 24);
    controller.term.resize(100, 24);
    await settle(controller);
    const row = rowOf(controller, "host");
    expect(fg(controller, row, 5)).toBe(IP_COLOR);
    expect(fg(controller, row, 0)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController(scrollback: number) {
  const controller = new TerminalController(
    "gutter-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    scrollback,
  );
  controllers.push(controller);
  return controller;
}

function write(controller: TerminalController, text: string): Promise<void> {
  return new Promise((resolve) => controller.term.write(text, resolve));
}

function row(controller: TerminalController, index: number): string {
  return controller.term.buffer.active.getLine(index)?.translateToString(true) ?? "";
}

/** Paint the private DOM gutter without opening a renderer in jsdom. */
function gutterRows(controller: TerminalController): HTMLElement[] {
  const internals = controller as unknown as {
    gutter: HTMLElement | null;
    host: HTMLElement | null;
    cellHeight: number;
    syncGutter: () => void;
  };
  internals.gutter ??= document.createElement("div");
  internals.host ??= document.createElement("div");
  internals.cellHeight = 16;
  internals.syncGutter();
  return Array.from(internals.gutter.querySelectorAll<HTMLElement>(".gutter-row"));
}

function gutterLine(rows: HTMLElement[], index: number): string {
  return rows[index]?.querySelector(".gutter-line")?.textContent ?? "";
}

/** `line 1` … `line n`, one per row, as a single chunk of output. */
function lines(from: number, to: number): string {
  let out = "";
  for (let i = from; i <= to; i += 1) out += `line ${i}\r\n`;
  return out;
}

/** The gutter's line metadata (private). */
function metadata(controller: TerminalController) {
  const internals = controller as unknown as {
    firstLineNumber: number;
    lineTimes: number[];
    lineTimesStart: number;
  };
  return {
    first: internals.firstLineNumber,
    start: internals.lineTimesStart,
    held: internals.lineTimes.length,
    times: internals.lineTimes,
  };
}

/** The time recorded for each non-blank row, by the row's text. */
function recordedTimes(controller: TerminalController): Map<string, number> {
  const { start, times } = metadata(controller);
  const found = new Map<string, number>();
  for (let i = 0; i < controller.term.buffer.active.length; i += 1) {
    const text = row(controller, i);
    if (text) found.set(text, times[start + i]);
  }
  return found;
}

/** Every row still in the buffer carries the number it was written under. */
function expectNumbering(controller: TerminalController) {
  const { first } = metadata(controller);
  const buf = controller.term.buffer.active;
  for (let i = 0; i < buf.length; i += 1) {
    const text = row(controller, i);
    if (text) expect(text).toBe(`line ${first + i}`);
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("gutter line numbering", () => {
  it("hides blank tail rows visited before the cursor moved up", async () => {
    const controller = createController(100);
    await write(controller, "\x1b[12;1H\n\x1b[5;1Hprompt>");
    expect(metadata(controller).held).toBeGreaterThan(12);

    let rows = gutterRows(controller);
    expect(gutterLine(rows, 1)).toBe("2"); // blank inside the produced span
    expect(gutterLine(rows, 4)).toBe("5"); // current cursor row
    expect(gutterLine(rows, 5)).toBe("");
    expect(gutterLine(rows, 12)).toBe("");
    expect(rows[4].classList.contains("is-cursor")).toBe(true);

    // Text below the cursor is still meaningful, even before it moves there.
    await write(controller, "\x1b[9;1Hkept\x1b[5;1H");
    rows = gutterRows(controller);
    expect(gutterLine(rows, 8)).toBe("9");
    expect(gutterLine(rows, 9)).toBe("");

    // Erasing that text, without a line feed or cursor movement, hides it.
    await write(controller, "\x1b[9;1H\x1b[2K\x1b[5;1H");
    rows = gutterRows(controller);
    expect(gutterLine(rows, 8)).toBe("");

    controller.term.resize(80, 30);
    rows = gutterRows(controller);
    expect(gutterLine(rows, 4)).toBe("5");
    expect(gutterLine(rows, 29)).toBe("");
  });

  it("follows xterm's trimming once the scrollback is full", async () => {
    const controller = createController(5);
    const rows = controller.term.rows;

    await write(controller, lines(1, rows + 40));

    // The buffer holds `rows + scrollback` lines, so most of the output is
    // gone; the numbering has to have moved with it.
    expect(metadata(controller).first).toBeGreaterThan(1);
    expectNumbering(controller);
  });

  it("keeps each line's time with its line across the trimming", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = new Date("2026-01-01T10:00:00Z").getTime();
    const controller = createController(30);
    /** One line per second, so every row's time is its own. */
    const stamped = async (text: string) => {
      vi.setSystemTime((clock += 1000));
      await write(controller, `${text}\r\n`);
    };
    for (let i = 1; i <= 40; i += 1) await stamped(`line ${i}`);
    const before = recordedTimes(controller);

    for (let i = 41; i <= 80; i += 1) await stamped(`line ${i}`);

    // Half of the first batch was trimmed away; what is left kept the time it
    // was written at, rather than a neighbour's.
    expect(metadata(controller).first).toBeGreaterThan(1);
    let carried = 0;
    for (const [text, time] of recordedTimes(controller)) {
      if (!before.has(text)) continue;
      carried += 1;
      expect(time).toBe(before.get(text));
    }
    expect(carried).toBeGreaterThan(5);
  });

  it("compacts the trimmed times away instead of growing", async () => {
    const controller = createController(5);
    const max = controller.term.rows + 5;

    await write(controller, lines(1, 5000));

    const { start, held } = metadata(controller);
    expect(start).toBeLessThan(4096);
    expect(held - start).toBeLessThanOrEqual(max);
    expect(held).toBeLessThan(4096 + max);
    expectNumbering(controller);
  });
});

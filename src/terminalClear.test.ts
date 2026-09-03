import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
  shortcutLabel: (mac: string) => mac,
}));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "clear-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
    },
    13,
    100,
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

/** The gutter's line metadata (private; the number of buffer line 0 and the per-line times). */
function lineMetadata(controller: TerminalController) {
  const internals = controller as unknown as {
    firstLineNumber: number;
    lineTimes: number[];
  };
  return { first: internals.firstLineNumber, count: internals.lineTimes.length };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

/** A procps-style frame: clear, then the whole screen in the same chunk. */
const SUMMARY = [
  "top - 12:00:00 up 3 days,  1 user,  load average: 0.05, 0.03, 0.00",
  "Tasks: 123 total,   1 running, 122 sleeping,   0 stopped,   0 zombie",
  "    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
];
const ROWS = [
  "      1 root      20   0  168940  12084   8432 S   0.0   0.3   0:02.11 systemd",
  "      2 root      20   0       0      0      0 S   0.0   0.0   0:00.01 kthreadd",
  "     20 root      20   0       0      0      0 S   0.0   0.0   0:00.00 cpuhp/0",
];
const lines = (items: string[]) => items.map((line) => `${line}\x1b[K\r\n`).join("");

describe("clearing the screen in the normal buffer", () => {
  it("keeps a frame painted right behind ED 2 (Linux top, issue #32)", async () => {
    const controller = createController();
    await write(controller, "alice@server:~$ top\r\n");

    await write(controller, `\x1b[H\x1b[2J${lines(SUMMARY)}${lines(ROWS)}`);

    const buf = controller.term.buffer.active;
    expect(buf.type).toBe("normal");
    expect(buf.baseY).toBe(0);
    expect(row(controller, 0)).toBe(SUMMARY[0]);
    expect(row(controller, 3)).toBe(ROWS[0]);
    expect(row(controller, 5)).toBe(ROWS[2]);
  });

  it("keeps a frame whose rows arrive in a later chunk", async () => {
    const controller = createController();
    await write(controller, "alice@server:~$ top\r\n");

    await write(controller, `\x1b[H\x1b[2J${lines(SUMMARY)}${lines(ROWS.slice(0, 1))}`);
    await write(controller, lines(ROWS.slice(1)));

    expect(row(controller, 0)).toBe(SUMMARY[0]);
    expect(row(controller, 3)).toBe(ROWS[0]);
    expect(row(controller, 4)).toBe(ROWS[1]);
    expect(row(controller, 5)).toBe(ROWS[2]);
  });

  it("restarts the numbering and drops the scrollback on the shell's clear", async () => {
    const controller = createController();
    const rows = controller.term.rows;
    for (let i = 1; i <= rows + 10; i += 1) {
      await write(controller, `line ${i}\r\n`);
    }
    expect(controller.term.buffer.active.baseY).toBeGreaterThan(0);
    expect(lineMetadata(controller).first).toBe(1);

    // ncurses `clear`: home, ED 2, ED 3; then the shell's next prompt.
    await write(controller, "\x1b[H\x1b[2J\x1b[3J");
    await write(controller, "alice@server:~$ ");

    const buf = controller.term.buffer.active;
    expect(buf.baseY).toBe(0);
    expect(buf.length).toBe(rows);
    expect(row(controller, 0)).toBe("alice@server:~$ ");
    expect(row(controller, 1)).toBe("");
    expect(lineMetadata(controller)).toEqual({ first: 1, count: 1 });
  });

  it("keeps the screen when only the scrollback is erased (ED 3)", async () => {
    const controller = createController();
    const rows = controller.term.rows;
    for (let i = 1; i <= rows + 10; i += 1) {
      await write(controller, `line ${i}\r\n`);
    }
    const before = Array.from({ length: rows }, (_, i) =>
      row(controller, controller.term.buffer.active.viewportY + i),
    );

    await write(controller, "\x1b[3J");

    const buf = controller.term.buffer.active;
    expect(buf.baseY).toBe(0);
    expect(buf.length).toBe(rows);
    for (let i = 0; i < rows; i += 1) expect(row(controller, i)).toBe(before[i]);
    expect(lineMetadata(controller)).toEqual({ first: 1, count: rows });
  });

  it("leaves the alternate screen alone", async () => {
    const controller = createController();
    await write(controller, "alice@server:~$ vim\r\n");
    await write(controller, "\x1b[?1049h\x1b[H\x1b[2Jhello\x1b[?1049l");

    expect(controller.term.buffer.active.type).toBe("normal");
    expect(row(controller, 0)).toBe("alice@server:~$ vim");
    expect(controller.term.buffer.active.baseY).toBe(0);
  });

  it("drops the semantic colors when a program takes the alternate screen", async () => {
    const controller = createController();
    const internals = controller as unknown as { disposeAllSemanticColors: () => void };
    const dispose = vi.spyOn(internals, "disposeAllSemanticColors");

    await write(controller, "\x1b[?1049h");
    expect(dispose).toHaveBeenCalled();
  });
});

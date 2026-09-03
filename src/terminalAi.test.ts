import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
  shortcutLabel: (mac: string) => mac,
}));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
const encoder = new TextEncoder();
const PROMPT = "alice@server:~/repo$ ";

function createController(events: string[]) {
  const controller = new TerminalController(
    "ai-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState: (state, kind) => events.push(`${state}:${kind}`),
      suggest: () => [],
    },
    13,
    100,
  );
  controllers.push(controller);
  return controller;
}

/** Writes and lets xterm's write buffer drain under the fake clock. */
async function write(controller: TerminalController, text: string) {
  const parsed = new Promise<void>((resolve) =>
    controller.term.write(text, resolve),
  );
  await vi.advanceTimersByTimeAsync(0);
  await parsed;
}

/** Output from the tool itself, on the byte path the session uses. */
function output(controller: TerminalController, text: string) {
  controller.write(encoder.encode(text));
}

/** Types a command at the prompt already on screen and submits it. */
async function submit(controller: TerminalController, command: string) {
  controller.term.input(command, true);
  await write(controller, command);
  controller.term.input("\r", true);
  await write(controller, "\r\n");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("agentic CLI sessions", () => {
  it("does not report the session itself as a running command", async () => {
    const events: string[] = [];
    const controller = createController(events);

    await write(controller, PROMPT);
    await submit(controller, "claude");
    expect(events).toEqual(["idle:ai"]);

    // Its startup banner is not a turn: nothing was asked of it yet.
    output(controller, "Welcome to Claude Code\r\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["idle:ai"]);
  });

  it("runs from the prompt sent to it until it goes quiet", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");
    events.length = 0;

    controller.term.input("fix the failing test", true);
    controller.term.input("\r", true);
    expect(events).toEqual(["running:ai"]);

    // A working assistant repaints its spinner the whole time, tool calls
    // included; that keeps the turn open however long the work takes.
    for (let tick = 0; tick < 8; tick += 1) {
      await vi.advanceTimersByTimeAsync(1500);
      output(controller, "\r\x1b[K* Thinking... (esc to interrupt)");
    }
    expect(events).toEqual(["running:ai"]);

    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai"]);
  });

  it("does not open a turn for the terminal's own replies", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");
    events.length = 0;

    // What one of these tools asks the terminal on startup: which device it
    // is, where the cursor sits, and to be told about focus — the last of
    // which reports back on every tab switch. xterm answers through the
    // same channel as the keyboard, and none of it is the user typing.
    await write(controller, "\x1b[c\x1b[6n\x1b[?1004h");
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);
  });

  it("opens a new turn for every answer the user gives", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "codex");
    events.length = 0;

    controller.term.input("run the tests", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai"]);

    // Answering a permission question resumes the assistant, with or
    // without an Enter of its own.
    controller.term.input("y", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual([
      "running:ai",
      "complete:ai",
      "running:ai",
      "complete:ai",
    ]);
  });

  it("returns to command tracking once the tool exits", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");

    // `/exit` hands the terminal back to the shell.
    await write(controller, PROMPT);
    expect(events).toEqual(["idle:ai", "complete:ai"]);

    await submit(controller, "ls -la");
    await write(controller, `file-a  file-b\r\n${PROMPT}`);
    expect(events).toEqual([
      "idle:ai",
      "complete:ai",
      "running:command",
      "complete:command",
    ]);
  });

  it("tracks an ordinary command the usual way", async () => {
    const events: string[] = [];
    const controller = createController(events);

    await write(controller, PROMPT);
    await submit(controller, "npm test");
    expect(events).toEqual(["running:command"]);
    // Keystrokes and output alone never end an ordinary command.
    controller.term.input("x", true);
    output(controller, "passing\r\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["running:command"]);

    await write(controller, PROMPT);
    expect(events).toEqual(["running:command", "complete:command"]);
  });
});

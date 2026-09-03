import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
  shortcutLabel: (mac: string) => mac,
}));

import { isShellPrompt, shellPromptEnd } from "./semanticColors";
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController(states: string[], commands: string[] = []) {
  const controller = new TerminalController(
    "activity-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand: (command) => commands.push(command),
      onCommandState: (state) => states.push(state),
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

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("shell prompt recognition", () => {
  it.each([
    "alice@server:~/work$ ",
    "root@server /srv # ",
    "~/repo ❯ ",
    "$ ",
    "PS C:\\Users\\alice> ",
    "C:\\work> ",
  ])("recognises %s", (prompt) => {
    expect(shellPromptEnd(prompt)).toBeGreaterThan(0);
    expect(isShellPrompt(prompt)).toBe(true);
  });

  it.each(["# a comment", "Finished build", "progress > 50%"])(
    "does not mistake %s for a prompt",
    (output) => {
      expect(isShellPrompt(output)).toBe(false);
    },
  );
});

describe("terminal command activity", () => {
  it("stays running through quiet output and completes on the returned prompt", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "alice@server:~/work$ ";

    await write(controller, prompt);
    controller.term.input("sleep 30", true);
    await write(controller, "sleep 30");
    controller.term.input("\r", true);

    expect(states).toEqual(["running"]);
    await write(controller, "\r\nstill waiting\r\n");
    expect(states).toEqual(["running"]);

    await write(controller, prompt);
    expect(states).toEqual(["running", "complete"]);
  });

  it("accepts a recognised prompt whose working directory changed", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "alice@server:~/old$ ");
    controller.term.input("cd ../new", true);
    await write(controller, "cd ../new");
    controller.term.input("\r", true);
    await write(controller, "\r\nalice@server:~/new$ ");

    expect(states).toEqual(["running", "complete"]);
  });

  it("uses an exact signature for a custom prompt", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "λ ");
    controller.term.input("make", true);
    await write(controller, "make");
    controller.term.input("\r", true);
    await write(controller, "\r\nDone\r\nλ ");

    expect(states).toEqual(["running", "complete"]);
  });

  it("uses a prompt cwd report when the visible prompt is empty", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "\x1b]7;file://localhost/old\x07");
    controller.term.input("cd ../new", true);
    await write(controller, "cd ../new");
    controller.term.input("\r", true);
    await write(
      controller,
      "\r\n\x1b]7;file://localhost/new\x07",
    );

    expect(states).toEqual(["running", "complete"]);
  });

  it("does not treat input requested by a foreground command as a new command", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "alice@server:~/work$ ";

    await write(controller, prompt);
    controller.term.input("sudo true", true);
    await write(controller, "sudo true");
    controller.term.input("\r", true);
    await write(controller, "\r\nPassword: ");

    controller.term.input("not-recorded", true);
    controller.term.input("\r", true);
    await write(controller, `\r\n${prompt}`);

    expect(states).toEqual(["running", "complete"]);
  });

  /**
   * procps top paints in the normal buffer: it clears the screen, draws its
   * frames with absolute addressing and parks the cursor inside them. `q`
   * hands the shell back without the user ever pressing Enter, so the
   * keystroke's anchor is left sitting on a row top painted.
   */
  async function quitTop(controller: TerminalController, prompt: string) {
    controller.term.input("top", true);
    await write(controller, "top");
    controller.term.input("\r", true);
    await write(controller, "\r\n");
    const frame = [
      "top - 12:00:00 up 3 days,  1 user,  load average: 0.05, 0.03",
      "Tasks: 123 total,   1 running, 122 sleeping,   0 stopped",
      "    1 root      20   0  168940  12084 S   0.0   0:02.11 systemd",
    ]
      .map((row, index) => `\x1b[${index + 1}d\r${row}\x1b[K`)
      .join("");
    await write(controller, `\x1b[?7l\x1b[H\x1b[2J${frame}\x1b[H`);
    controller.term.input("q", true);
    // at_eoj: cursor to the last row, margins back, one newline.
    await write(controller, `\x1b[99;1H\x1b[?7h\n${prompt}`);
  }

  it("tracks the next command after a full-screen program is quit", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "root@server:~# ";

    await write(controller, prompt);
    await quitTop(controller, prompt);
    expect(states).toEqual(["running", "complete"]);

    controller.term.input("ls", true);
    await write(controller, "ls");
    controller.term.input("\r", true);
    await write(controller, `\r\nfile-a  file-b\r\n${prompt}`);

    expect(states).toEqual(["running", "complete", "running", "complete"]);
  });

  it("does not record a full-screen program's own screen as a command", async () => {
    const states: string[] = [];
    const commands: string[] = [];
    const controller = createController(states, commands);
    controller.setSuggestions(true);
    const prompt = "root@server:~# ";

    await write(controller, prompt);
    await quitTop(controller, prompt);

    controller.term.input("ls", true);
    await write(controller, "ls");
    controller.term.input("\r", true);
    await write(controller, `\r\nfile-a  file-b\r\n${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(commands).toEqual(["top", "ls"]);
  });
});

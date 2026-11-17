import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));
import { TerminalController } from "./terminal";
import { restoreTmuxPane } from "./tmux";
import { TmuxPaneStream } from "./tmuxProtocol";

const controllers: TerminalController[] = [];
const bytes = (value: string) => new TextEncoder().encode(value);
const drain = (controller: TerminalController) =>
  new Promise<void>((resolve) => controller.term.write("", resolve));
function terminal() {
  const controller = new TerminalController(
    "tmux-terminal-test",
    {
      onData() {},
      onResize() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
      onReconnect() {},
    },
    13,
    100,
  );
  controllers.push(controller);
  return controller;
}
const rows = (controller: TerminalController) => {
  const buffer = controller.term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)?.translateToString(true),
  );
};
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
});

describe("tmux terminal state", () => {
  it("carries an incomplete screen title escape across attach and live output", async () => {
    const controller = terminal();
    const stream = new TmuxPaneStream();
    controller.setRemoteSize(80, 24);
    restoreTmuxPane(
      controller,
      [[], [], [bytes("0,0,0,1,0,0,0,0,0,0,0,0,0,0,23,1")], [bytes("\\033")]],
      stream,
    );
    controller.write(stream.feed(bytes("ktitle-only\x1b\\visible")));
    await drain(controller);
    expect(rows(controller)[0]).toBe("visible");
  });
  it("orders layout changes with queued bytes, including absolute cursor positioning", async () => {
    const actual = terminal(),
      expected = terminal();
    // The reference processes each step completely before the next one.
    expected.term.resize(80, 10);
    expected.write(bytes("\x1b[2;70HX"));
    await drain(expected);
    expected.term.resize(40, 10);
    expected.write(bytes("\r\nEND"));
    await drain(expected);

    // Control-mode notifications and output may arrive in one IPC packet.
    actual.setRemoteSize(80, 10);
    actual.write(bytes("\x1b[2;70HX"));
    actual.setRemoteSize(40, 10);
    actual.write(bytes("\r\nEND"));
    await drain(actual);
    expect(rows(actual)).toEqual(rows(expected));
    expect(actual.term.buffer.active.cursorX).toBe(
      expected.term.buffer.active.cursorX,
    );
    expect(actual.term.buffer.active.cursorY).toBe(
      expected.term.buffer.active.cursorY,
    );
  });

  it("restores the alternate screen and cursor/mouse/paste modes, then accepts live bytes", async () => {
    const controller = terminal();
    controller.setRemoteSize(80, 24);
    restoreTmuxPane(controller, [
      [bytes("normal shell history")],
      [bytes("editor")],
      // cursor x/y, alt, visible, insert, cursor keys, keypad, mouse modes,
      // bracketed paste, scroll region, wrap.
      [bytes("6,0,1,0,0,1,1,0,1,0,0,1,1,0,23,1")],
      [],
    ]);
    controller.write(bytes("!"));
    await drain(controller);
    expect(controller.term.buffer.active.type).toBe("alternate");
    expect(rows(controller)[0]).toBe("editor!");
    expect(controller.term.modes.bracketedPasteMode).toBe(true);
    expect(controller.term.modes.applicationCursorKeysMode).toBe(true);
    controller.write(bytes("\x1b[?1049l"));
    await drain(controller);
    expect(controller.term.buffer.active.type).toBe("normal");
    expect(rows(controller).join("\n")).toContain("normal shell history");
  });
});

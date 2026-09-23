import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

const writeClipboardText = vi.fn((_text: string) => Promise.resolve());
vi.mock("./api", () => ({
  readClipboardText: () => Promise.resolve(""),
  writeClipboardText: (text: string) => writeClipboardText(text),
}));

import { parseOsc52 } from "./osc52";
import { TerminalController } from "./terminal";

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("parseOsc52", () => {
  it("decodes the text a program copies, UTF-8 included", () => {
    expect(parseOsc52(`c;${base64("hello")}`)).toBe("hello");
    expect(parseOsc52(`;${base64("你好 🙂")}`)).toBe("你好 🙂");
    expect(parseOsc52(`s0;${base64("x")}`)).toBe("x");
  });

  it("never answers a read and ignores clears and garbage", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("c;not base64!")).toBeNull();
    expect(parseOsc52(base64("no selection field"))).toBeNull();
  });

  it("leaves requests for only the primary selection alone", () => {
    expect(parseOsc52(`p;${base64("x")}`)).toBeNull();
    expect(parseOsc52(`pc;${base64("x")}`)).toBe("x");
  });
});

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "osc52-test",
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

function copy(controller: TerminalController, text: string): Promise<void> {
  return new Promise((resolve) =>
    controller.term.write(`\x1b]52;c;${base64(text)}\x07`, resolve),
  );
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  writeClipboardText.mockClear();
});

describe("OSC 52 in the terminal", () => {
  it("asks once per session, then writes without asking", async () => {
    const controller = createController();
    const asked: string[] = [];
    controller.onConfirmClipboardWrite((text) => asked.push(text));

    await copy(controller, "first");
    expect(asked).toEqual(["first"]);
    expect(writeClipboardText).not.toHaveBeenCalled();

    controller.allowProgramClipboard("first");
    await copy(controller, "second");
    expect(asked).toEqual(["first"]);
    expect(writeClipboardText.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("writes straight away when allowed and never when denied", async () => {
    const controller = createController();
    const asked: string[] = [];
    controller.onConfirmClipboardWrite((text) => asked.push(text));

    controller.setProgramClipboard("allow");
    await copy(controller, "allowed");
    controller.setProgramClipboard("deny");
    await copy(controller, "denied");

    expect(asked).toEqual([]);
    expect(writeClipboardText.mock.calls).toEqual([["allowed"]]);
  });

  it("drops a write nobody can confirm", async () => {
    const controller = createController();
    await copy(controller, "orphan");
    expect(writeClipboardText).not.toHaveBeenCalled();
  });
});

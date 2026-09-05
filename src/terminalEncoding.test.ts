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
    "encoding-test",
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

/** Feeds session bytes the way App.tsx does and waits for xterm to paint them. */
async function receive(controller: TerminalController, ...chunks: number[][]) {
  for (const chunk of chunks) controller.write(Uint8Array.from(chunk));
  await new Promise<void>((resolve) => controller.term.write("", resolve));
}

function row(controller: TerminalController, index: number): string {
  return controller.term.buffer.active.getLine(index)?.translateToString(true) ?? "";
}

const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("session output encoding", () => {
  it("shows a GBK session's Chinese output, even split across reads", async () => {
    const controller = createController();
    controller.setEncoding("gbk");
    // "wps文件\r\n小米11照片备份" in GBK, cut inside 文 and inside 米.
    await receive(
      controller,
      [0x77, 0x70, 0x73, 0xce],
      [0xc4, 0xbc, 0xfe, 0x0d, 0x0a, 0xd0, 0xa1, 0xc3],
      [0xd7, 0x31, 0x31, 0xd5, 0xd5, 0xc6, 0xac, 0xb1, 0xb8, 0xb7, 0xdd],
    );
    expect(row(controller, 0)).toBe("wps文件");
    expect(row(controller, 1)).toBe("小米11照片备份");
  });

  it("keeps UTF-8 sessions on the byte path", async () => {
    const controller = createController();
    const bytes = utf8("wps文件");
    await receive(controller, bytes.slice(0, 4), bytes.slice(4));
    expect(row(controller, 0)).toBe("wps文件");
  });

  it("switches back to UTF-8 for a reconnect under an edited profile", async () => {
    const controller = createController();
    controller.setEncoding("gbk");
    await receive(controller, [0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a]);
    expect(row(controller, 0)).toBe("你好");

    controller.setEncoding(null);
    await receive(controller, utf8("你好"));
    expect(row(controller, 1)).toBe("你好");
  });
});

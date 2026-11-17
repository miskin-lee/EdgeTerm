import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxClient, sendTmuxBytes } from "./tmuxClient";
import {
  parseTmuxLayout,
  tmuxBytes,
  tmuxLeaves,
  TmuxPaneStream,
  TmuxStream,
} from "./tmuxProtocol";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

afterEach(() => vi.useRealTimers());

describe("tmux framing", () => {
  it("translates screen title strings across read boundaries without changing terminal text", () => {
    const stream = new TmuxPaneStream();
    const output: number[] = [];
    for (const byte of bytes("\x1bkprintf\x1b\\你好\r\n\x1b[32mgreen"))
      output.push(...stream.feed(Uint8Array.of(byte)));
    expect(text(Uint8Array.from(output))).toBe(
      "\x1b]2;printf\x1b\\你好\r\n\x1b[32mgreen",
    );
  });
  it("detects entry, lines and exit at every possible read boundary without losing surrounding shell output", () => {
    const wire = bytes(
      "before\x1bP1000p%begin 1 2 0\r\n%end 1 2 0\r\n%output %0 hello\\015\\012\r\n%exit\r\n\x1b\\after",
    );
    for (let cut = 0; cut <= wire.length; cut++) {
      const ordinary: number[] = [];
      const lines: string[] = [];
      const start = vi.fn(),
        end = vi.fn();
      const stream = new TmuxStream({
        data: (data) => ordinary.push(...data),
        start,
        end,
        line: (data) => lines.push(text(data)),
        error: () => {},
      });
      stream.feed(wire.subarray(0, cut));
      stream.feed(wire.subarray(cut));
      expect(text(Uint8Array.from(ordinary))).toBe("beforeafter");
      expect(lines).toEqual([
        "%begin 1 2 0",
        "%end 1 2 0",
        "%output %0 hello\\015\\012",
        "%exit",
      ]);
      expect(start).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledOnce();
      expect(stream.active).toBe(false);
    }
  });

  it("passes ordinary ANSI and partial lookalikes through byte for byte", () => {
    const output: number[] = [];
    const stream = new TmuxStream({
      data: (data) => output.push(...data),
      start: () => {},
      end: () => {},
      line: () => {},
      error: () => {},
    });
    const wire = bytes("\x1b[31mred\x1b[0m\x1bP1001pvalue\x1b\\\x1b\x1b[H");
    for (const byte of wire) stream.feed(Uint8Array.of(byte));
    expect(output).toEqual(Array.from(wire));
  });

  it("unescapes raw bytes including invalid UTF-8 without interpreting escaped backslashes twice", () => {
    expect(
      tmuxBytes(Uint8Array.from([255, ...bytes("\\000\\033\\134015"), 195])),
    ).toEqual(Uint8Array.from([255, 0, 27, 92, 48, 49, 53, 195]));
  });
});

describe("tmux command replies", () => {
  function setup() {
    const send = vi.fn().mockResolvedValue(undefined),
      output = vi.fn(),
      notify = vi.fn(),
      failure = vi.fn();
    const client = new TmuxClient(send, output, notify, failure);
    const lines = (...values: string[]) =>
      values.forEach((line) => client.line(bytes(line)));
    return { client, send, output, notify, failure, lines };
  }
  it("keeps the startup reply and notifications separate from commands and treats reply content literally", async () => {
    const { client, lines, output, notify } = setup();
    const reply = client.request("list-panes");
    lines(
      "%begin 1 1 0",
      "%end 1 1 0",
      "%output %4 \\377\\033[H",
      "%window-add @2",
      "%begin 1 2 1",
      "%output %4 this is captured text",
      "%end 1 999 1",
      "%end 1 2 1",
    );
    expect((await reply).map(text)).toEqual([
      "%output %4 this is captured text",
      "%end 1 999 1",
    ]);
    expect(output).toHaveBeenCalledWith(
      "%4",
      Uint8Array.from([255, 27, 91, 72]),
    );
    expect(notify).toHaveBeenCalledWith("%window-add @2");
    client.stop();
  });
  it("finishes a snapshot batch synchronously before subsequent live output", async () => {
    const { client, lines, send, output } = setup();
    const restored = vi.fn();
    const capture = client.batch(["capture-pane", "display-message"], restored);
    const next = client.request("list-windows");
    expect(send).toHaveBeenCalledTimes(1);
    lines(
      "%begin 1 1 1",
      "screen",
      "%end 1 1 1",
      "%begin 1 2 1",
      "modes",
      "%end 1 2 1",
      "%output %0 live",
    );
    expect(restored.mock.invocationCallOrder[0]).toBeLessThan(
      output.mock.invocationCallOrder[0],
    );
    expect((await capture).map((group) => group.map(text))).toEqual([
      ["screen"],
      ["modes"],
    ]);
    expect(send).toHaveBeenLastCalledWith("list-windows\n");
    lines("%begin 1 3 1", "%error 1 3 1");
    await expect(next).rejects.toThrow("tmux command failed");
    client.stop();
  });
  it("bounds a hung request and rejects pending input when the transport ends", async () => {
    vi.useFakeTimers();
    const { client, failure } = setup();
    const one = expect(client.request("list-panes")).rejects.toThrow(
      "15 seconds",
    );
    const two = expect(client.request("send-keys")).rejects.toThrow(
      "15 seconds",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([one, two]);
    expect(failure).toHaveBeenCalledOnce();
  });
  it("sends Unicode, escapes and newlines as literal hex bytes", async () => {
    const { client, send, lines } = setup();
    const sending = sendTmuxBytes(client, "%3", bytes("你\n'; kill-server\r"));
    expect(send).toHaveBeenCalledWith(
      "send-keys -H -t %3 e4 bd a0 0a 27 3b 20 6b 69 6c 6c 2d 73 65 72 76 65 72 0d\n",
    );
    lines("%begin 1 1 1", "%end 1 1 1");
    await sending;
    await expect(
      sendTmuxBytes(client, "%3;kill-server", bytes("x")),
    ).rejects.toThrow("Invalid tmux pane");
    client.stop();
  });
});

describe("tmux layouts", () => {
  it("reads nested splits, stable pane IDs and integer cell geometry", () => {
    const layout = parseTmuxLayout(
      "abcd,120x40,0,0{59x40,0,0,2,60x40,60,0[60x19,60,0,5,60x20,60,20,9]}",
    );
    expect(layout.direction).toBe("row");
    expect(layout.children[1].direction).toBe("column");
    expect(
      tmuxLeaves(layout).map(({ pane, x, y, cols, rows }) => ({
        pane,
        x,
        y,
        cols,
        rows,
      })),
    ).toEqual([
      { pane: "%2", x: 0, y: 0, cols: 59, rows: 40 },
      { pane: "%5", x: 60, y: 0, cols: 60, rows: 19 },
      { pane: "%9", x: 60, y: 20, cols: 60, rows: 20 },
    ]);
  });
  it("rejects malformed layouts before constructing terminals", () => {
    for (const value of [
      "",
      "abcd,0x4,0,0,1",
      "abcd,80x24,0,0{40x24,0,0,1}",
      "abcd,80x24,0,0,1;kill-server",
    ]) {
      expect(() => parseTmuxLayout(value)).toThrow();
    }
  });
});

// Opt in: EDGETERM_TMUX_TEST=1 npm test -- src/tmux.integration.test.ts
// Uses an isolated tmux server; never attaches to the user's own sessions.
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  writeSessionBinary: vi.fn(),
  resizeSession: vi.fn().mockResolvedValue(undefined),
}));
import * as api from "./api";
import { ensureController } from "./actions";
import { useStore } from "./store";
import {
  disposeController,
  getBaseController,
  getController,
} from "./terminalRegistry";
import { tmuxLeaves } from "./tmuxProtocol";
import { getTmux, type TmuxSessionBridge } from "./tmuxRegistry";

const encode = (text: string) => new TextEncoder().encode(text);
const initial = useStore.getState();
const id = "tmux-integration";
let socket: string;
let process: ChildProcessWithoutNullStreams | undefined;
let session: TmuxSessionBridge;

async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout)
      throw new Error(`Timed out: ${JSON.stringify(session?.snapshot())}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function contents(pane = session.snapshot()!.activePane) {
  const controller = getBaseController(session.paneControllerId(pane))!;
  await new Promise<void>((resolve) => controller.term.write("", resolve));
  const buffer = controller.term.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) =>
    buffer.getLine(i)?.translateToString(true),
  ).join("\n");
}
const external = (...args: string[]) =>
  execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

describe.skipIf(globalThis.process.env.EDGETERM_TMUX_TEST !== "1")(
  "real tmux control mode",
  () => {
    beforeEach(async () => {
      useStore.setState(initial, true);
      socket = `edgeterm-test-${globalThis.process.pid}-${Math.random().toString(36).slice(2)}`;
      useStore.getState().addTab(
        {
          id,
          profileId: null,
          name: "tmux test",
          kind: "local",
          protocol: "shell",
          address: "local",
          color: null,
          supportsRemoteFiles: false,
        },
        { id: "", name: "tmux test", kind: "local" },
      );
      await ensureController(id);
      session = getTmux(id)!;
      process = spawn(
        "tmux",
        [
          "-L",
          socket,
          "-f",
          "/dev/null",
          "-C",
          "new-session",
          "-s",
          "test",
          "-x",
          "80",
          "-y",
          "24",
          "stty -echo -icanon; printf 'ready\\r\\n'; exec cat",
        ],
        { env: { ...globalThis.process.env, TERM: "xterm-256color" } },
      );
      vi.mocked(api.writeSessionBinary).mockImplementation(
        (_id, value) =>
          new Promise((resolve, reject) => {
            process!.stdin.write(Buffer.from(value, "base64"), (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
      // -C works over pipes. Supply the DCS framing -CC supplies over a PTY.
      session.receive(encode("\x1bP1000p"));
      const attached = session;
      process.stdout.on("data", (data) =>
        attached.receive(new Uint8Array(data)),
      );
      process.on("close", () => attached.receive(encode("\x1b\\")));
      await until(() => session.snapshot()?.windows.length === 1);
      external(
        "set-option",
        "-g",
        "default-command",
        "stty -echo -icanon; exec cat",
      );
    }, 10_000);

    afterEach(() => {
      disposeController(id);
      process?.stdout.removeAllListeners();
      process?.removeAllListeners("close");
      try {
        external("kill-server");
      } catch {
        /* already exited */
      }
      process?.kill();
      process = undefined;
      useStore.setState(initial, true);
    });

    it("restores a pane, routes Unicode literally, follows remote splits/windows and detaches without killing the server", async () => {
      expect(await contents()).toContain("ready");
      const first = session.snapshot()!.activePane;
      await session.write("hello 你好 '; kill-server\n");
      expect(await contents()).toContain("hello 你好 '; kill-server");
      expect(getController(id)).toBe(
        getBaseController(session.paneControllerId(first)),
      );
      await session.write("\x1bktitle-only\x1b\\visible-text\n");
      expect(await contents()).toContain("visible-text");
      expect(await contents()).not.toContain("title-only");

      external("split-window", "-h", "stty -echo -icanon; exec cat");
      await until(
        () =>
          tmuxLeaves(session.snapshot()!.windows[0].layout).length === 2 &&
          session.snapshot()!.activePane !== first,
      );
      const second = session.snapshot()!.activePane;
      expect(second).not.toBe(first);
      await session.write("second-pane\n");
      expect(await contents(second)).toContain("second-pane");
      expect(await contents(first)).not.toContain("second-pane");

      external(
        "new-window",
        "-n",
        "other window",
        "stty -echo -icanon; exec cat",
      );
      await until(() => session.snapshot()!.windows.length === 2);
      expect(
        session.snapshot()!.windows.map((window) => window.name),
      ).toContain("other window");
      await session.detach();
      await until(() => session.snapshot() === null);
      expect(api.resizeSession).toHaveBeenCalledWith(id, 80, 24);
      expect(external("list-sessions")).toContain("test:");
    }, 20_000);

    it("restores alternate screen, cursor and bracketed paste on reattach, and retains hidden panes through zoom", async () => {
      const pane = session.snapshot()!.activePane;
      await session.write("\x1b[?1049h\x1b[2J\x1b[5;7Heditor\x1b[?2004h\n");
      // cat echoes the terminal sequence, which tmux consumes into its screen.
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Detach and reattach the same tmux server, using a fresh frontend state.
      await session.detach();
      await until(() => session.snapshot() === null);
      process = spawn(
        "tmux",
        ["-L", socket, "-C", "attach-session", "-t", "test"],
        { env: { ...globalThis.process.env, TERM: "xterm-256color" } },
      );
      session.receive(encode("\x1bP1000p"));
      const attached = session;
      process.stdout.on("data", (data) =>
        attached.receive(new Uint8Array(data)),
      );
      process.on("close", () => attached.receive(encode("\x1b\\")));
      await until(() => session.snapshot()?.windows.length === 1);
      const controller = getController(id)!;
      await contents();
      expect(controller.term.buffer.active.type).toBe("alternate");
      expect(controller.term.modes.bracketedPasteMode).toBe(true);
      expect(await contents()).toContain("editor");
      external("split-window", "-h", "stty -echo -icanon; exec cat");
      await until(
        () => tmuxLeaves(session.snapshot()!.windows[0].layout).length === 2,
      );
      const original = getBaseController(session.paneControllerId(pane));
      external("resize-pane", "-Z");
      await until(
        () => tmuxLeaves(session.snapshot()!.windows[0].layout).length === 1,
      );
      expect(getBaseController(session.paneControllerId(pane))).toBe(original);
      external("resize-pane", "-Z");
      await until(
        () => tmuxLeaves(session.snapshot()!.windows[0].layout).length === 2,
      );
      expect(getBaseController(session.paneControllerId(pane))).toBe(original);
    }, 20_000);

    it("resizes through tmux, pins a long paste to its pane and locks every pane on disconnect", async () => {
      const first = session.snapshot()!.activePane;
      await session.split("right");
      await until(() => session.snapshot()!.activePane !== first);
      const second = session.snapshot()!.activePane;
      const windowId = session.snapshot()!.activeWindow;
      session.resizeWindow(windowId, 100, 30);
      await until(() => session.snapshot()!.windows[0].layout.cols === 100);
      const before = tmuxLeaves(session.snapshot()!.windows[0].layout)[0].cols;
      session.resizePane(first, "row", 5);
      await until(
        () =>
          tmuxLeaves(session.snapshot()!.windows[0].layout)[0].cols !== before,
      );
      const pending = session.writePane(
        first,
        `pinned-${"x".repeat(1300)}-end\n`,
      );
      session.selectPane(second);
      await pending;
      await until(async () =>
        (await contents(first)).replace(/\n/g, "").includes("-end"),
      );
      expect((await contents(first)).replace(/\n/g, "")).toContain(
        `pinned-${"x".repeat(1300)}-end`,
      );
      expect(await contents(second)).not.toContain("pinned-");
      await api.writeSession(id, "active-only\n");
      await until(async () => (await contents(second)).includes("active-only"));
      expect(await contents(second)).toContain("active-only");
      useStore.getState().applyState(id, "closed");
      expect(session.snapshot()?.connected).toBe(false);
      for (const pane of [first, second]) {
        expect(
          getBaseController(session.paneControllerId(pane))?.term.options
            .disableStdin,
        ).toBe(true);
      }
      await expect(api.writeSession(id, "no\n")).rejects.toThrow(
        "disconnected",
      );
      useStore.getState().applyState(id, "connecting");
      expect(session.snapshot()).toBeNull();
      expect(
        getBaseController(session.paneControllerId(first)),
      ).toBeUndefined();
      expect(getController(id)).toBe(getBaseController(id));
      expect(external("list-sessions")).toContain("test:");
    }, 20_000);
  },
);

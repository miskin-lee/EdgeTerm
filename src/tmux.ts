import * as api from "./api";
import { ensureController } from "./actions";
import { useStore } from "./store";
import type { TerminalController } from "./terminal";
import { disposeController } from "./terminalRegistry";
import { sendTmuxBytes, TmuxClient } from "./tmuxClient";
import {
  parseTmuxLayout,
  tmuxBytes,
  tmuxId,
  tmuxLeaves,
  TmuxPaneStream,
  TmuxStream,
} from "./tmuxProtocol";
import type {
  TmuxSessionBridge,
  TmuxSnapshot,
  TmuxWindow,
} from "./tmuxRegistry";
import type { SessionState } from "./types";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);
const WINDOW_FORMAT = [
  "window_id",
  "window_active",
  "window_visible_layout",
  "window_layout",
  "pane_id",
  "q:window_name",
]
  .map((name) => `#{${name}}`)
  .join("\t");
const MODES = [
  "cursor_x",
  "cursor_y",
  "alternate_on",
  "cursor_flag",
  "insert_flag",
  "keypad_cursor_flag",
  "keypad_flag",
  "mouse_standard_flag",
  "mouse_button_flag",
  "mouse_all_flag",
  "mouse_utf8_flag",
  "mouse_sgr_flag",
  "bracket_paste_flag",
  "scroll_region_upper",
  "scroll_region_lower",
  "wrap_flag",
  "alternate_saved_x",
  "alternate_saved_y",
  "pane_width",
  "pane_height",
];
const MODE_FORMAT = MODES.map((name) => `#{${name}}`).join(",");

/** Restore history, alternate screen and input modes before accepting live bytes. */
export function restoreTmuxPane(
  controller: TerminalController,
  results: Uint8Array[][],
  stream = new TmuxPaneStream(),
) {
  const [saved, screen, state, pending] = results;
  const values = (state[0] ? text(state[0]) : "").split(",").map(Number);
  const mode = Object.fromEntries(
    MODES.map((name, index) => [name, values[index] || 0]),
  );
  if (mode.pane_width > 0 && mode.pane_height > 0) {
    controller.setRemoteSize(mode.pane_width, mode.pane_height);
  }
  const writeLines = (lines: Uint8Array[]) => {
    lines.forEach((line, index) => {
      controller.write(tmuxBytes(line));
      if (index + 1 < lines.length) controller.writeText("\r\n");
    });
  };
  controller.writeText("\x1bc");
  if (mode.alternate_on) {
    writeLines(saved);
    controller.writeText(
      `\x1b[${mode.alternate_saved_y + 1};${mode.alternate_saved_x + 1}H` +
        "\x1b[?1049h\x1b[H",
    );
  }
  writeLines(screen);
  const dec = (number: number, enabled: number) =>
    `\x1b[?${number}${enabled ? "h" : "l"}`;
  controller.writeText(
    "\x1b[0m" +
      `\x1b[${mode.scroll_region_upper + 1};${mode.scroll_region_lower + 1}r` +
      `\x1b[${mode.cursor_y + 1};${mode.cursor_x + 1}H` +
      dec(25, mode.cursor_flag) +
      dec(1, mode.keypad_cursor_flag) +
      dec(7, mode.wrap_flag) +
      (mode.keypad_flag ? "\x1b=" : "\x1b>") +
      `\x1b[4${mode.insert_flag ? "h" : "l"}` +
      dec(1000, mode.mouse_standard_flag) +
      dec(1002, mode.mouse_button_flag) +
      dec(1003, mode.mouse_all_flag) +
      dec(1005, mode.mouse_utf8_flag) +
      dec(1006, mode.mouse_sgr_flag) +
      dec(2004, mode.bracket_paste_flag),
  );
  for (const line of pending) controller.write(stream.feed(tmuxBytes(line)));
}

export class TmuxSession implements TmuxSessionBridge {
  private view: TmuxSnapshot | null = null;
  private listeners = new Set<() => void>();
  private client: TmuxClient | null = null;
  private stream: TmuxStream;
  private panes = new Map<
    string,
    { controller: TerminalController; ready: boolean; stream: TmuxPaneStream }
  >();
  private generation = 0;
  private layoutRevision = 0;
  private refreshing = false;
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private input: Promise<void> = Promise.resolve();
  private pendingInput = 0;
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly base: TerminalController,
  ) {
    this.stream = new TmuxStream({
      data: (bytes) => base.write(bytes),
      start: () => this.start(),
      line: (bytes) => this.client?.line(bytes),
      end: () => this.end(),
      error: (message) => this.failed(message),
    });
  }

  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(view: TmuxSnapshot | null) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  receive(bytes: Uint8Array) {
    if (this.disposed) return;
    // A transfer already in progress owns the transport, including DCS-like bytes.
    if (!this.stream.active && this.base.isTransferActive())
      this.base.write(bytes);
    else this.stream.feed(bytes);
  }
  paneControllerId(pane: string) {
    return `${this.id}:tmux:${pane}`;
  }
  activeController() {
    return this.panes.get(this.view?.activePane ?? "")?.controller;
  }

  private start() {
    this.clear();
    this.base.setLocked(true);
    useStore.getState().clearCommandActivity(this.id);
    this.publish({
      windows: [],
      activeWindow: "",
      activePane: "",
      connected: true,
      error: null,
    });
    this.client = new TmuxClient(
      (command) =>
        api.writeSessionBinary(this.id, api.bytesToBase64(encode(command))),
      (pane, bytes) => {
        const entry = this.panes.get(pane);
        if (entry?.ready) entry.controller.write(entry.stream.feed(bytes));
      },
      (line) => this.notification(line),
      (message) => this.failed(message),
    );
    this.scheduleRefresh();
  }

  private notification(line: string) {
    if (line.startsWith("%exit")) {
      this.client?.stop();
      return;
    }
    const layout = /^%layout-change (@\d+) (\S+) (\S+)(?: .*)?$/.exec(line);
    if (layout && this.view) {
      this.layoutRevision++;
      try {
        const fullLayout = parseTmuxLayout(layout[2]);
        const visibleLayout = parseTmuxLayout(layout[3]);
        // Resize before any following %output: shell redraws in the same
        // transport read already use the new grid, not the previous layout.
        for (const leaf of tmuxLeaves(visibleLayout)) {
          this.panes
            .get(leaf.pane!)
            ?.controller.setRemoteSize(leaf.cols, leaf.rows);
        }
        // New panes need their routed controllers before React mounts them.
        if (
          tmuxLeaves(fullLayout).every(
            (leaf) => this.panes.get(leaf.pane!)?.ready,
          )
        ) {
          this.publish({
            ...this.view,
            windows: this.view.windows.map((window) =>
              window.id === layout[1]
                ? { ...window, layout: visibleLayout, fullLayout }
                : window,
            ),
          });
        }
      } catch (error) {
        this.error(String(error));
      }
    }
    if (
      /^%(?:window-|session-|sessions-changed|layout-change|pane-mode-changed)/.test(
        line,
      )
    ) {
      this.scheduleRefresh();
    } else if (line.startsWith("%config-error ")) this.error(line.slice(14));
  }
  private scheduleRefresh() {
    this.dirty = true;
    if (this.refreshing || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 25);
  }

  private async refresh() {
    const client = this.client;
    const generation = this.generation;
    const layoutRevision = this.layoutRevision;
    if (!client || !this.view?.connected) return;
    this.refreshing = true;
    this.dirty = false;
    try {
      const lines = await client.request(`list-windows -F '${WINDOW_FORMAT}'`);
      if (generation !== this.generation) return;
      if (layoutRevision !== this.layoutRevision) return;
      let activeWindow = "";
      const windows: TmuxWindow[] = lines.map((line) => {
        const [id, active, layout, fullLayout, activePane, ...name] =
          text(line).split("\t");
        tmuxId(id, "@");
        tmuxId(activePane, "%");
        if (active === "1") activeWindow = id;
        return {
          id,
          activePane,
          layout: parseTmuxLayout(layout),
          fullLayout: parseTmuxLayout(fullLayout),
          name: name.join("\t").replace(/\\(.)/g, "$1"),
        };
      });
      if (!activeWindow) activeWindow = windows[0]?.id ?? "";
      const wanted = new Set(
        windows.flatMap((window) =>
          tmuxLeaves(window.fullLayout).map((leaf) => leaf.pane!),
        ),
      );
      for (const [pane] of this.panes) {
        if (!wanted.has(pane)) {
          this.panes.delete(pane);
          disposeController(this.paneControllerId(pane));
        }
      }
      for (const window of windows) {
        const visibleLeaves = tmuxLeaves(window.layout);
        for (const fullLeaf of tmuxLeaves(window.fullLayout)) {
          const leaf =
            visibleLeaves.find((item) => item.pane === fullLeaf.pane) ??
            fullLeaf;
          const pane = leaf.pane!;
          let entry = this.panes.get(pane);
          if (!entry) {
            const controller = await ensureController(
              this.paneControllerId(pane),
              {
                ownerId: this.id,
                write: (data) => this.writePane(pane, data),
              },
            );
            if (generation !== this.generation) {
              disposeController(this.paneControllerId(pane));
              return;
            }
            const profile = useStore
              .getState()
              .tabs.find((tab) => tab.info.id === this.id)?.profile;
            controller.setBackspace(profile?.backspace);
            entry = { controller, ready: false, stream: new TmuxPaneStream() };
            this.panes.set(pane, entry);
          }
          entry.controller.setRemoteSize(leaf.cols, leaf.rows);
          if (!entry.ready) {
            const target = entry;
            const history = Math.min(
              useStore.getState().terminalScrollback,
              20_000,
            );
            await client.batch(
              [
                `capture-pane -p -e -C -J -a -q -t ${pane}`,
                `capture-pane -p -e -C -J -S -${history} -t ${pane}`,
                `display-message -p -t ${pane} '${MODE_FORMAT}'`,
                `capture-pane -p -P -C -t ${pane}`,
              ],
              (results) => {
                if (generation !== this.generation) return;
                restoreTmuxPane(target.controller, results, target.stream);
                target.ready = true;
              },
            );
          }
        }
      }
      if (generation !== this.generation) return;
      if (layoutRevision !== this.layoutRevision) return;
      const active = windows.find((window) => window.id === activeWindow);
      this.publish({
        windows,
        activeWindow,
        activePane: active?.activePane ?? "",
        connected: true,
        error: null,
      });
    } catch (error) {
      if (generation === this.generation) this.error(String(error));
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
        if (this.dirty) this.scheduleRefresh();
      }
    }
  }

  write(text: string) {
    return this.writePane(this.view?.activePane ?? "", text);
  }
  writePane(pane: string, value: string): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client || !this.view?.connected || !this.panes.has(pane))
      return Promise.reject(new Error("tmux is disconnected"));
    const bytes = encode(value);
    if (this.pendingInput + bytes.length > 1024 * 1024) {
      this.error(
        "tmux input queue is full. Wait for the connection to catch up.",
      );
      return Promise.reject(new Error("tmux input queue is full"));
    }
    this.pendingInput += bytes.length;
    // Pin the pane before any await; switching focus cannot redirect a paste.
    const result = this.input.then(() => sendTmuxBytes(client, pane, bytes));
    this.input = result
      .catch((error) => {
        if (generation === this.generation) this.error(String(error));
      })
      .finally(() => {
        this.pendingInput -= bytes.length;
      });
    return result;
  }

  private async command(value: string) {
    if (!this.client || !this.view?.connected)
      throw new Error("tmux is disconnected");
    const generation = this.generation;
    try {
      await this.client.request(value);
    } catch (error) {
      if (generation === this.generation) this.error(String(error));
      throw error;
    }
  }
  selectWindow(id: string) {
    const window = this.view?.windows.find((item) => item.id === id);
    if (!window || !this.view) return;
    this.publish({
      ...this.view,
      activeWindow: id,
      activePane: window.activePane,
    });
    if (this.view.connected)
      void this.command(`select-window -t ${tmuxId(id, "@")}`).catch(
        () => undefined,
      );
  }
  selectPane(id: string) {
    if (!this.view || this.view.activePane === id || !this.panes.has(id))
      return;
    this.publish({
      ...this.view,
      activePane: id,
      windows: this.view.windows.map((window) =>
        window.id === this.view!.activeWindow
          ? { ...window, activePane: id }
          : window,
      ),
    });
    if (this.view.connected)
      void this.command(`select-pane -t ${tmuxId(id, "%")}`).catch(
        () => undefined,
      );
  }
  newWindow() {
    return this.command("new-window");
  }
  split(side: "right" | "down") {
    return this.command(
      `split-window ${side === "right" ? "-h" : "-v"} -t ${tmuxId(this.view?.activePane ?? "", "%")}`,
    );
  }
  closePane(id = this.view?.activePane ?? "") {
    return this.command(`kill-pane -t ${tmuxId(id, "%")}`);
  }
  detach() {
    return this.command("detach-client");
  }
  resizeWindow(id: string, cols: number, rows: number) {
    if (!this.view?.connected || id !== this.view.activeWindow) return;
    cols = Math.max(2, Math.min(1000, Math.round(cols)));
    rows = Math.max(2, Math.min(1000, Math.round(rows)));
    const window = this.view.windows.find((item) => item.id === id);
    if (
      !window ||
      (Math.abs(window.layout.cols - cols) <= 1 &&
        Math.abs(window.layout.rows - rows) <= 1)
    )
      return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      void this.command(
        `refresh-client -C ${tmuxId(id, "@")}\:${cols}x${rows}`,
      ).catch(() => undefined);
    }, 100);
  }
  resizePane(id: string, direction: "row" | "column", delta: number) {
    const cells = Math.round(Math.abs(delta));
    if (!cells) return;
    const flag =
      direction === "row" ? (delta > 0 ? "R" : "L") : delta > 0 ? "D" : "U";
    void this.command(
      `resize-pane -t ${tmuxId(id, "%")} -${flag} ${cells}`,
    ).catch(() => undefined);
  }
  async cwd() {
    if (!this.client || !this.view?.connected)
      throw new Error("tmux is disconnected");
    const lines = await this.client.request(
      `display-message -p -t ${tmuxId(this.view.activePane, "%")} '#{pane_current_path}'`,
    );
    return lines.map(text).join("\n");
  }

  stateChanged(state: SessionState) {
    if (state === "connecting") {
      this.clear();
      this.stream.reset();
      this.publish(null);
    } else if ((state === "closed" || state === "error") && this.view) {
      this.generation++;
      clearTimeout(this.refreshTimer);
      clearTimeout(this.resizeTimer);
      this.refreshTimer = undefined;
      this.refreshing = false;
      this.dirty = false;
      this.client?.stop("Connection closed");
      for (const { controller } of this.panes.values())
        controller.setLocked(true);
      this.publish({ ...this.view, connected: false });
    }
  }
  private error(message: string) {
    if (this.view && !this.disposed)
      this.publish({ ...this.view, error: message });
  }
  private failed(message: string) {
    this.client?.stop(message);
    this.error(message);
    // An empty command detaches control mode; never send protocol commands
    // after an unframed error, where the shell could consume them instead.
    if (this.stream.active)
      void api
        .writeSessionBinary(this.id, api.bytesToBase64(encode("\n")))
        .catch(() => undefined);
  }
  private end() {
    this.clear();
    this.base.setLocked(false);
    this.publish(null);
    // The hidden gateway may have fitted while control mode owned resize.
    // Its next fit need not emit onResize, so explicitly restore the PTY size.
    const size = this.base.fit();
    void api
      .resizeSession(
        this.id,
        size?.cols ?? this.base.term.cols,
        size?.rows ?? this.base.term.rows,
      )
      .catch(() => undefined);
    this.base.writeText(
      "\r\n[tmux detached — reattach with tmux -CC attach]\r\n",
    );
  }
  private clear() {
    this.generation++;
    this.client?.stop();
    this.client = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.resizeTimer);
    this.refreshTimer = undefined;
    this.refreshing = false;
    this.dirty = false;
    for (const pane of this.panes.keys())
      disposeController(this.paneControllerId(pane));
    this.panes.clear();
    const store = useStore.getState();
    if (store.pastePrompt?.sessionId.startsWith(`${this.id}:tmux:`))
      store.setPastePrompt(null);
    if (store.clipboardPrompt?.sessionId.startsWith(`${this.id}:tmux:`))
      store.setClipboardPrompt(null);
  }
  dispose() {
    this.disposed = true;
    this.clear();
    this.stream.reset();
    this.view = null;
    this.listeners.clear();
  }
}

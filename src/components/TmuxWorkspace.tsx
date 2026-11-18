import { useEffect, useRef } from "react";
import { reconnectSession } from "../actions";
import { t, tf } from "../i18n";
import { ask } from "../nativeDialog";
import { chordLabel } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { getBaseController } from "../terminalRegistry";
import { tmuxLeaves, type TmuxLayout } from "../tmuxProtocol";
import type { TmuxSessionBridge, TmuxSnapshot } from "../tmuxRegistry";
import { Icon } from "./icons";
import { Splitter } from "./Splitter";
import { TerminalHost } from "./TerminalPane";

interface Props {
  tab: Tab;
  session: TmuxSessionBridge;
  snapshot: TmuxSnapshot;
  visible: boolean;
  focused: boolean;
}

export default function TmuxWorkspace({
  tab,
  session,
  snapshot,
  visible,
  focused,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const resizeRemainders = useRef(new Map<string, number>());
  const splitRight = useStore((s) => chordLabel(s.shortcuts.splitRight));
  const splitDown = useStore((s) => chordLabel(s.shortcuts.splitDown));
  const window = snapshot.windows.find(
    (item) => item.id === snapshot.activeWindow,
  );
  const ready = snapshot.connected && !!window;
  const run = (task: Promise<unknown>) => {
    void task.catch(() => undefined);
  };
  const focus = () => session.activeController()?.focus();

  useEffect(() => {
    if (!window || !visible) return;
    // Report the room available to a single active pane as a window size.
    // xterm itself stays at the authoritative grid dimensions from tmux.
    const leaf = tmuxLeaves(window.layout).find(
      (item) => item.pane === snapshot.activePane,
    );
    if (!leaf) return;
    const controller = getBaseController(session.paneControllerId(leaf.pane!));
    if (!controller) return;
    controller.onAvailableSize = (cols, rows) =>
      session.resizeWindow(
        window.id,
        (cols * window.layout.cols) / leaf.cols,
        (rows * window.layout.rows) / leaf.rows,
      );
    const frame = requestAnimationFrame(() => controller.fit());
    return () => {
      cancelAnimationFrame(frame);
      controller.onAvailableSize = null;
    };
  }, [window, session, snapshot.activePane, visible]);

  const closePane = async () => {
    const pane = snapshot.activePane;
    if (
      await ask(
        tf(
          "Close tmux pane {pane}? The program running in it will be terminated. Use Detach to keep all programs running.",
          { pane },
        ),
        {
          title: t("Close tmux Pane"),
          kind: "warning",
          okLabel: t("Close Pane"),
          cancelLabel: t("Cancel"),
        },
      )
    )
      await session.closePane(pane);
    focus();
  };

  // Separators are overlays. Pane terminals stay in one flat keyed list,
  // retaining scrollback when tmux changes their layout or zoom state.
  const boundaries = (node: TmuxLayout): React.ReactNode[] => {
    const root = window?.layout;
    if (!root || !node.direction) return [];
    return node.children.flatMap((child, index) => {
      const nested = boundaries(child);
      if (index === node.children.length - 1) return nested;
      const row = node.direction === "row";
      const x = row ? child.x + child.cols : node.x;
      const y = row ? node.y : child.y + child.rows;
      const target = tmuxLeaves(child)[0].pane!;
      return [
        ...nested,
        <div
          key={`${node.direction}:${target}`}
          className={`tmux-divider is-${node.direction}`}
          style={{
            left: `${(x / root.cols) * 100}%`,
            top: `${(y / root.rows) * 100}%`,
            width: row
              ? `${100 / root.cols}%`
              : `${(node.cols / root.cols) * 100}%`,
            height: row
              ? `${(node.rows / root.rows) * 100}%`
              : `${100 / root.rows}%`,
          }}
        >
          <Splitter
            orientation={row ? "vertical" : "horizontal"}
            onResize={(delta) => {
              const box = ref.current?.getBoundingClientRect();
              if (!box || !ready) return;
              const key = `${target}:${node.direction}`;
              const cells =
                (resizeRemainders.current.get(key) ?? 0) +
                delta * (row ? root.cols / box.width : root.rows / box.height);
              const whole = Math.trunc(cells);
              resizeRemainders.current.set(key, cells - whole);
              if (whole) session.resizePane(target, node.direction!, whole);
            }}
          />
        </div>,
      ];
    });
  };

  return (
    <div className="tmux-workspace">
      <div className="tmux-toolbar">
        <span className="tmux-label">tmux</span>
        <div className="tmux-windows" role="tablist" aria-label={t("tmux windows")}>
          {snapshot.windows.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === snapshot.activeWindow}
              className={`tmux-window${item.id === snapshot.activeWindow ? " is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                session.selectWindow(item.id);
                focus();
              }}
            >
              {item.name || item.id}
            </button>
          ))}
        </div>
        <div className="tmux-actions">
          <button
            disabled={!ready}
            title={t("New tmux Window")}
            aria-label={t("New tmux Window")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(session.newWindow())}
          >
            <Icon name="add" />
          </button>
          <button
            disabled={!ready}
            title={splitRight ? tf("Split Right ({shortcut})", { shortcut: splitRight }) : t("Split Right")}
            aria-label={t("Split tmux Pane Right")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(session.split("right"))}
          >
            <Icon name="split-horizontal" />
          </button>
          <button
            disabled={!ready}
            title={splitDown ? tf("Split Down ({shortcut})", { shortcut: splitDown }) : t("Split Down")}
            aria-label={t("Split tmux Pane Down")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(session.split("down"))}
          >
            <Icon name="split-vertical" />
          </button>
          <button
            disabled={!ready}
            title={t("Close tmux Pane")}
            aria-label={t("Close tmux Pane")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(closePane())}
          >
            <Icon name="close" />
          </button>
          <button
            disabled={!snapshot.connected}
            onClick={() => run(session.detach())}
          >
            {t("Detach")}
          </button>
          {!snapshot.connected && (
            <button onClick={() => run(reconnectSession(tab.info.id))}>
              {t("Reconnect")}
            </button>
          )}
        </div>
      </div>
      {snapshot.error && (
        <div className="tmux-error" role="alert">
          {snapshot.error}
        </div>
      )}
      {!snapshot.connected && (
        <div className="tmux-notice">
          {t("Connection closed. Reconnect, then run tmux -CC attach to restore this workspace.")}
        </div>
      )}
      <div className="tmux-content" ref={ref}>
        {!window && <div className="tmux-loading">{t("Loading tmux windows…")}</div>}
        {snapshot.windows.flatMap((item) =>
          tmuxLeaves(item.fullLayout).map((fullLeaf) => {
            const visibleLeaf = tmuxLeaves(item.layout).find(
              (leaf) => leaf.pane === fullLeaf.pane,
            );
            const leaf = visibleLeaf ?? fullLeaf;
            const shown =
              visible && item.id === snapshot.activeWindow && !!visibleLeaf;
            return (
              <div
                key={leaf.pane}
                className={`tmux-pane${leaf.pane === snapshot.activePane ? " is-focused" : ""}${shown ? "" : " is-hidden"}`}
                style={{
                  left: `${(leaf.x / item.layout.cols) * 100}%`,
                  top: `${(leaf.y / item.layout.rows) * 100}%`,
                  width: `${(leaf.cols / item.layout.cols) * 100}%`,
                  height: `${(leaf.rows / item.layout.rows) * 100}%`,
                }}
                onMouseDownCapture={() => session.selectPane(leaf.pane!)}
                onFocusCapture={() => session.selectPane(leaf.pane!)}
              >
                <TerminalHost
                  tab={tab}
                  controllerId={session.paneControllerId(leaf.pane!)}
                  visible={shown}
                  focused={
                    shown && focused && leaf.pane === snapshot.activePane
                  }
                />
              </div>
            );
          }),
        )}
        {window && boundaries(window.layout)}
      </div>
    </div>
  );
}

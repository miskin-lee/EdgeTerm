import { useEffect, useRef } from "react";

import { ensureController } from "../actions";
import { useStore, type Tab } from "../store";
import { getController } from "../terminalRegistry";

interface Props {
  onNewSession: () => void;
}

export function TerminalPane({ onNewSession }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);

  return (
    <div className="term-stack">
      {tabs.map((tab) => (
        <TerminalHost
          key={tab.info.id}
          tab={tab}
          active={tab.info.id === activeId}
        />
      ))}

      {tabs.length === 0 && (
        <div className="term-empty">
          <h1>EdgeTerm</h1>
          <div className="term-empty-hint">
            <span>No session is open.</span>
            <span>
              Press <kbd>⌘N</kbd> for a new session, or pick one from the
              Session panel.
            </span>
          </div>
          <button className="btn is-primary" onClick={onNewSession}>
            New Session
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalHost({ tab, active }: { tab: Tab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const gutterMode = useStore((s) => s.gutterMode);
  const id = tab.info.id;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    ensureController(id).attach(element);

    const observer = new ResizeObserver(() => {
      getController(id)?.fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id]);

  useEffect(() => {
    getController(id)?.setGutterMode(gutterMode);
  }, [id, gutterMode]);

  useEffect(() => {
    if (!active) return;
    // The pane is hidden while inactive, so it can only be measured and
    // focused once it is on screen again.
    const frame = requestAnimationFrame(() => {
      const controller = getController(id);
      controller?.fit();
      controller?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, id]);

  return (
    <div ref={ref} className={`term-pane${active ? "" : " is-hidden"}`} />
  );
}

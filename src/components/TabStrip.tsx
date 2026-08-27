import type { CSSProperties } from "react";

import { useStore } from "../store";
import { colorForSession } from "../types";

interface Props {
  onNewSession: () => void;
}

export function TabStrip({ onNewSession }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const requestCloseTab = useStore((s) => s.requestCloseTab);

  return (
    <div className="tabstrip">
      {tabs.map((tab, index) => {
        const active = tab.info.id === activeId;
        const sessionColor =
          tab.info.color ??
          colorForSession(tab.info.profileId ?? tab.info.name);
        return (
          <div
            key={tab.info.id}
            className={[
              "tab",
              active ? "is-active" : "",
              `is-${tab.state}`,
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ "--session-color": sessionColor } as CSSProperties}
            onMouseDown={() => setActive(tab.info.id)}
            title={`${tab.info.protocol} · ${tab.info.address} · ${tab.message ?? tab.state}`}
          >
            <span className="tab-index">{index + 1}.</span>
            <span className="tab-dot" aria-hidden="true" />
            <span className="tab-label">{tab.info.name}</span>
            <button
              className="tab-close"
              onMouseDown={(event) => {
                event.stopPropagation();
                requestCloseTab(tab.info.id);
              }}
              title="Close session"
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="tabstrip-actions">
        <button className="panel-action" onClick={onNewSession} title="New session">
          ＋
        </button>
      </div>
    </div>
  );
}

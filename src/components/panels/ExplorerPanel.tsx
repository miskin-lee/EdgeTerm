import { useState } from "react";

import { useStore } from "../../store";
import { colorForSession } from "../../types";

export function ExplorerPanel() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? tabs.filter((tab) => tab.info.name.toLowerCase().includes(needle))
    : tabs;

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" />
          Explorer
        </div>
        <span className="row-meta">{tabs.length}</span>
      </div>

      <div className="panel-filter">
        <input
          value={filter}
          placeholder="Filter"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="panel-body">
        {visible.length === 0 && (
          <div className="panel-empty">No open sessions</div>
        )}
        {visible.map((tab) => (
          <div
            key={tab.info.id}
            className={`row${tab.info.id === activeId ? " is-active" : ""}`}
            onMouseDown={() => setActive(tab.info.id)}
            title={tab.info.address}
          >
            <span
              className="row-dot"
              style={{
                background:
                  tab.state === "closed"
                    ? "#5c6370"
                    : (tab.info.color ?? colorForSession(tab.info.name)),
              }}
            />
            <span className="row-label">{tab.info.name}</span>
            <button
              className="panel-action"
              onMouseDown={(event) => {
                event.stopPropagation();
                void closeTab(tab.info.id);
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

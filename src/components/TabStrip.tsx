import { useStore } from "../store";
import { colorForSession } from "../types";

interface Props {
  onNewSession: () => void;
}

export function TabStrip({ onNewSession }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);

  return (
    <div className="tabstrip">
      {tabs.map((tab, index) => {
        const active = tab.info.id === activeId;
        return (
          <div
            key={tab.info.id}
            className={[
              "tab",
              active ? "is-active" : "",
              tab.state === "closed" ? "is-closed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseDown={() => setActive(tab.info.id)}
            title={`${tab.info.protocol} · ${tab.info.address}`}
          >
            <span className="tab-index">{index + 1}.</span>
            <span
              className="tab-dot"
              style={{
                background:
                  tab.state === "closed"
                    ? "#5c6370"
                    : (tab.info.color ?? colorForSession(tab.info.name)),
              }}
            />
            <span className="tab-label">{tab.info.name}</span>
            <button
              className="tab-close"
              onMouseDown={(event) => {
                event.stopPropagation();
                void closeTab(tab.info.id);
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

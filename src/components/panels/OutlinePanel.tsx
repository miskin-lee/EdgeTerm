import { useActiveTab, useStore } from "../../store";
import { getController } from "../../terminalRegistry";

export function OutlinePanel() {
  const tab = useActiveTab();
  const activeId = useStore((s) => s.activeId);
  const outline = tab?.outline ?? [];

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" style={{ background: "#bc8cff" }} />
          Outline
        </div>
        <span className="row-meta">{outline.length}</span>
      </div>

      <div className="panel-body">
        {outline.length === 0 && (
          <div className="panel-empty">
            Commands you run appear here.
            <br />
            Click one to jump back to it.
          </div>
        )}
        {[...outline].reverse().map((item, index) => (
          <div
            key={`${item.line}-${index}`}
            className="row"
            title={item.text}
            onMouseDown={() => {
              if (activeId) getController(activeId)?.scrollToLine(item.line);
            }}
          >
            <span className="row-meta" style={{ minWidth: 34 }}>
              {item.line}
            </span>
            <span className="row-label">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

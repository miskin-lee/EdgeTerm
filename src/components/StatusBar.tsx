import { useEffect, useState } from "react";

import { useActiveTab, useStore } from "../store";

export function StatusBar() {
  const tab = useActiveTab();
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const gutterMode = useStore((s) => s.gutterMode);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${clock.getFullYear()}/${clock.getMonth() + 1}/${clock.getDate()} ${pad(
    clock.getHours(),
  )}:${pad(clock.getMinutes())}`;

  return (
    <div className="statusbar">
      <span className={`status-item${error ? " is-error" : ""}`}>
        {error ?? status}
      </span>
      <div className="status-spacer" />
      {tab && (
        <>
          <span className="status-item">
            {tab.info.kind === "local" ? "Local Mode" : "Remote Mode"}
          </span>
          {tab.info.kind === "ftp" ? (
            <span className="status-item">Dual-pane file transfer</span>
          ) : (
            <>
              <span className="status-item">
                Window {tab.rows}×{tab.cols}
              </span>
              <span className="status-item">
                Ln {tab.cursorLine} Ch {tab.cursorColumn}
              </span>
            </>
          )}
          <span className="status-item">{tab.info.protocol}</span>
        </>
      )}
      {tab?.info.kind !== "ftp" && (
        <span className="status-item">gutter: {gutterMode}</span>
      )}
      <span className="status-item">{stamp}</span>
    </div>
  );
}

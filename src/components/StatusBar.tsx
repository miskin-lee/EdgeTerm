import { useEffect, useState } from "react";

import * as api from "../api";
import { t, useT } from "../i18n";
import { useActiveTab, useStore } from "../store";
import { isFileSession, type LegacyAlgorithms } from "../types";
import { Icon } from "./icons";

/** The folder half of a recording's path, for the Reveal click. */
const parentDir = (path: string): string =>
  path.replace(/[\\/][^\\/]*$/, "") || path;

/** The tooltip naming each server's legacy algorithms, one server a line. */
const legacyTitle = (servers: LegacyAlgorithms[]): string =>
  [
    t(
      "Connected with legacy SSH algorithms, because the server offers nothing newer:",
    ),
    ...servers.map(({ address, algorithms }) => `${address}: ${algorithms.join(", ")}`),
  ].join("\n");

export function StatusBar() {
  const t = useT();
  const tab = useActiveTab();
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${clock.getFullYear()}/${clock.getMonth() + 1}/${clock.getDate()} ${pad(
    clock.getHours(),
  )}:${pad(clock.getMinutes())}`;

  const recording = tab?.state === "connected" ? tab.info.recording : null;
  const legacy = tab?.state === "connected" ? tab.info.legacyAlgorithms : [];

  return (
    <div className="statusbar">
      <span className={`status-item${error ? " is-error" : ""}`}>
        {error ?? status}
      </span>
      <div className="status-spacer" />
      {tab && (
        <>
          {legacy.length > 0 && (
            <span className="status-item status-legacy" title={legacyTitle(legacy)}>
              <Icon name="warning" />
              {t("Legacy SSH")}
            </span>
          )}
          {recording && (
            <button
              type="button"
              className="status-item status-recording"
              title={t("Recording to {path} — click to open the folder", {
                path: recording,
              })}
              onClick={() =>
                void api.openLocalPath(parentDir(recording)).catch(() => undefined)
              }
            >
              <Icon name="record" />
              REC
            </button>
          )}
          {isFileSession(tab.info.kind) ? (
            <span className="status-item">{t("Dual-pane file transfer")}</span>
          ) : (
            <span className="status-item">
              {t("Window {rows}×{cols}", { rows: tab.rows, cols: tab.cols })}
            </span>
          )}
          <span className="status-item">{tab.info.protocol}</span>
        </>
      )}
      <span className="status-item">{stamp}</span>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";

import * as api from "./api";
import { MenuBar } from "./components/MenuBar";
import { SearchOverlay } from "./components/SearchOverlay";
import { SessionDialog } from "./components/SessionDialog";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TerminalPane } from "./components/TerminalPane";
import { UpdateDialog } from "./components/UpdateDialog";
import { FilerPanel } from "./components/panels/FilerPanel";
import { SenderPanel } from "./components/panels/SenderPanel";
import { SessionPanel } from "./components/panels/SessionPanel";
import { useActiveTab, useStore, type PanelName } from "./store";
import { getController } from "./terminalRegistry";
import type { SessionProfile, SessionState } from "./types";
import { useUpdater } from "./updater";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const viewPanelByShortcutCode: Partial<Record<string, PanelName>> = {
  ArrowLeft: "filer",
  ArrowRight: "sessions",
  ArrowDown: "sender",
};

export default function App() {
  const updater = useUpdater();
  const activeId = useStore((s) => s.activeId);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const loadProfiles = useStore((s) => s.loadProfiles);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const applyState = useStore((s) => s.applyState);
  const activeTab = useActiveTab();
  const ftpMode = activeTab?.info.kind === "ftp";

  const [dialog, setDialog] = useState<{ profile: SessionProfile | null } | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(220);
  const [senderHeight, setSenderHeight] = useState(160);

  // --- backend events -------------------------------------------------------

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const unlisten = api.onSessionOutput(({ id, data }) => {
      getController(id)?.write(api.base64ToBytes(data));
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const unlisten = api.onSessionState(({ id, state, message }) => {
      applyState(id, state as SessionState, message ?? undefined);
      if (state === "closed") {
        getController(id)?.writeText("\r\n\x1b[33m[session closed]\x1b[0m\r\n");
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [applyState]);

  // --- actions --------------------------------------------------------------

  const newSession = useCallback(() => setDialog({ profile: null }), []);

  const gotoLine = useCallback(() => {
    setGotoValue("");
    setGotoOpen(true);
  }, []);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      // xterm keeps a hidden textarea for input, so "focus is in a text field"
      // has to exclude the terminal itself or every shortcut would be dead
      // exactly where it matters most.
      const target = event.target as HTMLElement | null;
      const inTerminal = Boolean(target?.closest(".xterm"));
      if (!inTerminal && target?.closest("input, textarea, select")) return;

      const key = event.key.toLowerCase();

      if (event.altKey && !event.shiftKey) {
        const panel = viewPanelByShortcutCode[event.code];
        if (panel) {
          event.preventDefault();
          togglePanel(panel);
          return;
        }
      }

      if (key === "n") {
        event.preventDefault();
        newSession();
      } else if (key === "w" && activeId) {
        event.preventDefault();
        void closeTab(activeId);
      } else if (key === "f" && !ftpMode) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (key === "k" && activeId && !ftpMode) {
        event.preventDefault();
        getController(activeId)?.clear();
      } else if (
        key === "g" &&
        event.ctrlKey &&
        !event.metaKey &&
        !ftpMode
      ) {
        event.preventDefault();
        gotoLine();
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const tab = useStore.getState().tabs[index];
        if (tab) {
          event.preventDefault();
          setActive(tab.info.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeId,
    closeTab,
    gotoLine,
    ftpMode,
    newSession,
    setActive,
    togglePanel,
  ]);

  // --- layout ---------------------------------------------------------------

  const showLeft = panels.filer && !ftpMode;
  const showRight = panels.sessions;

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region />

      <MenuBar
        onNewSession={newSession}
        onFind={() => {
          if (!ftpMode) setSearchOpen(true);
        }}
        onGotoLine={() => {
          if (!ftpMode) gotoLine();
        }}
        onCheckForUpdates={() => void updater.checkForUpdates()}
        onAbout={() => setAboutOpen(true)}
      />

      <div className="main">
        {showLeft && (
          <>
            <div
              className="sidebar sidebar-left"
              style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }}
            >
              <FilerPanel />
            </div>
            <Splitter
              orientation="vertical"
              onResize={(delta) =>
                setLeftWidth((width) => clamp(width + delta, 150, 520))
              }
            />
          </>
        )}

        <div className="center">
          <TabStrip onNewSession={newSession} />
          <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
          <TerminalPane onNewSession={newSession} />
        </div>

        {showRight && (
          <>
            <Splitter
              orientation="vertical"
              onResize={(delta) =>
                setRightWidth((width) => clamp(width - delta, 150, 520))
              }
            />
            <div
              className="sidebar sidebar-right"
              style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}
            >
              <SessionPanel
                onNewSession={newSession}
                onEditProfile={(profile) => setDialog({ profile })}
              />
            </div>
          </>
        )}
      </div>

      {panels.sender && (
        <>
          <Splitter
            orientation="horizontal"
            onResize={(delta) =>
              setSenderHeight((height) => clamp(height - delta, 80, 400))
            }
          />
          <div className="bottom-dock" style={{ height: senderHeight }}>
            <SenderPanel />
          </div>
        </>
      )}

      <StatusBar />

      <UpdateDialog
        appVersion={updater.appVersion}
        state={updater.state}
        onDismiss={updater.dismiss}
        onInstall={() => void updater.installUpdate()}
        onCheckAgain={() => void updater.checkForUpdates()}
      />

      {dialog && (
        <SessionDialog
          initial={dialog.profile}
          onClose={() => setDialog(null)}
        />
      )}

      {gotoOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setGotoOpen(false)}>
          <div
            className="dialog"
            style={{ width: 320 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">Go to Line</div>
            <div className="dialog-body">
              <input
                autoFocus
                value={gotoValue}
                placeholder="Line number"
                onChange={(event) => setGotoValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const line = Number(gotoValue);
                  if (activeId && Number.isFinite(line)) {
                    getController(activeId)?.scrollToLine(line);
                  }
                  setGotoOpen(false);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {aboutOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setAboutOpen(false)}>
          <div
            className="dialog"
            style={{ width: 380 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">About EdgeTerm</div>
            <div className="dialog-body" style={{ lineHeight: 1.7 }}>
              <strong>
                EdgeTerm{updater.appVersion ? ` ${updater.appVersion}` : ""}
              </strong>
              <span>
                A WindTerm-inspired terminal, SSH, FTP and serial client built
                with Rust + Tauri.
              </span>
              <span style={{ color: "var(--fg-faint)" }}>
                Local shell via portable-pty · SSH and SFTP via russh · FTP via
                SuppaFTP · serial via serialport · terminal rendering by
                xterm.js
              </span>
            </div>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

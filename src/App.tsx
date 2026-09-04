import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  acceptHostKey,
  revealCwdInFiler,
  SESSION_CLOSED_NOTICE,
} from "./actions";
import * as api from "./api";
import { AuthPromptDialog } from "./components/AuthPromptDialog";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { QuitConfirmDialog } from "./components/QuitConfirmDialog";
import { FontSizeDialog } from "./components/FontSizeDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { MenuBar } from "./components/MenuBar";
import {
  SearchOverlay,
  type SearchOverlayHandle,
} from "./components/SearchOverlay";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TerminalPane } from "./components/TerminalPane";
import { UpdateDialog } from "./components/UpdateDialog";
import { FilerPanel } from "./components/panels/FilerPanel";
import { SenderPanel } from "./components/panels/SenderPanel";
import { SessionPanel } from "./components/panels/SessionPanel";
import { commandHistory } from "./history";
import { setSemanticColorTheme } from "./semanticColors";
import { matchAppShortcut } from "./shortcuts";
import { useActiveTab, useStore } from "./store";
import { allControllers, getController } from "./terminalRegistry";
import { isFileSession, type SessionProfile, type SessionState } from "./types";
import { useUpdater } from "./updater";

// The largest dialog in the application, and one nothing shows until the user
// asks for a session, so it is not part of what the window opens with.
const SessionDialog = lazy(() =>
  import("./components/SessionDialog").then((module) => ({
    default: module.SessionDialog,
  })),
);

const REPO_URL = "https://github.com/miskin-lee/EdgeTerm";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const hasLiveSessions = () =>
  useStore
    .getState()
    .tabs.some((tab) => tab.state === "connecting" || tab.state === "connected");

export default function App() {
  const updater = useUpdater();
  const activeId = useStore((s) => s.activeId);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const loadProfiles = useStore((s) => s.loadProfiles);
  const panelFontSize = useStore((s) => s.panelFontSize);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const setPanelFontSize = useStore((s) => s.setPanelFontSize);
  const setBufferFontSize = useStore((s) => s.setBufferFontSize);
  const setTerminalScrollback = useStore((s) => s.setTerminalScrollback);
  const setActive = useStore((s) => s.setActive);
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);
  const closeTab = useStore((s) => s.closeTab);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const setClosePrompt = useStore((s) => s.setClosePrompt);
  const applyState = useStore((s) => s.applyState);
  const hostKeyPrompt = useStore((s) => s.hostKeyPrompt);
  const setHostKeyPrompt = useStore((s) => s.setHostKeyPrompt);
  // A connection stops mid-handshake for each round; answer the oldest first.
  const authPrompt = useStore((s) => s.authPrompts[0] ?? null);
  const addAuthPrompt = useStore((s) => s.addAuthPrompt);
  const clearAuthPrompt = useStore((s) => s.clearAuthPrompt);
  const theme = useStore((s) => s.theme);
  const activeTab = useActiveTab();
  const fileMode = activeTab ? isFileSession(activeTab.info.kind) : false;
  const closingTab = useStore((s) =>
    s.closePrompt === null
      ? undefined
      : s.tabs.find((tab) => tab.info.id === s.closePrompt),
  );

  const [dialog, setDialog] = useState<{ profile: SessionProfile | null } | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<SearchOverlayHandle>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [fontSettingsOpen, setFontSettingsOpen] = useState(false);
  const [quitPromptOpen, setQuitPromptOpen] = useState(false);

  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(220);
  const [senderHeight, setSenderHeight] = useState(160);

  // --- backend events -------------------------------------------------------

  useEffect(() => {
    void loadProfiles();
    // Opt-in feature: fetch the history only for users who enabled it.
    if (useStore.getState().suggestionsEnabled) commandHistory.load();
  }, [loadProfiles]);

  // The window is hidden until there is an interface to show, so the
  // application opens on the UI rather than on an empty frame (issue #35).
  // A hidden window never paints, and `requestAnimationFrame` never fires
  // with it, so the reveal goes out as soon as this first render is
  // committed: the frame the window opens with is drawn from that DOM.
  useEffect(() => {
    void api.showMainWindow().catch(() => {});
  }, []);

  // xterm is loaded with the first session (see `ensureController`), which
  // leaves the start-up bundle small but would make that first session wait
  // for it. Fetch it in the quiet moment after the window is up instead.
  useEffect(() => {
    const timer = window.setTimeout(() => void import("./terminal"), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  // Theme is applied in three places: the CSS variable palette keys off the
  // root data-theme attribute, semantic decorations read a module-level
  // palette, and each live terminal owns its own xterm theme object. The
  // backend is told as well, so the next launch opens its window in this
  // theme's background colour; a failed write only costs that.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setSemanticColorTheme(theme);
    for (const controller of allControllers()) controller.setTheme(theme);
    void api.setStartupTheme(theme).catch(() => {});
  }, [theme]);

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
        getController(id)?.writeText(SESSION_CLOSED_NOTICE);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [applyState]);

  useEffect(() => {
    const unlisten = api.onAuthPrompt(addAuthPrompt);
    return () => {
      void unlisten.then((off) => off());
    };
  }, [addAuthPrompt]);

  // A tab-close prompt open underneath would race this dialog for
  // Enter/Esc (both listen on window in the capture phase), so drop it.
  const openQuitPrompt = useCallback(() => {
    setClosePrompt(null);
    setQuitPromptOpen(true);
  }, [setClosePrompt]);

  // Closing the window (macOS ✕, the menubar Close button on Windows,
  // Alt+F4) must not silently drop live connections: hold the close and
  // confirm while any tab is still connecting or connected. Without the
  // preventDefault the listener itself destroys the window.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (!hasLiveSessions()) return;
      event.preventDefault();
      openQuitPrompt();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [openQuitPrompt]);

  // ⌘Q on macOS bypasses the window close path, so the Rust menu handler
  // forwards it here; with no live sessions just exit.
  useEffect(() => {
    const unlisten = api.onQuitRequested(() => {
      if (hasLiveSessions()) openQuitPrompt();
      else void exit(0);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [openQuitPrompt]);

  // --- actions --------------------------------------------------------------

  const newSession = useCallback(() => setDialog({ profile: null }), []);

  // Opening the box focuses it via its mount effect; when it is already
  // open that effect does not re-run, so refocus it explicitly.
  const openSearch = useCallback(() => {
    if (fileMode) return;
    if (searchOpen) searchRef.current?.focus();
    else setSearchOpen(true);
  }, [fileMode, searchOpen]);

  // Jump to the next match; with the search box closed this just opens it
  // so the user can type a query.
  const findNext = useCallback(() => {
    if (fileMode) return;
    if (!searchOpen) setSearchOpen(true);
    else searchRef.current?.findNext();
  }, [fileMode, searchOpen]);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // xterm keeps a hidden textarea for input, so "focus is in a text field"
      // has to exclude the terminal itself or every shortcut would be dead
      // exactly where it matters most.
      const target = event.target as HTMLElement | null;
      const inTerminal = Boolean(target?.closest(".xterm"));
      if (!inTerminal && target?.closest("input, textarea, select")) return;

      // The modifier scheme is platform-specific (⌘ on macOS, Alt elsewhere)
      // and lives in shortcuts.ts; only the dispatch happens here.
      const shortcut = matchAppShortcut(event);
      if (!shortcut) return;

      switch (shortcut.kind) {
        case "tabStep":
          event.preventDefault();
          activateAdjacentTab(shortcut.step);
          return;
        case "togglePanel":
          event.preventDefault();
          togglePanel(shortcut.panel);
          return;
        case "newSession":
          event.preventDefault();
          newSession();
          return;
        case "closeSession":
          event.preventDefault();
          if (activeId) requestCloseTab(activeId);
          return;
        case "find":
          event.preventDefault();
          openSearch();
          return;
        case "findNext":
          event.preventDefault();
          findNext();
          return;
        case "clear":
          if (activeId && !fileMode) {
            event.preventDefault();
            getController(activeId)?.clear();
          }
          return;
        case "revealCwd":
          if (activeId && !fileMode) {
            event.preventDefault();
            void revealCwdInFiler(activeId);
          }
          return;
        case "tab": {
          const tab = useStore
            .getState()
            .tabs.find((item) => item.number === shortcut.number);
          if (tab) {
            event.preventDefault();
            setActive(tab.info.id);
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activateAdjacentTab,
    activeId,
    findNext,
    fileMode,
    newSession,
    openSearch,
    requestCloseTab,
    setActive,
    togglePanel,
  ]);

  // --- layout ---------------------------------------------------------------

  // Session panel docks on the left, Filer on the right; FTP and SFTP tabs
  // bring their own dual-pane file manager, so the Filer stays hidden there.
  const showLeft = panels.sessions;
  const showRight = panels.filer && !fileMode;

  return (
    <div
      className="app"
      style={
        {
          "--panel-font-size": `${panelFontSize}px`,
          "--buffer-font-size": `${bufferFontSize}px`,
        } as CSSProperties
      }
    >
      <MenuBar
        onNewSession={newSession}
        onFind={openSearch}
        onFindNext={findNext}
        onFontSettings={() => setFontSettingsOpen(true)}
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
              <SessionPanel
                onNewSession={newSession}
                onEditProfile={(profile) => setDialog({ profile })}
              />
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
          <TabStrip />
          {searchOpen && (
            <SearchOverlay
              ref={searchRef}
              onClose={() => setSearchOpen(false)}
            />
          )}
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
              <FilerPanel />
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
        portable={updater.portable}
        state={updater.state}
        onDismiss={updater.dismiss}
        onInstall={() => void updater.installUpdate()}
        onCheckAgain={() => void updater.checkForUpdates()}
      />

      {dialog && (
        <Suspense fallback={null}>
          <SessionDialog
            initial={dialog.profile}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}

      {closingTab && (
        <CloseSessionDialog
          tab={closingTab}
          onConfirm={() => {
            // Dismiss first so a second Enter cannot re-enter closeTab while
            // the backend close is still in flight.
            setClosePrompt(null);
            void closeTab(closingTab.info.id);
          }}
          onCancel={() => setClosePrompt(null)}
        />
      )}

      {quitPromptOpen && (
        <QuitConfirmDialog
          onConfirm={() => {
            setQuitPromptOpen(false);
            void exit(0);
          }}
          onCancel={() => setQuitPromptOpen(false)}
        />
      )}

      {authPrompt && (
        <AuthPromptDialog
          key={authPrompt.id}
          prompt={authPrompt}
          onDone={() => clearAuthPrompt(authPrompt.id)}
        />
      )}

      {hostKeyPrompt && (
        <HostKeyDialog
          prompt={hostKeyPrompt}
          onAccept={() => acceptHostKey(hostKeyPrompt)}
          onCancel={() => setHostKeyPrompt(null)}
        />
      )}

      {fontSettingsOpen && (
        <FontSizeDialog
          panelFontSize={panelFontSize}
          bufferFontSize={bufferFontSize}
          terminalScrollback={terminalScrollback}
          onApply={(
            nextPanelFontSize,
            nextBufferFontSize,
            nextTerminalScrollback,
          ) => {
            setPanelFontSize(nextPanelFontSize);
            setBufferFontSize(nextBufferFontSize);
            setTerminalScrollback(nextTerminalScrollback);
            setFontSettingsOpen(false);
          }}
          onClose={() => setFontSettingsOpen(false)}
        />
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
                A small, fast terminal, SSH, SFTP, FTP and serial client. The
                installer is tiny, it starts instantly, and it stays out of
                your way.
              </span>
              <span style={{ color: "var(--fg-faint)" }}>
                Made by miskin ·{" "}
                <a
                  className="about-link"
                  href={REPO_URL}
                  onClick={(event) => {
                    event.preventDefault();
                    void openUrl(REPO_URL).catch((error) => {
                      console.error("Failed to open repository:", error);
                    });
                  }}
                >
                  github.com/miskin-lee/EdgeTerm
                </a>
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

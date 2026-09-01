import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { portableMode } from "./api";

const RELEASES_URL = "https://github.com/miskin-lee/EdgeTerm/releases/latest";

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | {
      phase: "available";
      currentVersion: string;
      version: string;
      body?: string;
      date?: string;
    }
  | {
      phase: "downloading";
      version: string;
      downloaded: number;
      total?: number;
    }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useUpdater() {
  const [appVersion, setAppVersion] = useState("");
  const [portable, setPortable] = useState(false);
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });
  const updateRef = useRef<Update | null>(null);
  const checkPromiseRef = useRef<Promise<void> | null>(null);
  const showCheckResultRef = useRef(false);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(console.error);
    void portableMode().then(setPortable).catch(console.error);
  }, []);

  const checkForUpdates = useCallback((showResult = true): Promise<void> => {
    if (showResult) {
      showCheckResultRef.current = true;
      setState({ phase: "checking" });
    }

    if (checkPromiseRef.current) return checkPromiseRef.current;

    const request = (async () => {
      try {
        const update = await check({ timeout: 20_000 });
        if (update) {
          if (updateRef.current) await updateRef.current.close();
          updateRef.current = update;
          setState({
            phase: "available",
            currentVersion: update.currentVersion,
            version: update.version,
            body: update.body,
            date: update.date,
          });
        } else if (showCheckResultRef.current) {
          setState({ phase: "up-to-date" });
        }
      } catch (error) {
        if (showCheckResultRef.current) {
          setState({ phase: "error", message: errorMessage(error) });
        } else {
          console.warn("Automatic update check failed", error);
        }
      } finally {
        showCheckResultRef.current = false;
        checkPromiseRef.current = null;
      }
    })();

    checkPromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  useEffect(
    () => () => {
      if (updateRef.current) void updateRef.current.close();
    },
    [],
  );

  const dismiss = useCallback(() => {
    if (state.phase === "downloading" || state.phase === "installing") return;
    const update = updateRef.current;
    updateRef.current = null;
    setState({ phase: "idle" });
    if (update) void update.close();
  }, [state.phase]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    if (portable) {
      // A portable copy must not run the NSIS installer the updater target
      // points at — that would silently turn it into an installed copy.
      try {
        await openUrl(RELEASES_URL);
      } catch (error) {
        setState({ phase: "error", message: errorMessage(error) });
        return;
      }
      updateRef.current = null;
      setState({ phase: "idle" });
      void update.close().catch(() => undefined);
      return;
    }

    let downloaded = 0;
    let total: number | undefined;
    let lastRenderedAt = 0;
    setState({
      phase: "downloading",
      version: update.version,
      downloaded,
      total,
    });

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        }

        const now = Date.now();
        if (event.event !== "Progress" || now - lastRenderedAt >= 80) {
          lastRenderedAt = now;
          setState({
            phase: "downloading",
            version: update.version,
            downloaded,
            total,
          });
        }
      });
      setState({ phase: "installing", version: update.version });
      await relaunch();
    } catch (error) {
      updateRef.current = null;
      await update.close().catch(() => undefined);
      setState({ phase: "error", message: errorMessage(error) });
    }
  }, [portable]);

  return {
    appVersion,
    portable,
    state,
    checkForUpdates,
    dismiss,
    installUpdate,
  };
}

import {
  ask,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";

import * as api from "./api";
import { useStore } from "./store";
import type { AppData } from "./types";

// Session → Export Data… / Import Data…: one `.edgeterm` file (plain JSON
// inside) holding the settings, saved sessions with their groups and Sender
// tags. Passwords and passphrases never leave `credentials.json`; the backend
// strips them on both sides, and the confirmation below says so, since
// imported sessions will ask again.

/** Mirrors `APP_DATA_EXTENSION` in model.rs; the backend enforces it too. */
export const DATA_FILE_EXTENSION = "edgeterm";
const FILE_FILTERS = [
  { name: "EdgeTerm data", extensions: [DATA_FILE_EXTENSION] },
];

const hasDataExtension = (path: string) =>
  path.toLowerCase().endsWith(`.${DATA_FILE_EXTENSION}`);

/**
 * Not every platform's save dialog appends the filter's extension to a typed
 * name; the export must carry it or the import side will refuse the file.
 */
const withDataExtension = (path: string) =>
  hasDataExtension(path) ? path : `${path}.${DATA_FILE_EXTENSION}`;

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const describe = (counts: {
  profiles: number;
  groups: number;
  senderCommands: number;
}) =>
  [
    plural(counts.profiles, "session"),
    plural(counts.groups, "group"),
    plural(counts.senderCommands, "Sender command"),
  ].join(", ");

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

const datestamp = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

export async function exportAppData(): Promise<void> {
  const { exportSettings, setStatus } = useStore.getState();
  try {
    const now = new Date();
    const picked = await saveDialog({
      title: "Export EdgeTerm Data",
      defaultPath: `EdgeTerm-${datestamp(now)}.${DATA_FILE_EXTENSION}`,
      filters: FILE_FILTERS,
    });
    if (!picked) return;
    const path = withDataExtension(picked);
    const summary = await api.exportAppData(
      path,
      exportSettings(),
      now.toISOString(),
    );
    setStatus(
      `Exported ${describe(summary)} and settings to ${basename(path)} (passwords are not included)`,
    );
  } catch (error) {
    setStatus(`Export failed: ${error}`);
  }
}

export async function importAppData(): Promise<void> {
  const store = useStore.getState();
  try {
    const picked = await openDialog({
      title: "Import EdgeTerm Data",
      multiple: false,
      directory: false,
      filters: FILE_FILTERS,
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    // The dialog filter already narrows the list, but "All files" and typed
    // paths get through on some platforms; say what was expected up front.
    if (!hasDataExtension(path)) {
      store.setStatus(
        `Import failed: “${basename(path)}” is not an EdgeTerm data file (expected .${DATA_FILE_EXTENSION})`,
      );
      return;
    }

    // Parse first so the confirmation can say exactly what is coming in.
    const data: AppData = await api.readAppData(path);
    const hasSettings = !!data.settings && typeof data.settings === "object";
    const summary = describe({
      profiles: data.profiles.length,
      groups: data.groups.length,
      senderCommands: data.senderCommands.length,
    });
    const confirmed = await ask(
      `Import ${summary}${hasSettings ? " and settings" : ""} from “${basename(path)}”?\n\n` +
        "Entries with the same id replace the local ones; nothing else is removed. " +
        "Data files never contain session passwords, so imported sessions will ask for theirs again.",
      {
        title: "Import Data",
        kind: "info",
        okLabel: "Import",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;

    const result = await api.importAppData(data);
    if (hasSettings) store.applySettings(data.settings);
    await store.loadProfiles();
    store.bumpSenderLibrary();
    let status = `Imported ${describe(result)}${hasSettings ? " and settings" : ""}`;
    if (result.skippedSenderCommands > 0) {
      status += `; skipped ${plural(result.skippedSenderCommands, "Sender command")} (library full)`;
    }
    store.setStatus(status);
  } catch (error) {
    store.setStatus(`Import failed: ${error}`);
  }
}

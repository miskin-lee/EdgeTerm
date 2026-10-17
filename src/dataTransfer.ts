
import * as api from "./api";
import { t } from "./i18n";
import { ask, open as openDialog, save as saveDialog } from "./nativeDialog";
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

/** "2 sessions, 1 group, 3 Sender commands" — each part localized, "" dropped. */
const describe = (counts: {
  profiles: number;
  groups: number;
  senderCommands: number;
}) => {
  const count = (n: number, one: string, many: string) =>
    n === 1 ? t(one) : t(many, { count: n });
  return [
    count(counts.profiles, "1 session", "{count} sessions"),
    counts.groups
      ? count(counts.groups, "1 group", "{count} groups")
      : null,
    counts.senderCommands
      ? count(
          counts.senderCommands,
          "1 Sender command",
          "{count} Sender commands",
        )
      : null,
  ]
    .filter((part) => part !== null)
    .join(t(", "));
};

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
      title: t("Export EdgeTerm Data"),
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
      t(
        "Exported {summary} and settings to {path} (passwords are not included)",
        { summary: describe(summary), path: basename(path) },
      ),
    );
  } catch (error) {
    setStatus(t("Export failed: {error}", { error: String(error) }));
  }
}

export async function importAppData(): Promise<void> {
  const store = useStore.getState();
  try {
    const picked = await openDialog({
      title: t("Import EdgeTerm Data"),
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
        t(
          "Import failed: “{path}” is not an EdgeTerm data file (expected .{extension})",
          { path: basename(path), extension: DATA_FILE_EXTENSION },
        ),
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
      t(
        "Import {summary}{settings} from “{path}”?\n\nEntries with the same id replace the local ones; nothing else is removed. Data files never contain session passwords, so imported sessions will ask for theirs again.",
        {
          summary,
          settings: hasSettings ? t(" and settings") : "",
          path: basename(path),
        },
      ),
      {
        title: t("Import Data"),
        kind: "info",
        okLabel: t("Import"),
        cancelLabel: t("Cancel"),
      },
    );
    if (!confirmed) return;

    const result = await api.importAppData(data);
    if (hasSettings) store.applySettings(data.settings);
    await store.loadProfiles();
    store.bumpSenderLibrary();
    let status = t("Imported {summary}{settings}", {
      summary: describe(result),
      settings: hasSettings ? t(" and settings") : "",
    });
    if (result.skippedSenderCommands > 0) {
      status += t("; skipped {summary} (library full)", {
        summary:
          result.skippedSenderCommands === 1
            ? t("1 Sender command")
            : t("{count} Sender commands", {
                count: result.skippedSenderCommands,
              }),
      });
    }
    store.setStatus(status);
  } catch (error) {
    store.setStatus(t("Import failed: {error}", { error: String(error) }));
  }
}

/**
 * Session → Import OpenSSH Config…: picks a client configuration (the file
 * dialog starts at ~/.ssh/config), parses it and opens the chooser; the
 * import itself happens in `SshConfigImportDialog`.
 */
export async function importSshConfig(): Promise<void> {
  const store = useStore.getState();
  try {
    const defaultPath = await api.defaultSshConfigPath();
    const picked = await openDialog({
      title: t("Import OpenSSH Config"),
      multiple: false,
      directory: false,
      defaultPath,
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    const preview = await api.readSshConfig(path);
    if (preview.entries.length === 0) {
      store.setStatus(
        t("No Host entries found in {path}", { path: basename(path) }),
      );
      return;
    }
    store.setSshConfigImport(preview);
  } catch (error) {
    store.setStatus(t("Import failed: {error}", { error: String(error) }));
  }
}

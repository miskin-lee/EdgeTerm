import { useEffect, useMemo, useRef, useState } from "react";

import * as api from "../api";
import { t, tf } from "../i18n";
import { groupPath } from "../sessionGroups";
import { useStore } from "../store";
import type { SshConfigEntry, SshConfigPreview } from "../types";
import { endDialogAttention, requestDialogAttention } from "./dialogAttention";
import { Icon } from "./icons";

interface Props {
  preview: SshConfigPreview;
  onClose: () => void;
}

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

/** `user@host`, with the port when it is not the default. */
const target = (entry: SshConfigEntry) =>
  `${entry.username}@${entry.host}${entry.port === 22 ? "" : `:${entry.port}`}`;

function authLabel(entry: SshConfigEntry): string {
  if (entry.auth === "publicKey" && entry.privateKeyPath) {
    return tf("key {file}", { file: basename(entry.privateKeyPath) });
  }
  return entry.auth === "agent" ? t("agent") : t("password");
}

/**
 * Chooser for Session → Import OpenSSH Config…: the `Host` aliases of the
 * picked file, each with what `ssh alias` would connect to. Aliases the
 * store already knows start unchecked, since importing one rewrites the
 * saved session's target from the file. Like every dialog holding choices
 * it only closes through its buttons; a click outside makes it blink.
 */
export function SshConfigImportDialog({ preview, onClose }: Props) {
  const groups = useStore((s) => s.groups);
  const loadProfiles = useStore((s) => s.loadProfiles);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        preview.entries
          .filter((entry) => !entry.existingId)
          .map((entry) => entry.alias),
      ),
  );
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sshGroups = useMemo(
    () =>
      groups
        .filter((group) => group.kind === "ssh")
        .map((group) => ({
          id: group.id,
          label: groupPath(groups, group.id).join(" / "),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [groups],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const toggle = (alias: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  const allSelected = selected.size === preview.entries.length;
  const toggleAll = () =>
    setSelected(
      allSelected
        ? new Set()
        : new Set(preview.entries.map((entry) => entry.alias)),
    );

  const submit = async () => {
    if (selected.size === 0) {
      setError(t("Choose at least one host."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const aliases = preview.entries
        .filter((entry) => selected.has(entry.alias))
        .map((entry) => entry.alias);
      await api.importSshConfig(preview.path, aliases, groupId || null);
      await loadProfiles();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={() => requestDialogAttention(dialogRef.current)}
    >
      <div
        ref={dialogRef}
        className="dialog ssh-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-import-title"
        onMouseDown={(event) => event.stopPropagation()}
        onAnimationEnd={endDialogAttention}
      >
        <div className="dialog-header">
          <span id="ssh-import-title">{t("Import OpenSSH Config")}</span>
          <button
            className="panel-action"
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body ssh-import-body">
          <span className="confirm-dialog-target">{preview.path}</span>
          <div className="ssh-import-list" role="group" aria-label={t("Hosts")}>
            <label className="ssh-import-row is-head">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={t("Select all hosts")}
              />
              <span className="ssh-import-alias">{t("Host")}</span>
              <span className="ssh-import-target">{t("Connects to")}</span>
              <span className="ssh-import-note">{t("Auth")}</span>
            </label>
            {preview.entries.map((entry) => (
              <label
                key={entry.alias}
                className={`ssh-import-row${entry.existingId ? " is-existing" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.alias)}
                  onChange={() => toggle(entry.alias)}
                />
                <span className="ssh-import-alias" title={entry.alias}>
                  {entry.alias}
                </span>
                <span className="ssh-import-target" title={target(entry)}>
                  {target(entry)}
                  {entry.jumps.length === 1 && (
                    <span className="ssh-import-via">
                      {" "}
                      {tf("via {jump}", { jump: entry.jumps[0] })}
                    </span>
                  )}
                  {entry.jumps.length > 1 && (
                    <span className="ssh-import-via">
                      {" "}
                      {tf("via {jumps} (multi-hop, not imported)", {
                        jumps: entry.jumps.join(", "),
                      })}
                    </span>
                  )}
                </span>
                <span className="ssh-import-note">
                  <span title={entry.privateKeyPath ?? undefined}>
                    {authLabel(entry)}
                  </span>
                  {entry.existingId && (
                    <span className="ssh-import-existing">
                      {tf("updates “{name}”", {
                        name: entry.existingName ?? "",
                      })}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <label className="ssh-import-group">
            <span>{t("Add new sessions to")}</span>
            <span className="select-wrap">
              <select
                className="select"
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                <option value="">{t("SSH Sessions (no group)")}</option>
                {sshGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" className="select-chevron" />
            </span>
          </label>
          <span className="confirm-dialog-hint">
            {t(
              "Hosts already saved start unchecked; checking one updates that " +
                "session’s host, port and user from the file. A single jump host " +
                "comes along; a multi-hop ProxyJump is not imported. Passwords are " +
                "never in the file, so imported sessions ask for theirs.",
            )}
          </span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            {tf("{selected} of {total} selected", {
              selected: selected.size,
              total: preview.entries.length,
            })}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn is-primary"
            disabled={busy || selected.size === 0}
            onClick={() => void submit()}
          >
            {t("Import")}
          </button>
        </div>
      </div>
    </div>
  );
}

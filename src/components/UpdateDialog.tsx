import { useT } from "../i18n";
import type { UpdaterState } from "../updater";

interface Props {
  appVersion: string;
  portable: boolean;
  state: UpdaterState;
  onDismiss: () => void;
  onInstall: () => void;
  onCheckAgain: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function UpdateDialog({
  appVersion,
  portable,
  state,
  onDismiss,
  onInstall,
  onCheckAgain,
}: Props) {
  const t = useT();
  if (state.phase === "idle") return null;

  const busy = state.phase === "checking" || state.phase === "downloading";
  const dismissible = state.phase !== "downloading" && state.phase !== "installing";
  const progress =
    state.phase === "downloading" && state.total && state.total > 0
      ? Math.min(100, (state.downloaded / state.total) * 100)
      : undefined;

  let title = t("Software Update");
  if (state.phase === "available") title = t("Update Available");
  if (state.phase === "up-to-date") title = t("EdgeTerm Is Up to Date");
  if (state.phase === "error") title = t("Update Failed");

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={() => dismissible && onDismiss()}
    >
      <div
        className="dialog update-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">{title}</div>
        <div className="dialog-body update-dialog-body">
          {state.phase === "checking" && (
            <>
              <div className="update-spinner" aria-hidden="true" />
              <span>
                {t("Checking GitHub Releases for the latest version…")}
              </span>
            </>
          )}

          {state.phase === "up-to-date" && (
            <span>
              {t("You already have the latest version{version}.", {
                version: appVersion ? ` (${appVersion})` : "",
              })}
            </span>
          )}

          {state.phase === "available" && (
            <>
              <div className="update-version-row">
                <span>
                  {t("Installed: {version}", { version: state.currentVersion })}
                </span>
                <span aria-hidden="true">→</span>
                <strong>{t("Latest: {version}", { version: state.version })}</strong>
              </div>
              {state.body && (
                <div className="update-notes" aria-label={t("Release notes")}>
                  {state.body}
                </div>
              )}
              <span className="update-hint">
                {portable
                  ? t(
                      "This is a portable copy, so the update is not installed in place. The download page opens in your browser; replace this copy with the new portable archive.",
                    )
                  : t(
                      "EdgeTerm will download the signed update, install it, and restart. Active terminal connections will be closed.",
                    )}
              </span>
            </>
          )}

          {state.phase === "downloading" && (
            <>
              <strong>
                {t("Downloading EdgeTerm {version}…", {
                  version: state.version,
                })}
              </strong>
              <progress
                className="update-progress"
                value={progress}
                max={100}
              />
              <span className="update-hint">
                {state.total
                  ? t("{downloaded} of {total}", {
                      downloaded: formatBytes(state.downloaded),
                      total: formatBytes(state.total),
                    })
                  : t("{downloaded} downloaded", {
                      downloaded: formatBytes(state.downloaded),
                    })}
              </span>
            </>
          )}

          {state.phase === "installing" && (
            <>
              <div className="update-spinner" aria-hidden="true" />
              <span>
                {t("Installing EdgeTerm {version} and restarting…", {
                  version: state.version,
                })}
              </span>
            </>
          )}

          {state.phase === "error" && (
            <div className="dialog-error">{state.message}</div>
          )}
        </div>

        {!busy && state.phase !== "installing" && (
          <div className="dialog-footer">
            {state.phase === "error" && (
              <button className="btn" onClick={onCheckAgain}>
                {t("Try Again")}
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn" onClick={onDismiss}>
                {t("Later")}
              </button>
            )}
            {state.phase !== "available" && (
              <button className="btn" onClick={onDismiss}>
                {t("Close")}
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn is-primary" onClick={onInstall}>
                {portable ? t("Open Download Page") : t("Download and Install")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

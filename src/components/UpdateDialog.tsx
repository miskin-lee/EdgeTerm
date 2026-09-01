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
  if (state.phase === "idle") return null;

  const busy = state.phase === "checking" || state.phase === "downloading";
  const dismissible = state.phase !== "downloading" && state.phase !== "installing";
  const progress =
    state.phase === "downloading" && state.total && state.total > 0
      ? Math.min(100, (state.downloaded / state.total) * 100)
      : undefined;

  let title = "Software Update";
  if (state.phase === "available") title = "Update Available";
  if (state.phase === "up-to-date") title = "EdgeTerm Is Up to Date";
  if (state.phase === "error") title = "Update Failed";

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
              <span>Checking GitHub Releases for the latest version…</span>
            </>
          )}

          {state.phase === "up-to-date" && (
            <span>
              You already have the latest version
              {appVersion ? ` (${appVersion})` : ""}.
            </span>
          )}

          {state.phase === "available" && (
            <>
              <div className="update-version-row">
                <span>Installed: {state.currentVersion}</span>
                <span aria-hidden="true">→</span>
                <strong>Latest: {state.version}</strong>
              </div>
              {state.body && (
                <div className="update-notes" aria-label="Release notes">
                  {state.body}
                </div>
              )}
              <span className="update-hint">
                {portable
                  ? "This is a portable copy, so the update is not installed " +
                    "in place. The download page opens in your browser; " +
                    "replace this copy with the new portable archive."
                  : "EdgeTerm will download the signed update, install it, " +
                    "and restart. Active terminal connections will be closed."}
              </span>
            </>
          )}

          {state.phase === "downloading" && (
            <>
              <strong>Downloading EdgeTerm {state.version}…</strong>
              <progress
                className="update-progress"
                value={progress}
                max={100}
              />
              <span className="update-hint">
                {formatBytes(state.downloaded)}
                {state.total ? ` of ${formatBytes(state.total)}` : " downloaded"}
              </span>
            </>
          )}

          {state.phase === "installing" && (
            <>
              <div className="update-spinner" aria-hidden="true" />
              <span>
                Installing EdgeTerm {state.version} and restarting…
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
                Try Again
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn" onClick={onDismiss}>
                Later
              </button>
            )}
            {state.phase !== "available" && (
              <button className="btn" onClick={onDismiss}>
                Close
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn is-primary" onClick={onInstall}>
                {portable ? "Open Download Page" : "Download and Install"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

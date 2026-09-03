// The chrome's icons are Codicons, VS Code's own set (Microsoft, CC BY 4.0;
// https://github.com/microsoft/vscode-codicons), inlined from the package's
// SVG sources: a 16px pixel grid with 1px strokes, so they stay crisp at the
// size they were drawn for and take `currentColor`. Render them at 16px —
// scaling loses the pixel alignment that makes them read so cleanly. The
// Filer's file-type icons are a separate set (`FileIcon`).
import add from "@vscode/codicons/src/icons/add.svg?raw";
import arrowDown from "@vscode/codicons/src/icons/arrow-down.svg?raw";
import arrowUp from "@vscode/codicons/src/icons/arrow-up.svg?raw";
import check from "@vscode/codicons/src/icons/check.svg?raw";
import chevronDown from "@vscode/codicons/src/icons/chevron-down.svg?raw";
import chevronLeft from "@vscode/codicons/src/icons/chevron-left.svg?raw";
import chevronRight from "@vscode/codicons/src/icons/chevron-right.svg?raw";
import circuitBoard from "@vscode/codicons/src/icons/circuit-board.svg?raw";
import clearAll from "@vscode/codicons/src/icons/clear-all.svg?raw";
import clippy from "@vscode/codicons/src/icons/clippy.svg?raw";
import close from "@vscode/codicons/src/icons/close.svg?raw";
import cloudDownload from "@vscode/codicons/src/icons/cloud-download.svg?raw";
import cloudUpload from "@vscode/codicons/src/icons/cloud-upload.svg?raw";
import copy from "@vscode/codicons/src/icons/copy.svg?raw";
import edit from "@vscode/codicons/src/icons/edit.svg?raw";
import error from "@vscode/codicons/src/icons/error.svg?raw";
import folder from "@vscode/codicons/src/icons/folder.svg?raw";
import folderOpened from "@vscode/codicons/src/icons/folder-opened.svg?raw";
import goToFile from "@vscode/codicons/src/icons/go-to-file.svg?raw";
import home from "@vscode/codicons/src/icons/home.svg?raw";
import info from "@vscode/codicons/src/icons/info.svg?raw";
import linkExternal from "@vscode/codicons/src/icons/link-external.svg?raw";
import listSelection from "@vscode/codicons/src/icons/list-selection.svg?raw";
import move from "@vscode/codicons/src/icons/move.svg?raw";
import newFile from "@vscode/codicons/src/icons/new-file.svg?raw";
import newFolder from "@vscode/codicons/src/icons/new-folder.svg?raw";
import newline from "@vscode/codicons/src/icons/newline.svg?raw";
import plug from "@vscode/codicons/src/icons/plug.svg?raw";
import refresh from "@vscode/codicons/src/icons/refresh.svg?raw";
import rename from "@vscode/codicons/src/icons/rename.svg?raw";
import runCompact from "@vscode/codicons/src/icons/run-compact.svg?raw";
import save from "@vscode/codicons/src/icons/save.svg?raw";
import search from "@vscode/codicons/src/icons/search.svg?raw";
import send from "@vscode/codicons/src/icons/send.svg?raw";
import server from "@vscode/codicons/src/icons/server.svg?raw";
import tag from "@vscode/codicons/src/icons/tag.svg?raw";
import target from "@vscode/codicons/src/icons/target.svg?raw";
import terminal from "@vscode/codicons/src/icons/terminal.svg?raw";
import trash from "@vscode/codicons/src/icons/trash.svg?raw";
import warning from "@vscode/codicons/src/icons/warning.svg?raw";

/** Keyed by the codicon's own name. */
const SVGS = {
  add,
  "arrow-down": arrowDown,
  "arrow-up": arrowUp,
  check,
  "chevron-down": chevronDown,
  "chevron-left": chevronLeft,
  "chevron-right": chevronRight,
  "circuit-board": circuitBoard,
  "clear-all": clearAll,
  clippy,
  close,
  "cloud-download": cloudDownload,
  "cloud-upload": cloudUpload,
  copy,
  edit,
  error,
  folder,
  "folder-opened": folderOpened,
  "go-to-file": goToFile,
  home,
  info,
  "link-external": linkExternal,
  "list-selection": listSelection,
  move,
  "new-file": newFile,
  "new-folder": newFolder,
  newline,
  plug,
  refresh,
  rename,
  "run-compact": runCompact,
  save,
  search,
  send,
  server,
  tag,
  target,
  terminal,
  trash,
  warning,
} satisfies Record<string, string>;

export type IconName = keyof typeof SVGS;

interface Props {
  name: IconName;
  className?: string;
}

export function Icon({ name, className }: Props) {
  return (
    <span
      className={className ? `icon ${className}` : "icon"}
      aria-hidden="true"
      // Static SVG markup bundled from the package; nothing user-controlled.
      dangerouslySetInnerHTML={{ __html: SVGS[name] }}
    />
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../../api";
import {
  loadSaveLevel,
  sameScope,
  scopeChain,
  scopeForLevel,
  scopeKey,
  scopeLabel,
  storeSaveLevel,
  type ScopeLevel,
} from "../../senderScope";
import { byName } from "../../sessionGroups";
import { useStore } from "../../store";
import { getController } from "../../terminalRegistry";
import {
  isFileSession,
  type CommandScope,
  type LineEnding,
  type SavedCommand,
  type SenderFormat,
} from "../../types";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Icon } from "../icons";

type Target = "current" | "all";
type CommandContextMenu = {
  commandId: string;
  x: number;
  y: number;
};
type CommandTooltip = {
  text: string;
  details: string;
  x: number;
  y: number;
};
/** What the inputs held before Edit replaced them, restored on Cancel. */
type Draft = {
  text: string;
  tagName: string;
  format: SenderFormat;
  ending: LineEnding;
};
/** The scope picker hanging off the Save / Update button. */
type SavePicker = {
  x: number;
  y: number;
};
type Editing = {
  command: SavedCommand;
  draft: Draft;
};

const MAX_SAVED_COMMANDS = 1000;
const COMMANDS_PER_PAGE = 24;
const LINE_ENDINGS: [LineEnding, string][] = [
  ["none", "None"],
  ["lf", "LF (\\n)"],
  ["crlf", "CRLF (\\r\\n)"],
];

export function SenderPanel() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const setStatus = useStore((s) => s.setStatus);
  const libraryVersion = useStore((s) => s.senderLibraryVersion);

  const [text, setText] = useState("");
  const [tagName, setTagName] = useState("");
  const [ending, setEnding] = useState<LineEnding>("lf");
  const [savedCommands, setSavedCommands] = useState<SavedCommand[]>([]);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CommandContextMenu | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [commandTooltip, setCommandTooltip] = useState<CommandTooltip | null>(null);
  const [page, setPage] = useState(1);
  const [format, setFormat] = useState<SenderFormat>("text");
  const [target, setTarget] = useState<Target>("current");
  const [running, setRunning] = useState(false);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [libraryBusy, setLibraryBusy] = useState(false);
  // Save / Update open a picker for the scope; the last choice's level is
  // preselected in it.
  const [savePicker, setSavePicker] = useState<SavePicker | null>(null);
  const [saveLevel, setSaveLevel] = useState<ScopeLevel>(loadSaveLevel);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Loads the library on mount and again after it changed outside this
  // panel (a data import, a deleted profile or group); an edit in progress
  // would then update stale contents, so it is dropped.
  useEffect(() => {
    let cancelled = false;
    setCommandsLoading(true);
    void api
      .listSenderCommands()
      .then((commands) => {
        if (cancelled) return;
        setSavedCommands(commands);
        setEditing(null);
      })
      .catch((error) => {
        if (!cancelled) setStatus(`Sender: failed to load saved commands: ${error}`);
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setStatus, libraryVersion]);

  useEffect(() => () => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const closeSavePicker = useCallback(() => setSavePicker(null), []);

  const activeTab = tabs.find((tab) => tab.info.id === activeId);
  const chain = useMemo(
    () => scopeChain(activeTab, profiles, groups),
    [activeTab, profiles, groups],
  );
  const labelOf = (scope: CommandScope) => scopeLabel(scope, profiles, groups);

  // Commands the active tab sees, in one alphabetical list regardless of
  // scope; the tooltip names each tag's scope.
  const visibleCommands = useMemo(() => {
    const keys = new Set(chain.map(scopeKey));
    return savedCommands
      .filter((command) => keys.has(scopeKey(command.scope)))
      .sort(byName);
  }, [chain, savedCommands]);

  const pageCount = Math.max(
    1,
    Math.ceil(visibleCommands.length / COMMANDS_PER_PAGE),
  );
  // Switching tabs can shrink the list under the current page.
  const currentPage = Math.min(page, pageCount);
  const pageCommands = visibleCommands.slice(
    (currentPage - 1) * COMMANDS_PER_PAGE,
    currentPage * COMMANDS_PER_PAGE,
  );

  const hideCommandTooltip = () => {
    if (tooltipTimer.current) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setCommandTooltip(null);
  };

  const showCommandTooltip = (
    command: SavedCommand,
    element: HTMLElement,
  ) => {
    hideCommandTooltip();
    const rect = element.getBoundingClientRect();
    tooltipTimer.current = setTimeout(() => {
      setCommandTooltip({
        // Format and line ending are in the Edit view; the tooltip answers
        // "what does this send, and where is it listed".
        text: command.text,
        details: labelOf(command.scope),
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 428)),
        y: rect.top - 8,
      });
      tooltipTimer.current = null;
    }, 200);
  };

  const targets = (): string[] => {
    if (target === "all") {
      return tabs
        .filter((tab) => !isFileSession(tab.info.kind))
        .map((tab) => tab.info.id);
    }
    return tabs.some(
      (tab) => tab.info.id === activeId && !isFileSession(tab.info.kind),
    ) && activeId
      ? [activeId]
      : [];
  };

  /**
   * Save and Update both go through the picker: it checks the input first
   * so an empty command is reported instead of asking where to file it.
   */
  const openSavePicker = () => {
    if (commandsLoading || libraryBusy) return;
    if (text.length === 0) {
      setStatus(
        editing
          ? "Sender: enter a command before updating"
          : "Sender: enter a command before saving",
      );
      return;
    }
    if (!editing && savedCommands.length >= MAX_SAVED_COMMANDS) {
      setStatus(`Sender: saved command limit is ${MAX_SAVED_COMMANDS}`);
      return;
    }
    const rect = saveButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSavePicker({ x: rect.right, y: rect.bottom + 2 });
  };

  const pickSaveScope = (scope: CommandScope) => {
    setSaveLevel(scope.type);
    storeSaveLevel(scope.type);
    if (editing) void updateCommand(scope);
    else void saveCommand(scope);
  };

  const saveCommand = async (scope: CommandScope) => {
    if (commandsLoading || libraryBusy) return;
    if (text.length === 0) {
      setStatus("Sender: enter a command before saving");
      return;
    }
    if (savedCommands.length >= MAX_SAVED_COMMANDS) {
      setStatus(`Sender: saved command limit is ${MAX_SAVED_COMMANDS}`);
      return;
    }

    const newCommand: SavedCommand = {
      id: "",
      name: tagName.trim() || text,
      text,
      format,
      ending,
      scope,
    };
    const nextLength = savedCommands.length + 1;
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand(newCommand);
      setSavedCommands((current) => [...current, saved]);
      setSelectedCommandId(saved.id);
      setTagName("");
      setStatus(
        `Sender: saved command ${nextLength}/${MAX_SAVED_COMMANDS} (${labelOf(saved.scope)})`,
      );
    } catch (error) {
      setStatus(`Sender: failed to save command: ${error}`);
    } finally {
      setLibraryBusy(false);
    }
  };

  const replaceSaved = (saved: SavedCommand) =>
    setSavedCommands((current) =>
      current.map((candidate) =>
        candidate.id === saved.id ? saved : candidate,
      ),
    );

  /** Saves `command` with `patch` applied, keeping an open edit in step. */
  const updateSaved = async (
    command: SavedCommand,
    patch: Partial<Pick<SavedCommand, "ending" | "scope">>,
  ) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand({ ...command, ...patch });
      replaceSaved(saved);
      setEditing((current) =>
        current?.command.id === saved.id
          ? { ...current, command: saved }
          : current,
      );
      if (editing?.command.id === saved.id) setEnding(saved.ending);
    } catch (error) {
      setStatus(`Sender: failed to update command: ${error}`);
    } finally {
      setLibraryBusy(false);
    }
  };

  /** Loads a saved tag into the inputs; Save becomes Update until done. */
  const beginEdit = (command: SavedCommand) => {
    if (libraryBusy) return;
    // The first Edit remembers whatever was typed; switching tags mid-edit
    // keeps that original draft so Cancel still restores it.
    const draft = editing?.draft ?? { text, tagName, format, ending };
    setEditing({ command, draft });
    setSelectedCommandId(command.id);
    setText(command.text);
    setTagName(command.name === command.text ? "" : command.name);
    setFormat(command.format);
    setEnding(command.ending);
  };

  const cancelEdit = () => {
    if (!editing) return;
    const { draft } = editing;
    setEditing(null);
    setText(draft.text);
    setTagName(draft.tagName);
    setFormat(draft.format);
    setEnding(draft.ending);
  };

  const updateCommand = async (scope: CommandScope) => {
    if (!editing || libraryBusy) return;
    if (text.length === 0) {
      setStatus("Sender: enter a command before updating");
      return;
    }
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand({
        ...editing.command,
        name: tagName.trim() || text,
        text,
        format,
        ending,
        scope,
      });
      replaceSaved(saved);
      setSelectedCommandId(saved.id);
      setEditing(null);
      setTagName("");
      setStatus(`Sender: updated saved command (${labelOf(saved.scope)})`);
    } catch (error) {
      setStatus(`Sender: failed to update command: ${error}`);
    } finally {
      setLibraryBusy(false);
    }
  };

  const removeCommand = async (id: string) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    try {
      await api.deleteSenderCommand(id);
      setSavedCommands((current) =>
        current.filter((command) => command.id !== id),
      );
      if (selectedCommandId === id) setSelectedCommandId(null);
      if (contextMenu?.commandId === id) setContextMenu(null);
      if (editing?.command.id === id) cancelEdit();
    } catch (error) {
      setStatus(`Sender: failed to delete command: ${error}`);
    } finally {
      setLibraryBusy(false);
    }
  };

  const sendCommand = async (
    commandText: string,
    commandFormat: SenderFormat,
    commandEnding: LineEnding,
  ) => {
    if (running) return;
    const targetIds = targets();
    if (targetIds.length === 0) {
      setStatus("Sender: no session selected");
      return;
    }
    const ids = targetIds.filter(
      (id) => !getController(id)?.isTransferActive(),
    );
    if (ids.length === 0) {
      setStatus("Sender: blocked while a file transfer is running");
      return;
    }

    let units: (string | Uint8Array)[];
    try {
      units = buildUnits(commandText, commandFormat, commandEnding);
    } catch (e) {
      setStatus(`Sender: ${e}`);
      return;
    }
    if (units.length === 0) return;

    setRunning(true);

    try {
      const unit = units[0];
      await Promise.all(
        ids.map(async (id) => {
          const controller = getController(id);
          const tracked =
            commandEnding !== "none" && controller?.noteCommandSent() === true;
          try {
            if (typeof unit === "string") await api.writeSession(id, unit);
            else await api.writeSessionBinary(id, api.bytesToBase64(unit));
          } catch (error) {
            if (tracked) controller.cancelCommandSent();
            throw error;
          }
        }),
      );
      setStatus(
        ids.length === targetIds.length
          ? "Sender: sent command"
          : `Sender: sent command; skipped ${targetIds.length - ids.length} session(s) with a file transfer running`,
      );
    } catch (e) {
      setStatus(`Sender: ${e}`);
    } finally {
      setRunning(false);
    }
  };

  const emptyMessage = commandsLoading
    ? "Loading saved commands…"
    : savedCommands.length === 0
      ? "Save a command to add it here."
      : "No saved commands apply to this session; they are listed under the sessions, groups or kinds they were saved to.";

  return (
    <>
      <div className="panel-header sender-header">
        <div className="panel-title is-sender">
          <Icon name="send" />
          Sender
        </div>
        <div className="sender-options">
          <div className="segmented" role="radiogroup" aria-label="Format">
            <button
              type="button"
              role="radio"
              aria-checked={format === "text"}
              className={format === "text" ? "is-active" : ""}
              onClick={() => setFormat("text")}
            >
              Text
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={format === "hex"}
              className={format === "hex" ? "is-active" : ""}
              onClick={() => setFormat("hex")}
            >
              Hex
            </button>
          </div>

          <label className="sender-field">
            <span>Ending</span>
            <span className="select-wrap">
              <select
                className="select"
                value={ending}
                onChange={(event) =>
                  setEnding(event.target.value as LineEnding)
                }
              >
                <option value="none">None</option>
                <option value="lf">LF (\n)</option>
                <option value="crlf">CRLF (\r\n)</option>
              </select>
              <Icon name="chevron-down" className="select-chevron" />
            </span>
          </label>

          <label className="sender-field">
            <span>Targets</span>
            <span className="select-wrap">
              <select
                className="select"
                value={target}
                onChange={(event) => setTarget(event.target.value as Target)}
              >
                <option value="current">Current Session</option>
                <option value="all">All Sessions ({tabs.length})</option>
              </select>
              <Icon name="chevron-down" className="select-chevron" />
            </span>
          </label>
        </div>
      </div>

      <div className="sender-compose">
        <div className="sender-command">
          <input
            className="sender-command-input"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            placeholder={
              format === "hex"
                ? "48 65 6C 6C 6F   (hex bytes)"
                : `Type a command (${endingLabel(ending)})`
            }
            onChange={(event) => {
              if (!editing) setSelectedCommandId(null);
              setText(event.target.value.replace(/[\r\n]+/g, ""));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void sendCommand(text, format, ending);
              } else if (event.key === "Escape" && editing) {
                event.preventDefault();
                cancelEdit();
              }
            }}
          />
          {text.length > 0 && (
            <button
              type="button"
              className="sender-clear"
              onClick={() => setText("")}
              title="Clear"
              aria-label="Clear command"
            >
              <Icon name="close" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="sender-send"
          onClick={() => void sendCommand(text, format, ending)}
          disabled={running}
          title="Run command (Enter)"
          aria-label="Run command"
        >
          <Icon name="run-compact" />
        </button>
        <div className="sender-compose-divider" aria-hidden="true" />
        <input
          className="sender-label-input"
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={80}
          value={tagName}
          placeholder="Tag name (optional)"
          aria-label="Saved command tag name"
          onChange={(event) =>
            setTagName(event.target.value.replace(/[\r\n]+/g, ""))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              openSavePicker();
            } else if (event.key === "Escape" && editing) {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
        {editing ? (
          <>
            <button
              className="sender-save-btn"
              type="button"
              ref={saveButtonRef}
              disabled={libraryBusy || text.length === 0}
              title={`Update "${editing.command.name}" — asks where to list it`}
              aria-haspopup="menu"
              aria-expanded={savePicker !== null}
              onClick={openSavePicker}
            >
              Update
            </button>
            <button
              className="sender-save-btn is-secondary"
              type="button"
              disabled={libraryBusy}
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="sender-save-btn"
            type="button"
            ref={saveButtonRef}
            disabled={
              commandsLoading ||
              libraryBusy ||
              text.length === 0 ||
              savedCommands.length >= MAX_SAVED_COMMANDS
            }
            title="Save the command — asks where to list it"
            aria-haspopup="menu"
            aria-expanded={savePicker !== null}
            onClick={openSavePicker}
          >
            Save
          </button>
        )}
      </div>

      {savePicker && (() => {
        // Broadest first, like every scope list. The check marks the current
        // scope of the tag being edited, or the level picked last time.
        const preselected = editing
          ? editing.command.scope
          : scopeForLevel(chain, saveLevel);
        const items: MenuItem[] = [
          { heading: editing ? "Update and list under" : "Save and list under" },
          ...chain.map((scope) => ({
            label: labelOf(scope),
            checked: sameScope(scope, preselected),
            mark: "radio" as const,
            action: () => pickSaveScope(scope),
          })),
        ];
        return (
          <ContextMenu
            x={savePicker.x}
            y={savePicker.y}
            align="right"
            items={items}
            onClose={closeSavePicker}
          />
        );
      })()}

      <div className="sender-library">
        {pageCount > 1 && (
          <div className="sender-library-head">
            <span>{visibleCommands.length} saved commands</span>
            <div className="sender-pagination">
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
                title="Previous page"
                aria-label="Previous page"
              >
                <Icon name="chevron-left" />
              </button>
              <span>
                {currentPage} / {pageCount}
              </span>
              <button
                type="button"
                disabled={currentPage === pageCount}
                onClick={() => setPage(currentPage + 1)}
                title="Next page"
                aria-label="Next page"
              >
                <Icon name="chevron-right" />
              </button>
            </div>
          </div>
        )}

        {pageCommands.length === 0 ? (
          <div className="sender-library-empty">{emptyMessage}</div>
        ) : (
          <div className="sender-command-tags">
            {pageCommands.map((command) => (
              <div
                className={[
                  "sender-command-tag",
                  selectedCommandId === command.id ? "is-selected" : "",
                  editing?.command.id === command.id ? "is-editing" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={command.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  hideCommandTooltip();
                  setSelectedCommandId(command.id);
                  setContextMenu({
                    commandId: command.id,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <button
                  className="sender-command-load"
                  type="button"
                  aria-label={`Send ${command.name}: ${command.text}`}
                  disabled={running}
                  onMouseEnter={(event) =>
                    showCommandTooltip(command, event.currentTarget)
                  }
                  onMouseLeave={hideCommandTooltip}
                  onClick={() => {
                    setSelectedCommandId(command.id);
                    void sendCommand(
                      command.text,
                      command.format,
                      command.ending,
                    );
                  }}
                >
                  {command.name}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (() => {
        const command = savedCommands.find(
          (candidate) => candidate.id === contextMenu.commandId,
        );
        if (!command) return null;
        const items: MenuItem[] = [
          {
            label: "Edit",
            icon: "edit",
            disabled: libraryBusy,
            action: () => beginEdit(command),
          },
          {
            label: "Line ending",
            icon: "newline",
            children: LINE_ENDINGS.map(([value, label]) => ({
              label,
              checked: command.ending === value,
              mark: "radio" as const,
              disabled: libraryBusy,
              action: () => void updateSaved(command, { ending: value }),
            })),
          },
          {
            label: "Scope",
            icon: "target",
            children: chain.map((scope) => ({
              label: labelOf(scope),
              checked: sameScope(command.scope, scope),
              mark: "radio" as const,
              disabled: libraryBusy,
              action: () => void updateSaved(command, { scope }),
            })),
          },
          "separator",
          {
            label: "Delete",
            icon: "trash",
            danger: true,
            disabled: libraryBusy,
            action: () => void removeCommand(command.id),
          },
        ];
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={items}
            onClose={closeContextMenu}
          />
        );
      })()}

      {commandTooltip && (
        <div
          className="sender-command-tooltip"
          role="tooltip"
          style={{ left: commandTooltip.x, top: commandTooltip.y }}
        >
          <div>{commandTooltip.text}</div>
          <span>{commandTooltip.details}</span>
        </div>
      )}
    </>
  );
}

function buildUnits(
  text: string,
  format: SenderFormat,
  ending: LineEnding,
): (string | Uint8Array)[] {
  if (format === "hex") {
    const cleaned = text.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (cleaned.length === 0) return [];
    if (cleaned.length % 2 !== 0) {
      throw new Error("hex input needs an even number of digits");
    }
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    const suffix = endingBytes(ending);
    return [concatBytes(bytes, suffix)];
  }

  if (text.length === 0) return [];
  return [`${text}${endingText(ending)}`];
}

function endingText(ending: LineEnding): string {
  if (ending === "lf") return "\n";
  if (ending === "crlf") return "\r\n";
  return "";
}

function endingBytes(ending: LineEnding): Uint8Array {
  if (ending === "lf") return Uint8Array.of(0x0a);
  if (ending === "crlf") return Uint8Array.of(0x0d, 0x0a);
  return new Uint8Array();
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function endingLabel(ending: LineEnding): string {
  if (ending === "lf") return "append \\n";
  if (ending === "crlf") return "append \\r\\n";
  return "no line ending";
}

import { useEffect, useRef, useState } from "react";

import * as api from "../../api";
import { useStore } from "../../store";

type SenderFormat = "text" | "hex";
type Target = "current" | "all";
type LineEnding = "none" | "lf" | "crlf";
type SavedCommand = {
  id: number;
  name: string;
  text: string;
  format: SenderFormat;
  ending: LineEnding;
};
type CommandContextMenu = {
  commandId: number;
  x: number;
  y: number;
};
type CommandTooltip = {
  text: string;
  details: string;
  x: number;
  y: number;
};

const MAX_SAVED_COMMANDS = 1000;
const COMMANDS_PER_PAGE = 24;

export function SenderPanel() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setStatus = useStore((s) => s.setStatus);

  const [text, setText] = useState("");
  const [tagName, setTagName] = useState("");
  const [ending, setEnding] = useState<LineEnding>("lf");
  const [savedCommands, setSavedCommands] = useState<SavedCommand[]>([]);
  const [selectedCommandId, setSelectedCommandId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<CommandContextMenu | null>(null);
  const [commandTooltip, setCommandTooltip] = useState<CommandTooltip | null>(null);
  const [page, setPage] = useState(1);
  const [format, setFormat] = useState<SenderFormat>("text");
  const [target, setTarget] = useState<Target>("current");
  const [running, setRunning] = useState(false);
  const nextCommandId = useRef(1);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const pageCount = Math.max(
    1,
    Math.ceil(savedCommands.length / COMMANDS_PER_PAGE),
  );
  const pageCommands = savedCommands.slice(
    (page - 1) * COMMANDS_PER_PAGE,
    page * COMMANDS_PER_PAGE,
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
        text: command.text,
        details: `${command.format.toUpperCase()} · ${endingLabel(command.ending)}`,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 428)),
        y: rect.top - 8,
      });
      tooltipTimer.current = null;
    }, 200);
  };

  const targets = (): string[] => {
    if (target === "all") {
      return tabs
        .filter((tab) => tab.info.kind !== "ftp")
        .map((tab) => tab.info.id);
    }
    return tabs.some(
      (tab) => tab.info.id === activeId && tab.info.kind !== "ftp",
    ) && activeId
      ? [activeId]
      : [];
  };

  const saveCommand = () => {
    if (text.length === 0) {
      setStatus("Sender: enter a command before saving");
      return;
    }
    if (savedCommands.length >= MAX_SAVED_COMMANDS) {
      setStatus(`Sender: saved command limit is ${MAX_SAVED_COMMANDS}`);
      return;
    }

    const command: SavedCommand = {
      id: nextCommandId.current++,
      name: tagName.trim() || text,
      text,
      format,
      ending,
    };
    const nextLength = savedCommands.length + 1;
    setSavedCommands((current) => [...current, command]);
    setSelectedCommandId(command.id);
    setPage(Math.ceil(nextLength / COMMANDS_PER_PAGE));
    setTagName("");
    setStatus(`Sender: saved command ${nextLength}/${MAX_SAVED_COMMANDS}`);
  };

  const updateSavedEnding = (id: number, value: LineEnding) => {
    setSavedCommands((current) =>
      current.map((command) =>
        command.id === id ? { ...command, ending: value } : command,
      ),
    );
    setContextMenu(null);
  };

  const removeCommand = (id: number) => {
    const nextLength = savedCommands.length - 1;
    setSavedCommands((current) =>
      current.filter((command) => command.id !== id),
    );
    if (selectedCommandId === id) setSelectedCommandId(null);
    if (contextMenu?.commandId === id) setContextMenu(null);
    setPage((current) =>
      Math.min(current, Math.max(1, Math.ceil(nextLength / COMMANDS_PER_PAGE))),
    );
  };

  const sendCommand = async (
    commandText: string,
    commandFormat: SenderFormat,
    commandEnding: LineEnding,
  ) => {
    if (running) return;
    const ids = targets();
    if (ids.length === 0) {
      setStatus("Sender: no session selected");
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
        ids.map((id) =>
          typeof unit === "string"
            ? api.writeSession(id, unit)
            : api.writeSessionBinary(id, api.bytesToBase64(unit)),
        ),
      );
      setStatus("Sender: sent command");
    } catch (e) {
      setStatus(`Sender: ${e}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="sender-tabs">
        <div className="sender-tab is-active">
          <span className="panel-dot" style={{ background: "#f85149" }} />
          Sender
        </div>
      </div>

      <div className="sender-toolbar">
        <button
          className="sender-btn is-play"
          onClick={() => void sendCommand(text, format, ending)}
          disabled={running}
          title="Send"
        >
          ▶
        </button>
        <button
          className="sender-btn"
          onClick={() => setText("")}
          title="Clear"
        >
          ✕
        </button>

        <div className="sender-group">
          <label>
            <input
              type="radio"
              checked={format === "text"}
              onChange={() => setFormat("text")}
            />
            Text
          </label>
          <label>
            <input
              type="radio"
              checked={format === "hex"}
              onChange={() => setFormat("hex")}
            />
            Hex
          </label>
        </div>

        <div className="sender-group">
          <span>Ending:</span>
          <select
            value={ending}
            onChange={(event) => setEnding(event.target.value as LineEnding)}
          >
            <option value="none">None</option>
            <option value="lf">LF (\n)</option>
            <option value="crlf">CRLF (\r\n)</option>
          </select>
        </div>

        <div className="sender-group">
          <span>Targets:</span>
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as Target)}
          >
            <option value="current">Current Session</option>
            <option value="all">All Sessions ({tabs.length})</option>
          </select>
        </div>
      </div>

      <div className="sender-input">
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
            setSelectedCommandId(null);
            setText(event.target.value.replace(/[\r\n]+/g, ""));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void sendCommand(text, format, ending);
            }
          }}
        />
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
        />
        <button
          className="sender-save-btn"
          type="button"
          disabled={text.length === 0 || savedCommands.length >= MAX_SAVED_COMMANDS}
          onClick={saveCommand}
        >
          Save
        </button>
      </div>

      <div className="sender-library">
        {pageCount > 1 && (
          <div className="sender-library-head">
            <div className="sender-pagination">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage((current) => current - 1)}
              >
                ‹
              </button>
              <span>{page} / {pageCount}</span>
              <button
                type="button"
                disabled={page === pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                ›
              </button>
            </div>
          </div>
        )}

        {pageCommands.length === 0 ? (
          <div className="sender-library-empty">
            Save a command to add it here.
          </div>
        ) : (
          <div className="sender-command-tags">
            {pageCommands.map((command) => (
              <div
                className={`sender-command-tag${selectedCommandId === command.id ? " is-selected" : ""}`}
                key={command.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  hideCommandTooltip();
                  setSelectedCommandId(command.id);
                  setContextMenu({
                    commandId: command.id,
                    x: Math.min(event.clientX, window.innerWidth - 150),
                    y: Math.min(event.clientY, window.innerHeight - 118),
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
                <button
                  className="sender-command-remove"
                  type="button"
                  title="Delete saved command"
                  onClick={() => removeCommand(command.id)}
                >
                  ×
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
        return (
          <div
            className="sender-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="sender-context-title">Line ending</div>
            {([
              ["none", "None"],
              ["lf", "\\n"],
              ["crlf", "\\r\\n"],
            ] as const).map(([value, label]) => (
              <button
                className={command.ending === value ? "is-checked" : ""}
                type="button"
                key={value}
                onClick={() => updateSavedEnding(command.id, value)}
              >
                <span>{command.ending === value ? "✓" : ""}</span>
                {label}
              </button>
            ))}
          </div>
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

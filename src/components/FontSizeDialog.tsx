import { useEffect, useState } from "react";

import {
  BUFFER_FONT_SIZE,
  PANEL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
} from "../store";

interface Props {
  panelFontSize: number;
  bufferFontSize: number;
  terminalScrollback: number;
  onApply: (
    panelFontSize: number,
    bufferFontSize: number,
    terminalScrollback: number,
  ) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function FontSizeDialog({
  panelFontSize,
  bufferFontSize,
  terminalScrollback,
  onApply,
  onClose,
}: Props) {
  const [panelSize, setPanelSize] = useState(panelFontSize);
  const [bufferSize, setBufferSize] = useState(bufferFontSize);
  const [scrollback, setScrollback] = useState(terminalScrollback);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const updateNumber = (
    value: number,
    setValue: (value: number) => void,
    min: number,
    max: number,
  ) => {
    if (Number.isFinite(value)) setValue(clamp(Math.round(value), min, max));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <form
        className="dialog font-size-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onApply(panelSize, bufferSize, scrollback);
        }}
      >
        <div className="dialog-header">Display Settings</div>
        <div className="dialog-body font-size-dialog-body">
          <label className="font-size-setting">
            <span>
              <strong>Panels</strong>
              <small>Filer, Session, and Sender panels</small>
            </span>
            <input
              type="range"
              min={PANEL_FONT_SIZE.min}
              max={PANEL_FONT_SIZE.max}
              value={panelSize}
              onChange={(event) => setPanelSize(event.target.valueAsNumber)}
            />
            <input
              aria-label="Panel font size"
              className="font-size-number"
              type="number"
              min={PANEL_FONT_SIZE.min}
              max={PANEL_FONT_SIZE.max}
              value={panelSize}
              onChange={(event) =>
                updateNumber(
                  event.target.valueAsNumber,
                  setPanelSize,
                  PANEL_FONT_SIZE.min,
                  PANEL_FONT_SIZE.max,
                )
              }
            />
            <span className="font-size-unit">px</span>
          </label>

          <label className="font-size-setting">
            <span>
              <strong>Buffer</strong>
              <small>Terminal output and its gutter</small>
            </span>
            <input
              type="range"
              min={BUFFER_FONT_SIZE.min}
              max={BUFFER_FONT_SIZE.max}
              value={bufferSize}
              onChange={(event) => setBufferSize(event.target.valueAsNumber)}
            />
            <input
              aria-label="Buffer font size"
              className="font-size-number"
              type="number"
              min={BUFFER_FONT_SIZE.min}
              max={BUFFER_FONT_SIZE.max}
              value={bufferSize}
              onChange={(event) =>
                updateNumber(
                  event.target.valueAsNumber,
                  setBufferSize,
                  BUFFER_FONT_SIZE.min,
                  BUFFER_FONT_SIZE.max,
                )
              }
            />
            <span className="font-size-unit">px</span>
          </label>

          <label className="font-size-setting scrollback-setting">
            <span>
              <strong>Scrollback</strong>
              <small>Terminal history retained per session</small>
            </span>
            <input
              aria-label="Terminal scrollback lines"
              className="scrollback-number"
              type="number"
              min={TERMINAL_SCROLLBACK.min}
              max={TERMINAL_SCROLLBACK.max}
              step={1000}
              value={scrollback}
              onChange={(event) =>
                updateNumber(
                  event.target.valueAsNumber,
                  setScrollback,
                  TERMINAL_SCROLLBACK.min,
                  TERMINAL_SCROLLBACK.max,
                )
              }
            />
            <span className="font-size-unit">lines</span>
          </label>
        </div>
        <div className="dialog-footer font-size-dialog-footer">
          <button
            type="button"
            className="btn font-size-reset"
            onClick={() => {
              setPanelSize(PANEL_FONT_SIZE.default);
              setBufferSize(BUFFER_FONT_SIZE.default);
              setScrollback(TERMINAL_SCROLLBACK.default);
            }}
          >
            Reset Defaults
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}

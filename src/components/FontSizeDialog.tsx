import { useEffect, useMemo, useState } from "react";

import { listSystemFonts, type FontFamily } from "../api";
import { fontChoices, fontStack, installedFonts } from "../fonts";
import {
  BUFFER_FONT_SIZE,
  PANEL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
} from "../store";
import type { CursorStyle } from "../terminal";

/** Everything the dialog hands back when Apply is pressed. */
export interface DisplaySettings {
  panelFontSize: number;
  bufferFontSize: number;
  panelFontFamily: string;
  bufferFontFamily: string;
  terminalScrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

interface Props extends DisplaySettings {
  onApply: (settings: DisplaySettings) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function FontSizeDialog({
  panelFontSize,
  bufferFontSize,
  panelFontFamily,
  bufferFontFamily,
  terminalScrollback,
  cursorStyle,
  cursorBlink,
  onApply,
  onClose,
}: Props) {
  const [panelSize, setPanelSize] = useState(panelFontSize);
  const [bufferSize, setBufferSize] = useState(bufferFontSize);
  const [panelFamily, setPanelFamily] = useState(panelFontFamily);
  const [bufferFamily, setBufferFamily] = useState(bufferFontFamily);
  const [scrollback, setScrollback] = useState(terminalScrollback);
  const [cursor, setCursor] = useState<CursorStyle>(cursorStyle);
  const [blink, setBlink] = useState(cursorBlink);

  // Probing the machine for installed families measures text on a canvas, so
  // it happens once when the dialog opens rather than on every keystroke.
  // The saved family is kept in its list even where it is not installed, so a
  // setting brought in from another machine stays visible.
  const [probedUi] = useState(() => installedFonts("ui", panelFontFamily));
  const [probedMono] = useState(() =>
    installedFonts("mono", bufferFontFamily),
  );
  // The backend reads the font directories meanwhile: every family it finds
  // joins the suggestions when it answers, and the probe stands on its own if
  // it never does (see fontChoices).
  const [systemFonts, setSystemFonts] = useState<FontFamily[]>([]);
  useEffect(() => {
    let live = true;
    listSystemFonts()
      .then((fonts) => {
        if (live) setSystemFonts(fonts);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const uiFonts = useMemo(
    () => fontChoices("ui", probedUi, systemFonts),
    [probedUi, systemFonts],
  );
  const monoFonts = useMemo(
    () => fontChoices("mono", probedMono, systemFonts),
    [probedMono, systemFonts],
  );

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
          onApply({
            panelFontSize: panelSize,
            bufferFontSize: bufferSize,
            panelFontFamily: panelFamily.trim(),
            bufferFontFamily: bufferFamily.trim(),
            terminalScrollback: scrollback,
            cursorStyle: cursor,
            cursorBlink: blink,
          });
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

          <FontFamilyField
            id="panel-font-family"
            label="Interface font"
            hint="Menus, tabs, panels and dialogs"
            role="ui"
            value={panelFamily}
            fonts={uiFonts}
            onChange={setPanelFamily}
          />

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

          <FontFamilyField
            id="buffer-font-family"
            label="Buffer font"
            hint="Terminal typeface; pick a monospaced one"
            role="mono"
            value={bufferFamily}
            fonts={monoFonts}
            onChange={setBufferFamily}
          />

          {/* A div, not a label: the row holds two controls of its own. */}
          <div className="font-size-setting cursor-setting">
            <span>
              <strong>Cursor</strong>
              <small>Shape of the terminal cursor</small>
            </span>
            <select
              aria-label="Cursor style"
              className="cursor-style-select"
              value={cursor}
              onChange={(event) => setCursor(event.target.value as CursorStyle)}
            >
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
            <label className="cursor-blink">
              <input
                type="checkbox"
                checked={blink}
                onChange={(event) => setBlink(event.target.checked)}
              />
              Blink
            </label>
          </div>

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
              setPanelFamily("");
              setBufferFamily("");
              setScrollback(TERMINAL_SCROLLBACK.default);
              setCursor("block");
              setBlink(true);
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

/**
 * A family name with the installed fonts as suggestions. Deliberately a text
 * field rather than a closed list: `fonts.ts` can only offer the families it
 * knows to probe for, and a terminal user's face of choice is as likely to be
 * a private Nerd Font build as one of them. Empty means the platform default,
 * and the field shows its own value in the font it names.
 */
function FontFamilyField({
  id,
  label,
  hint,
  role,
  value,
  fonts,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  role: "mono" | "ui";
  value: string;
  fonts: string[];
  onChange: (family: string) => void;
}) {
  const listId = `${id}-list`;
  return (
    <label className="font-size-setting">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        aria-label={label}
        className="font-family-input"
        type="text"
        list={listId}
        spellCheck={false}
        autoComplete="off"
        placeholder="System default"
        value={value}
        style={{ fontFamily: fontStack(role, value) }}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {fonts.map((font) => (
          <option key={font} value={font} />
        ))}
      </datalist>
    </label>
  );
}

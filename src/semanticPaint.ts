import type { IBufferLine, Terminal } from "@xterm/xterm";

/**
 * Semantic colors painted straight into xterm's buffer cells (issue #80).
 *
 * Decorations cost a DOM element each and the decoration renderer walks the
 * whole list on every render, so they could only ever cover the rows near
 * the viewport. Cell attributes cost nothing per row, scroll into the
 * scrollback with their text, survive trimming and reflow, and render on
 * both the WebGL and the DOM renderer like any colored program output.
 *
 * Every cell we touch carries `PAINTED` in its background word: bit 32,
 * which xterm 6 leaves unused (bits 27..31 are italic, dim, extended,
 * protected and overline). The tag is what lets a row be recolored without
 * ever touching a program's own styling: a program that rewrites a cell
 * replaces all of its attributes, the tag included, so a tagged cell is
 * always one that was unstyled when we painted it and nothing has written
 * since. Undoing our paint is then exact — default colors, no underline —
 * instead of guessing from the palette's RGB values.
 *
 * It reaches into xterm's private buffer line (`_line._data`, three words a
 * cell: content, fg, bg); `paintable` checks that the layout is there and
 * the caller leaves semantic coloring off when it is not, so an xterm
 * upgrade loses the colors instead of corrupting the buffer.
 */

const CELL_SIZE = 3;
const CONTENT = 0;
const FG = 1;
const BG = 2;

// xterm's `Attributes`, `FgFlags` and `BgFlags` (common/buffer/Constants.ts).
const RGB_MASK = 0xffffff;
const CM_MASK = 0x3000000;
const CM_RGB = 0x3000000;
const COLOR_MASK = CM_MASK | RGB_MASK;
const FG_INVERSE = 0x4000000;
const FG_UNDERLINE = 0x10000000;
const BG_HAS_EXTENDED = 0x10000000;
/** Our tag: the one bit of the background word xterm does not use. */
export const PAINTED = 0x80000000;

/** The private side of a buffer line, re-read on every call: resize swaps `_data`. */
interface LineInternals {
  _data: Uint32Array;
  length: number;
}

export type PaintLine = LineInternals;

/** The internal line behind an API line view, or null if xterm moved it. */
export function internalLine(line: IBufferLine | undefined): PaintLine | null {
  const inner = (line as unknown as { _line?: LineInternals } | undefined)?._line;
  if (!inner || !(inner._data instanceof Uint32Array)) return null;
  if (inner._data.length < inner.length * CELL_SIZE) return null;
  return inner;
}

/** Whether this xterm exposes the buffer layout painting relies on. */
export function paintable(term: Terminal): boolean {
  const buffer = term.buffer.active;
  const line = internalLine(buffer.getLine(buffer.baseY + buffer.cursorY));
  return line !== null && line.length === term.cols;
}

/** "#rrggbb" → 0xrrggbb, cached: the palettes are a few dozen strings. */
const parsed = new Map<string, number>();
export function rgb(color: string): number {
  let value = parsed.get(color);
  if (value === undefined) {
    value = parseInt(color.slice(1, 7), 16) & RGB_MASK;
    parsed.set(color, value);
  }
  return value;
}

/**
 * A row's content words and painted-cell count folded into one number: a
 * change in either means the row was rewritten (or its paint was) since it
 * was last colored. Cheap enough to check every row of a 20k-line buffer
 * in a few milliseconds, which is what lets the backlog pass restart from
 * the bottom after every burst of output.
 */
export function rowSignature(line: PaintLine): number {
  const data = line._data;
  let hash = 0x811c9dc5;
  let painted = 0;
  for (let i = 0, end = line.length * CELL_SIZE; i < end; i += CELL_SIZE) {
    hash = Math.imul(hash ^ data[i + CONTENT], 0x01000193);
    if (data[i + BG] & PAINTED) painted += 1;
  }
  return Math.imul(hash ^ painted, 0x01000193) >>> 0;
}

/** Whether a row holds neither text nor paint, so it needs no record. */
export function rowIsBlank(line: PaintLine): boolean {
  const data = line._data;
  for (let i = 0, end = line.length * CELL_SIZE; i < end; i += CELL_SIZE) {
    if (data[i + CONTENT] || data[i + BG] & PAINTED) return false;
  }
  return true;
}

/**
 * Whether every cell in [start, end) may be painted: ours already, or
 * carrying no color, inverse or underline of the program's own. Underlined
 * and inverse text is styled even in default colors (man pages, less's
 * standout), and leaving it alone is what makes undoing a paint exact.
 */
export function canPaint(line: PaintLine, start: number, end: number): boolean {
  const data = line._data;
  const stop = Math.min(end, line.length);
  for (let col = Math.max(start, 0); col < stop; col += 1) {
    const i = col * CELL_SIZE;
    const bg = data[i + BG];
    if (bg & PAINTED) continue;
    if (data[i + FG] & (CM_MASK | FG_INVERSE | FG_UNDERLINE) || bg & CM_MASK) {
      return false;
    }
  }
  return true;
}

/** Restores every painted cell of the row to the plain cell it was; returns how many. */
export function unpaint(line: PaintLine): number {
  const data = line._data;
  let cleared = 0;
  for (let i = 0, end = line.length * CELL_SIZE; i < end; i += CELL_SIZE) {
    if (!(data[i + BG] & PAINTED)) continue;
    data[i + FG] &= ~(COLOR_MASK | FG_UNDERLINE);
    data[i + BG] &= ~(COLOR_MASK | PAINTED);
    cleared += 1;
  }
  return cleared;
}

/** Sets the background of [start, end) (a line band or a pill's ground). */
export function paintBackground(
  line: PaintLine,
  start: number,
  end: number,
  color: number,
) {
  const data = line._data;
  const stop = Math.min(end, line.length);
  for (let col = Math.max(start, 0); col < stop; col += 1) {
    const i = col * CELL_SIZE + BG;
    data[i] = (data[i] & ~COLOR_MASK) | CM_RGB | color | PAINTED;
  }
}

/**
 * Sets the foreground of [start, end), optionally underlined. The underline
 * takes the foreground color, so it needs no extended attributes; a cell
 * that already has them (an OSC 8 hyperlink) keeps its own underline rule.
 */
export function paintForeground(
  line: PaintLine,
  start: number,
  end: number,
  color: number,
  underline: boolean,
) {
  const data = line._data;
  const stop = Math.min(end, line.length);
  for (let col = Math.max(start, 0); col < stop; col += 1) {
    const i = col * CELL_SIZE;
    let fg = (data[i + FG] & ~COLOR_MASK) | CM_RGB | color;
    if (underline && !(data[i + BG] & BG_HAS_EXTENDED)) fg |= FG_UNDERLINE;
    data[i + FG] = fg;
    data[i + BG] |= PAINTED;
  }
}

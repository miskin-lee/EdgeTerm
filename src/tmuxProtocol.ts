/** tmux -CC is a byte protocol inside DCS 1000p, not a string for xterm. */
const START = new TextEncoder().encode("\x1bP1000p");
const MAX_LINE = 8 * 1024 * 1024;

export interface TmuxStreamEvents {
  data(bytes: Uint8Array): void;
  start(): void;
  line(bytes: Uint8Array): void;
  end(): void;
  error(message: string): void;
}

/** Keeps only an incomplete prefix/line; read boundaries have no meaning. */
export class TmuxStream {
  private prefix: number[] = [];
  private line: number[] = [];
  private escape = false;
  private dropping = false;
  active = false;

  constructor(private readonly events: TmuxStreamEvents) {}

  feed(bytes: Uint8Array) {
    if (!this.active && !this.prefix.length && bytes.indexOf(27) === -1) {
      this.events.data(bytes);
      return;
    }
    let ordinary: number[] = [];
    const flush = () => {
      if (ordinary.length) this.events.data(Uint8Array.from(ordinary));
      ordinary = [];
    };
    for (const byte of bytes) {
      if (!this.active) {
        if (byte === START[this.prefix.length]) {
          this.prefix.push(byte);
          if (this.prefix.length === START.length) {
            flush();
            this.prefix = [];
            this.active = true;
            this.events.start();
          }
        } else {
          ordinary.push(...this.prefix);
          this.prefix = [];
          if (byte === START[0]) this.prefix.push(byte);
          else ordinary.push(byte);
        }
        continue;
      }
      if (this.escape && byte === 0x5c) {
        this.active = false;
        this.escape = false;
        this.line = [];
        this.dropping = false;
        this.events.end();
        continue;
      }
      if (this.escape) this.line.push(0x1b);
      this.escape = byte === 0x1b;
      if (this.escape) continue;
      if (byte === 10) {
        if (!this.dropping) {
          if (this.line[this.line.length - 1] === 13) this.line.pop();
          this.events.line(Uint8Array.from(this.line));
        }
        this.line = [];
        this.dropping = false;
      } else if (!this.dropping) {
        this.line.push(byte);
        if (this.line.length > MAX_LINE) {
          this.line = [];
          this.dropping = true;
          this.events.error("tmux sent an oversized protocol line.");
        }
      }
    }
    flush();
  }

  reset() {
    this.prefix = [];
    this.line = [];
    this.escape = false;
    this.dropping = false;
    this.active = false;
  }
}

/** Programs see TERM=screen/tmux. Its ESC k title string is not xterm syntax. */
export class TmuxPaneStream {
  private escape = false;
  feed(bytes: Uint8Array): Uint8Array {
    if (!this.escape && bytes.indexOf(27) === -1) return bytes;
    const output: number[] = [];
    for (const byte of bytes) {
      if (this.escape) {
        this.escape = false;
        if (byte === 0x6b) {
          output.push(27, 93, 50, 59);
          continue;
        } // OSC 2;
        output.push(27);
      }
      if (byte === 27) this.escape = true;
      else output.push(byte);
    }
    return Uint8Array.from(output);
  }
}

/** Unescape octal bytes without ever decoding the pane's character encoding. */
export function tmuxBytes(input: Uint8Array): Uint8Array {
  const result = new Uint8Array(input.length);
  let length = 0;
  for (let index = 0; index < input.length; index++) {
    if (
      input[index] === 92 &&
      index + 3 < input.length &&
      input[index + 1] >= 48 &&
      input[index + 1] <= 51 &&
      input[index + 2] >= 48 &&
      input[index + 2] <= 55 &&
      input[index + 3] >= 48 &&
      input[index + 3] <= 55
    ) {
      result[length++] =
        (input[index + 1] - 48) * 64 +
        (input[index + 2] - 48) * 8 +
        input[index + 3] -
        48;
      index += 3;
    } else result[length++] = input[index];
  }
  return result.subarray(0, length);
}

export interface TmuxLayout {
  cols: number;
  rows: number;
  x: number;
  y: number;
  pane?: string;
  direction?: "row" | "column";
  children: TmuxLayout[];
}

/** tmux's cell geometry includes a one-cell separator between siblings. */
export function parseTmuxLayout(value: string): TmuxLayout {
  let offset = value.indexOf(",") + 1; // checksum
  let count = 0;
  const parse = (depth: number): TmuxLayout => {
    if (depth > 64 || ++count > 1024)
      throw new Error("tmux layout is too large");
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(value.slice(offset));
    if (!match) throw new Error("Invalid tmux layout");
    offset += match[0].length;
    const [cols, rows, x, y] = match.slice(1).map(Number);
    if (cols < 1 || rows < 1 || [cols, rows, x, y].some((n) => n > 100_000)) {
      throw new Error("Invalid tmux pane dimensions");
    }
    const node: TmuxLayout = { cols, rows, x, y, children: [] };
    if (value[offset] === ",") {
      const pane = /^,(\d+)/.exec(value.slice(offset));
      if (!pane) throw new Error("Invalid tmux pane ID");
      offset += pane[0].length;
      node.pane = `%${pane[1]}`;
    } else {
      const open = value[offset++];
      if (open !== "{" && open !== "[") throw new Error("Invalid tmux split");
      node.direction = open === "{" ? "row" : "column";
      const close = open === "{" ? "}" : "]";
      do {
        node.children.push(parse(depth + 1));
        if (value[offset] !== ",") break;
        offset++;
      } while (true);
      if (value[offset++] !== close || node.children.length < 2) {
        throw new Error("Invalid tmux split boundary");
      }
    }
    return node;
  };
  const root = parse(0);
  if (offset !== value.length) throw new Error("Trailing tmux layout data");
  return root;
}

export const tmuxLeaves = (node: TmuxLayout): TmuxLayout[] =>
  node.pane ? [node] : node.children.flatMap(tmuxLeaves);

export const tmuxId = (id: string, kind: "%" | "@") => {
  if (!new RegExp(`^${kind}\\d+$`).test(id)) throw new Error("Invalid tmux ID");
  return id;
};

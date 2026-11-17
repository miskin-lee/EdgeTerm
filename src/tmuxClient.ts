import { tmuxBytes } from "./tmuxProtocol";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
interface Request {
  commands: string[];
  results: Uint8Array[][];
  resolve(lines: Uint8Array[][]): void;
  reject(error: Error): void;
  completed?: (lines: Uint8Array[][]) => void;
}

/** Commands are serialized; unsolicited notifications never consume a reply. */
export class TmuxClient {
  private queue: Request[] = [];
  private current: Request | null = null;
  private block: {
    guard: string;
    ours: boolean;
    lines: Uint8Array[];
    bytes: number;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly send: (command: string) => Promise<void>,
    private readonly output: (pane: string, bytes: Uint8Array) => void,
    private readonly notify: (line: string) => void,
    private readonly failure: (message: string) => void,
  ) {}

  request(command: string): Promise<Uint8Array[]> {
    return this.batch([command]).then((results) => results[0]);
  }

  /** One command list runs without pane I/O between its snapshots/mode query. */
  batch(
    commands: string[],
    completed?: (lines: Uint8Array[][]) => void,
  ): Promise<Uint8Array[][]> {
    if (this.stopped) return Promise.reject(new Error("tmux is disconnected"));
    if (!commands.length || commands.some((command) => /[\r\n]/.test(command)))
      return Promise.reject(new Error("Invalid tmux command"));
    if (this.queue.length >= 256)
      return Promise.reject(new Error("tmux input queue is full"));
    return new Promise((resolve, reject) => {
      this.queue.push({ commands, results: [], resolve, reject, completed });
      this.pump();
    });
  }

  private pump() {
    if (this.current || this.stopped) return;
    const request = this.queue.shift();
    if (!request) return;
    this.current = request;
    this.timer = setTimeout(
      () => this.fail("tmux did not answer within 15 seconds."),
      15_000,
    );
    void this.send(`${request.commands.join(" ; ")}\n`).catch((error) =>
      this.fail(String(error)),
    );
  }

  line(bytes: Uint8Array) {
    if (this.stopped) return;
    // Decode only protocol headers. Pane payload remains arbitrary bytes.
    const header = decode(bytes.subarray(0, 160));
    if (this.block) {
      if (
        header === `%end ${this.block.guard}` ||
        header === `%error ${this.block.guard}`
      ) {
        const block = this.block;
        this.block = null;
        if (!block.ours) return;
        const request = this.current;
        if (header.startsWith("%error ")) {
          // tmux aborts the remainder of a command list after an error.
          this.current = null;
          clearTimeout(this.timer);
          request?.reject(
            new Error(
              block.lines.map(decode).join("\n") || "tmux command failed",
            ),
          );
          this.pump();
        } else if (request) {
          request.results.push(block.lines);
          if (request.results.length === request.commands.length) {
            this.current = null;
            clearTimeout(this.timer);
            try {
              request.completed?.(request.results);
              request.resolve(request.results);
            } catch (error) {
              request.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
            this.pump();
          }
        }
      } else {
        this.block.bytes += bytes.length;
        if (this.block.bytes > 32 * 1024 * 1024)
          this.fail("tmux reply exceeded 32 MiB.");
        else this.block.lines.push(bytes);
      }
      return;
    }
    const begin = /^%begin (\d+ \d+ (\d+))$/.exec(header);
    if (begin) {
      this.block = {
        guard: begin[1],
        ours: (Number(begin[2]) & 1) !== 0,
        lines: [],
        bytes: 0,
      };
      return;
    }
    const output =
      /^%output (%\d+) /.exec(header) ??
      /^%extended-output (%\d+) [^:]*: /.exec(header);
    if (output) {
      this.output(output[1], tmuxBytes(bytes.subarray(output[0].length)));
    } else this.notify(decode(bytes));
  }

  stop(message = "tmux detached") {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    const error = new Error(message);
    this.current?.reject(error);
    this.current = null;
    for (const request of this.queue.splice(0)) request.reject(error);
    this.block = null;
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop(message);
    this.failure(message);
  }
}

/** Hex input prevents keys, quotes and newlines becoming tmux commands. */
export async function sendTmuxBytes(
  client: TmuxClient,
  pane: string,
  bytes: Uint8Array,
) {
  if (!/^%\d+$/.test(pane)) throw new Error("Invalid tmux pane");
  for (let index = 0; index < bytes.length; index += 512) {
    const hex = Array.from(bytes.subarray(index, index + 512), (byte) =>
      byte.toString(16).padStart(2, "0"),
    );
    await client.request(`send-keys -H -t ${pane} ${hex.join(" ")}`);
  }
}

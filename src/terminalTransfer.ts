import * as api from "./api";

/**
 * Pieces shared by the terminal file-transfer protocols (ZMODEM in
 * zmodem.ts, XMODEM in xmodem.ts): local file I/O through the bounded IPC
 * chunks, progress formatting, and the notice / status reporting contract
 * with the TerminalController.
 */

/** Application-level chunk for local file I/O across IPC; see commands.rs. */
export const FILE_CHUNK_SIZE = 1024 * 1024;

export type TransferNoticeKind = "active" | "success" | "error";

export interface TransferCallbacks {
  toTerminal: (bytes: Uint8Array) => void;
  onStatus: (message: string, error?: boolean) => void;
  onNotice: (message: string, kind: TransferNoticeKind) => void;
}

/**
 * Streams received bytes into a local file FILE_CHUNK_SIZE at a time, so a
 * download never has to fit in the WebView's memory. Writes are queued in
 * order; the first failure is kept in `error` and reported through
 * `onError` (once) and `whenFailed`.
 */
export class BufferedFileWriter {
  private parts: Uint8Array[] = [];
  private buffered = 0;
  private scheduled = 0;
  private queue: Promise<void> = Promise.resolve();
  private failureResolver: (() => void) | null = null;

  error: unknown = null;
  readonly whenFailed = new Promise<void>((resolve) => {
    this.failureResolver = resolve;
  });

  constructor(
    private readonly path: string,
    private readonly onProgress: (written: number) => void,
    private readonly onError: () => void,
  ) {}

  push(bytes: number[] | Uint8Array) {
    if (this.error || bytes.length === 0) return;
    const source = Uint8Array.from(bytes);
    let sourceOffset = 0;
    while (sourceOffset < source.length) {
      const length = Math.min(
        FILE_CHUNK_SIZE - this.buffered,
        source.length - sourceOffset,
      );
      this.parts.push(source.subarray(sourceOffset, sourceOffset + length));
      this.buffered += length;
      sourceOffset += length;
      if (this.buffered === FILE_CHUNK_SIZE) this.flushBuffer();
    }
  }

  /** Flushes what is buffered, truncates the file to it and returns its size. */
  async finish(): Promise<number> {
    this.flushBuffer();
    await this.queue;
    if (this.error) throw this.error;
    await api.zmodemFinishFile(this.path, this.scheduled);
    return this.scheduled;
  }

  private flushBuffer() {
    if (this.error || this.buffered === 0) return;
    const bytes = concatBytes(this.parts, this.buffered);
    const offset = this.scheduled;
    this.parts = [];
    this.buffered = 0;
    this.scheduled += bytes.length;

    this.queue = this.queue.then(async () => {
      if (this.error) return;
      try {
        await api.zmodemWriteChunk(this.path, offset, bytes);
        this.onProgress(offset + bytes.length);
      } catch (error) {
        this.error = error;
        this.parts = [];
        this.buffered = 0;
        this.onError();
        this.failureResolver?.();
      }
    });
  }
}

/**
 * Reads a local file through the chunked IPC, keeping the current chunk so a
 * protocol that consumes the file in small blocks (XMODEM's 128 / 1024
 * bytes) costs one round trip per FILE_CHUNK_SIZE rather than one per block.
 */
export class ChunkedFileReader {
  private chunkOffset = 0;
  private chunk = new Uint8Array(0);

  constructor(
    private readonly path: string,
    readonly size: number,
  ) {}

  /**
   * The file's bytes from `offset`, at most `length` of them (fewer only at
   * the end of the file). The returned view is only valid until the next
   * read; copy it to keep it.
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length > FILE_CHUNK_SIZE) {
      throw new Error(`read of ${length} bytes exceeds the ${FILE_CHUNK_SIZE}-byte chunk`);
    }
    if (offset >= this.size || length <= 0) return new Uint8Array(0);
    const end = Math.min(offset + length, this.size);
    if (
      offset < this.chunkOffset ||
      end > this.chunkOffset + this.chunk.length
    ) {
      await this.load(offset);
      if (end > this.chunkOffset + this.chunk.length) {
        throw new Error("the file ended before its reported size");
      }
    }
    return this.chunk.subarray(offset - this.chunkOffset, end - this.chunkOffset);
  }

  private async load(offset: number) {
    const requested = Math.min(FILE_CHUNK_SIZE, this.size - offset);
    const encoded = await api.zmodemReadChunk(this.path, offset, requested);
    this.chunkOffset = offset;
    this.chunk = api.base64ToBytes(encoded);
  }
}

export function concatBytes(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0].length === length) return parts[0];
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export function formatProgress(transferred: number, total: number | null): string {
  if (total === null || total === 0) return formatBytes(transferred);
  const percent = Math.min(100, Math.floor((transferred / total) * 100));
  return `${percent}% (${formatBytes(transferred)} / ${formatBytes(total)})`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

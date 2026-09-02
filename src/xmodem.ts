import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import * as api from "./api";
import {
  BufferedFileWriter,
  ChunkedFileReader,
  errorMessage,
  formatBytes,
  formatProgress,
  type TransferCallbacks,
  type TransferNoticeKind,
} from "./terminalTransfer";

/**
 * XMODEM, XMODEM-CRC and XMODEM-1K over a terminal session.
 *
 * Unlike ZMODEM there is no handshake a sentry could detect: the receiver
 * opens by asking for the first block, and until then the byte stream is
 * ordinary terminal output. The user therefore starts a transfer explicitly
 * (Session → File Transfer), after starting the other side (`rx` / `sx`, a
 * bootloader's `loadx`, …) in the terminal. XmodemTransfer is the protocol
 * itself over an abstract link, exercised by xmodem.test.ts with two ends in
 * memory; XmodemController adds the file dialogs, local file I/O and the
 * notices, and is what the TerminalController drives.
 */

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
/** `C`: the receiver asks for CRC-16 blocks (XMODEM-CRC / -1K). */
const CRC_REQUEST = 0x43;
/** `G`: the receiver asks for YMODEM-G streaming, which has no ACKs. */
const STREAMING_REQUEST = 0x47;
/** ^Z, the traditional padding of a short last block. */
const PAD = 0x1a;
const BACKSPACE = 0x08;

export type XmodemBlockSize = 128 | 1024;
export type CheckMode = "crc" | "checksum";

/** Retry budget for a single block, and for the handshake, before giving up. */
const MAX_ERRORS = 10;
/**
 * `sx -k` sends the tail of a file in 128-byte blocks once no more than this
 * many bytes remain: 1K blocks would mostly be padding by then.
 */
const SHORT_TAIL_BYTES = 896;
/** How many CANs a peer needs to see; U-Boot wants three, lrzsz sends eight. */
const CANCEL_SEQUENCE = Uint8Array.from([
  ...new Array<number>(8).fill(CAN),
  ...new Array<number>(8).fill(BACKSPACE),
]);

export interface XmodemTiming {
  /** Between the receiver's `C` requests, before it falls back to NAK. */
  crcRequestMs: number;
  /** How many `C` requests go unanswered before the fallback. */
  crcRequests: number;
  /** For the first byte of a block, and for the sender's ACK. */
  blockMs: number;
  /** Between the bytes of one block. */
  interByteMs: number;
  /** Silence that ends a purge after a corrupted block. */
  purgeQuietMs: number;
  /**
   * Wait for a second check byte after the first block, which tells a CRC
   * block (two) from a checksum block (one). A CRC block's bytes arrive
   * together, so this is only ever paid once, by checksum senders.
   */
  crcProbeMs: number;
  /** How long the sender waits for a receiver to ask for the first block. */
  handshakeMs: number;
}

/**
 * The receiver's timings follow the XMODEM-CRC note (three `C`s, then NAK)
 * and the 10-second block timeout of the original protocol; the inter-byte
 * timeout is looser than the specified one second because the bytes arrive
 * in bursts from the backend rather than one at a time.
 */
export const DEFAULT_TIMING: XmodemTiming = {
  crcRequestMs: 3_000,
  crcRequests: 3,
  blockMs: 10_000,
  interByteMs: 2_000,
  purgeQuietMs: 1_000,
  crcProbeMs: 300,
  handshakeMs: 60_000,
};

/** The transfer's bytes toward the peer; resolves once the transport took them. */
export interface XmodemLink {
  send(bytes: Uint8Array): Promise<void>;
}

export interface XmodemSource {
  readonly size: number;
  /** Bytes from `offset`, fewer than `length` only at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface XmodemSink {
  write(bytes: Uint8Array): void;
}

/** This side gave up: the user canceled, or a local error stopped it. */
export class TransferCanceled extends Error {}
/** The other side sent CANs. */
export class PeerCanceled extends Error {
  constructor() {
    super("the other side canceled the transfer");
  }
}

class Timeout extends Error {
  constructor() {
    super("timeout");
  }
}

/** CRC-16/XMODEM: polynomial 0x1021, no initial value, no reflection. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function checksum(data: Uint8Array): number {
  let sum = 0;
  for (const byte of data) sum = (sum + byte) & 0xff;
  return sum;
}

/** One block: header, sequence, its complement, `size` data bytes (padded), check. */
export function buildBlock(
  sequence: number,
  data: Uint8Array,
  size: XmodemBlockSize,
  mode: CheckMode,
): Uint8Array {
  if (data.length > size) {
    throw new Error(`${data.length} bytes do not fit a ${size}-byte block`);
  }
  const block = new Uint8Array(3 + size + (mode === "crc" ? 2 : 1));
  block[0] = size === 1024 ? STX : SOH;
  block[1] = sequence & 0xff;
  block[2] = ~sequence & 0xff;
  block.set(data, 3);
  block.fill(PAD, 3 + data.length, 3 + size);
  const body = block.subarray(3, 3 + size);
  if (mode === "crc") {
    const crc = crc16(body);
    block[3 + size] = crc >> 8;
    block[4 + size] = crc & 0xff;
  } else {
    block[3 + size] = checksum(body);
  }
  return block;
}

/** Inbound bytes with timed reads. One reader at a time. */
class Inbox {
  private chunks: Uint8Array[] = [];
  /** Read position within `chunks[0]`. */
  private head = 0;
  private length = 0;
  private waiter: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  } | null = null;
  private closed: Error | null = null;

  get available(): number {
    return this.length;
  }

  push(bytes: Uint8Array) {
    // Kept even after close: what arrives once the transfer is over (the
    // remote prompt, say) belongs to the terminal; see `takeAll`.
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      window.clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** Drops everything buffered. */
  drain() {
    this.chunks = [];
    this.head = 0;
    this.length = 0;
  }

  /** Everything buffered, leaving the inbox empty. */
  takeAll(): Uint8Array {
    return this.take(this.length);
  }

  /**
   * The next `count` bytes. `timeoutMs` is the longest wait between
   * arrivals, not for the whole read.
   */
  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    await this.waitFor(count, timeoutMs);
    return this.take(count);
  }

  async waitFor(count: number, timeoutMs: number): Promise<void> {
    while (this.length < count) {
      if (this.closed) throw this.closed;
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.waiter = null;
          reject(new Timeout());
        }, timeoutMs);
        this.waiter = { resolve, reject, timer };
      });
    }
    if (this.closed) throw this.closed;
  }

  close(error: Error) {
    this.closed = error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0];
      const n = Math.min(count - filled, chunk.length - this.head);
      out.set(chunk.subarray(this.head, this.head + n), filled);
      filled += n;
      this.head += n;
      if (this.head === chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.length -= count;
    return out;
  }
}

/**
 * One XMODEM transfer in either direction. Feed the peer's bytes to
 * `consume`; `send` / `receive` run the protocol to completion and reject on
 * any failure, after telling the peer where that is due.
 */
export class XmodemTransfer {
  private readonly inbox = new Inbox();
  private readonly timing: XmodemTiming;
  /** Why the transfer ended; set once, by `finish`. */
  private ended: Error | null = null;
  /** Consecutive CANs seen; two in a row mean the peer gave up. */
  private cancelStreak = 0;

  constructor(
    private readonly link: XmodemLink,
    timing: Partial<XmodemTiming> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  consume(bytes: Uint8Array) {
    this.inbox.push(bytes);
  }

  get hasEnded(): boolean {
    return this.ended !== null;
  }

  /**
   * Input the protocol did not consume, for the terminal: what came in
   * after the transfer ended, and the tail of a failed one.
   */
  leftover(): Uint8Array {
    return this.inbox.takeAll();
  }

  /** Stops the transfer from this side: the peer is told with CANs. */
  cancel(message = "transfer canceled") {
    this.finish(new TransferCanceled(message), true);
  }

  /** Stops the transfer because of a local error; the peer is told. */
  fail(error: Error) {
    this.finish(error, true);
  }

  /** Stops the transfer without telling the peer (the session is gone). */
  abandon(message: string) {
    this.finish(new Error(message), false);
  }

  /**
   * Sends `source` as one file, in `blockSize` blocks while the receiver
   * asks for CRC. Resolves after the receiver has acknowledged the EOT.
   */
  async send(
    source: XmodemSource,
    blockSize: XmodemBlockSize,
    onProgress: (sent: number) => void = () => undefined,
  ): Promise<void> {
    try {
      const mode = await this.awaitReceiver();
      // Plain (checksum) XMODEM predates 1K blocks; a receiver that asks
      // for checksums may not know the STX header.
      const preferred: XmodemBlockSize = mode === "checksum" ? 128 : blockSize;
      let offset = 0;
      let sequence = 1;
      while (offset < source.size) {
        const remaining = source.size - offset;
        const size: XmodemBlockSize =
          preferred === 1024 && remaining <= SHORT_TAIL_BYTES ? 128 : preferred;
        const data = await source.read(offset, size);
        if (data.length === 0) {
          throw new Error("the file ended before its reported size");
        }
        await this.deliver(buildBlock(sequence, data, size, mode), sequence === 1);
        offset += data.length;
        sequence = (sequence + 1) & 0xff;
        onProgress(offset);
      }
      await this.deliver(Uint8Array.of(EOT), false);
      this.finish(null, false);
    } catch (error) {
      throw this.failWith(error);
    }
  }

  /**
   * Receives one file into `sink`; resolves with the byte count, padding
   * included (XMODEM carries no file size). Asks for CRC first and falls
   * back to checksums for senders that never learned `C`; the check mode is
   * settled by the first block that arrives, whichever was asked for.
   */
  async receive(
    sink: XmodemSink,
    onProgress: (received: number) => void = () => undefined,
  ): Promise<number> {
    try {
      const { timing } = this;
      let mode: CheckMode | null = null;
      let handshake = CRC_REQUEST;
      let crcRequests = 0;
      let errors = 0;
      let expected = 1;
      let received = 0;
      /** The byte to send before the next wait; null after ignored input. */
      let request: number | null = handshake;

      const retry = async (problem: string): Promise<void> => {
        await this.purge();
        errors += 1;
        if (errors >= MAX_ERRORS) throw new Error(problem);
        request = mode === null ? handshake : NAK;
      };

      for (;;) {
        if (request !== null) await this.write(Uint8Array.of(request));

        let header: number;
        try {
          const timeout =
            mode === null && handshake === CRC_REQUEST
              ? timing.crcRequestMs
              : timing.blockMs;
          header = (await this.inbox.read(1, timeout))[0];
        } catch (error) {
          if (!(error instanceof Timeout)) throw error;
          if (mode === null && handshake === CRC_REQUEST) {
            crcRequests += 1;
            if (crcRequests >= timing.crcRequests) handshake = NAK;
          }
          errors += 1;
          if (errors >= MAX_ERRORS) {
            throw new Error(
              mode === null
                ? "no sender answered (start sx or the device's XMODEM send first)"
                : "the sender stopped responding",
            );
          }
          request = mode === null ? handshake : NAK;
          continue;
        }

        let size: XmodemBlockSize;
        if (header === SOH) {
          size = 128;
        } else if (header === STX) {
          size = 1024;
        } else if (header === EOT) {
          await this.write(Uint8Array.of(ACK));
          this.finish(null, false);
          return received;
        } else {
          this.noteCancel(header);
          if (mode === null) {
            // Echo of the command line, a banner: not the sender yet.
            request = null;
          } else {
            await retry("too much line noise");
          }
          continue;
        }
        this.cancelStreak = 0;

        // Sequence, complement, data and the first check byte; a CRC block
        // has a second one, which settles the mode on the first block.
        let fixed: Uint8Array;
        let secondCheck: number | null = null;
        try {
          fixed = await this.inbox.read(2 + size + 1, timing.interByteMs);
          if (mode !== "checksum") {
            try {
              const probe: number =
                mode === "crc" ? timing.interByteMs : timing.crcProbeMs;
              secondCheck = (await this.inbox.read(1, probe))[0];
            } catch (error) {
              if (!(error instanceof Timeout) || mode === "crc") throw error;
            }
          }
        } catch (error) {
          if (!(error instanceof Timeout)) throw error;
          await retry("the sender kept sending incomplete blocks");
          continue;
        }

        const sequence = fixed[0];
        const data = fixed.subarray(2, 2 + size);
        const blockMode: CheckMode = secondCheck === null ? "checksum" : "crc";
        const valid =
          fixed[1] === (~sequence & 0xff) &&
          (blockMode === "crc"
            ? crc16(data) === ((fixed[2 + size] << 8) | (secondCheck as number))
            : checksum(data) === fixed[2 + size]);
        if (!valid) {
          await retry("too many corrupted blocks");
          continue;
        }
        mode ??= blockMode;

        if (sequence === expected) {
          sink.write(data);
          received += size;
          expected = (expected + 1) & 0xff;
          errors = 0;
          onProgress(received);
        } else if (sequence === ((expected - 1) & 0xff) && received > 0) {
          // Our ACK was lost and the sender repeated the block.
        } else if (sequence === 0 && expected === 1) {
          throw new Error(
            "the sender is using YMODEM (it sent a file header block); only XMODEM is supported",
          );
        } else {
          throw new Error(
            `block sequence error: expected ${expected}, received ${sequence}`,
          );
        }
        request = ACK;
      }
    } catch (error) {
      throw this.failWith(error);
    }
  }

  /** Waits for the receiver's opening request and returns the mode it asked for. */
  private async awaitReceiver(): Promise<CheckMode> {
    const deadline = Date.now() + this.timing.handshakeMs;
    let mode: CheckMode | null = null;
    // Keep reading while bytes are at hand: a receiver that gave up on CRC
    // while the file dialog was open has moved on to NAK, and the latest
    // request is the one it still means.
    do {
      let byte: number;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0 && this.inbox.available === 0) throw new Timeout();
        byte = (await this.inbox.read(1, Math.max(remaining, 1)))[0];
      } catch (error) {
        if (!(error instanceof Timeout)) throw error;
        throw new Error(
          "no receiver asked for the file (start rx or the device's XMODEM receive first)",
        );
      }
      if (byte === CRC_REQUEST) {
        mode = "crc";
      } else if (byte === NAK) {
        mode = "checksum";
      } else if (byte === STREAMING_REQUEST) {
        throw new Error(
          "the receiver asked for YMODEM-G streaming, which is not supported",
        );
      } else {
        this.noteCancel(byte);
      }
    } while (mode === null || this.inbox.available > 0);
    this.cancelStreak = 0;
    return mode;
  }

  /** Sends `packet` until the receiver acknowledges it. */
  private async deliver(packet: Uint8Array, firstBlock: boolean) {
    for (let errors = 0; ; ) {
      await this.write(packet);
      const reply = await this.awaitReply(firstBlock);
      if (reply === ACK) return;
      // NAK, or silence: send it again.
      errors += 1;
      if (errors >= MAX_ERRORS) {
        throw new Error(
          reply === null
            ? "the receiver stopped responding"
            : "the receiver rejected the block too many times",
        );
      }
    }
  }

  /**
   * ACK, NAK, or null on timeout. A repeated `C` from a receiver still
   * opening counts as a NAK for the first block only; anything else is
   * noise, apart from CANs.
   */
  private async awaitReply(firstBlock: boolean): Promise<number | null> {
    const deadline = Date.now() + this.timing.blockMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      let byte: number;
      try {
        byte = (await this.inbox.read(1, remaining))[0];
      } catch (error) {
        if (error instanceof Timeout) return null;
        throw error;
      }
      if (byte === ACK || byte === NAK) {
        this.cancelStreak = 0;
        return byte;
      }
      if (byte === CRC_REQUEST && firstBlock) {
        this.cancelStreak = 0;
        return NAK;
      }
      this.noteCancel(byte);
    }
  }

  private noteCancel(byte: number) {
    if (byte !== CAN) {
      this.cancelStreak = 0;
      return;
    }
    this.cancelStreak += 1;
    if (this.cancelStreak >= 2) throw new PeerCanceled();
  }

  /** Discards input until the line has been quiet for a while. */
  private async purge() {
    for (;;) {
      this.inbox.drain();
      try {
        await this.inbox.waitFor(1, this.timing.purgeQuietMs);
      } catch (error) {
        if (error instanceof Timeout) return;
        throw error;
      }
    }
  }

  private async write(bytes: Uint8Array) {
    if (this.ended) throw this.ended;
    await this.link.send(bytes);
  }

  private failWith(error: unknown): Error {
    const failure =
      error instanceof Error ? error : new Error(errorMessage(error));
    // A peer that canceled does not need CANs back; a transfer that was
    // already finished (canceled, abandoned) has done its notifying.
    this.finish(failure, !(failure instanceof PeerCanceled));
    return failure;
  }

  private finish(error: Error | null, notifyPeer: boolean) {
    if (this.ended) return;
    this.ended = error ?? new TransferCanceled("transfer ended");
    this.inbox.close(this.ended);
    if (notifyPeer) {
      void this.link.send(CANCEL_SEQUENCE).catch(() => undefined);
    }
  }
}

/**
 * Drives one XMODEM transfer for a terminal: the file dialogs, the local
 * file I/O in bounded chunks, and the status notices. While a transfer runs
 * it owns the session's byte stream (see TerminalController.write).
 */
export class XmodemController {
  private transfer: XmodemTransfer | null = null;
  /**
   * Output held back while a file dialog is open. A receiver's opening
   * requests arrive then, and can be acted on right away instead of
   * waiting for its next retry; if the dialog is canceled, the bytes go on
   * to the terminal as if nothing had happened.
   */
  private held: Uint8Array[] | null = null;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TransferCallbacks,
  ) {}

  isActive(): boolean {
    return this.transfer !== null || this.held !== null;
  }

  consume(bytes: Uint8Array) {
    if (this.transfer) this.transfer.consume(bytes);
    else if (this.held) this.held.push(bytes);
  }

  /** Cancels the running transfer; false when there is none to cancel. */
  cancel(): boolean {
    if (!this.transfer) return false;
    this.transfer.cancel();
    return true;
  }

  /** The session ended under the transfer: fail it without CANs. */
  sessionEnded() {
    this.transfer?.abandon("the session ended");
  }

  dispose() {
    this.disposed = true;
    this.transfer?.abandon("the terminal was closed");
    this.transfer = null;
    this.held = null;
  }

  /** Sends one local file, chosen in a dialog, in `blockSize` blocks. */
  async send(blockSize: XmodemBlockSize) {
    const label = blockSize === 1024 ? "XMODEM-1K" : "XMODEM";
    if (!this.begin(label)) return;

    let path: string | null = null;
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: `Send via ${label}`,
      });
      path = typeof selected === "string" ? selected : null;
    } catch (error) {
      this.release();
      this.report(`${label} failed: ${errorMessage(error)}`, "error");
      return;
    }
    if (!path || this.disposed) {
      this.release();
      return;
    }

    let info: api.ZmodemFileInfo;
    try {
      info = await api.zmodemFileInfo(path);
    } catch (error) {
      this.release();
      this.report(`${label} failed: ${errorMessage(error)}`, "error");
      return;
    }

    const transfer = this.activate();
    this.report(`${label}: waiting for the receiver to ask for ${info.name}…`);
    const reader = new ChunkedFileReader(path, info.size);
    let lastReportAt = 0;
    try {
      await transfer.send(reader, blockSize, (sent) => {
        const now = Date.now();
        if (now - lastReportAt < 50 && sent !== info.size) return;
        lastReportAt = now;
        this.report(
          `${label} sending ${info.name}: ${formatProgress(sent, info.size)}`,
        );
      });
      this.report(
        `${label}: sent ${info.name} (${formatBytes(info.size)})`,
        "success",
      );
    } catch (error) {
      this.reportFailure(label, error);
    } finally {
      this.settle(transfer);
    }
  }

  /** Receives one file into a location chosen in a dialog. */
  async receive() {
    const label = "XMODEM";
    if (!this.begin(label)) return;

    let target: string | null = null;
    try {
      target = await saveDialog({
        defaultPath: "xmodem.bin",
        title: "Receive via XMODEM",
      });
    } catch (error) {
      this.release();
      this.report(`${label} failed: ${errorMessage(error)}`, "error");
      return;
    }
    if (!target || this.disposed) {
      this.release();
      return;
    }

    try {
      await api.zmodemCreateFile(target);
    } catch (error) {
      this.release();
      this.report(`${label} failed: ${errorMessage(error)}`, "error");
      return;
    }

    const name = fileName(target);
    const transfer = this.activate();
    this.report(`${label}: waiting for the sender to start ${name}…`);
    const writer = new BufferedFileWriter(
      target,
      () => undefined,
      () => transfer.fail(new Error(`cannot write ${name}: ${errorMessage(writer.error)}`)),
    );
    let lastReportAt = 0;
    try {
      await transfer.receive(
        { write: (bytes) => writer.push(bytes) },
        (received) => {
          const now = Date.now();
          if (now - lastReportAt < 50) return;
          lastReportAt = now;
          this.report(`${label} receiving ${name}: ${formatBytes(received)}`);
        },
      );
      const size = await writer.finish();
      this.report(
        `${label}: received ${name} (${formatBytes(size)})`,
        "success",
      );
    } catch (error) {
      this.reportFailure(label, error);
    } finally {
      this.settle(transfer);
    }
  }

  /** Starts holding output back for a dialog; false when a transfer is on. */
  private begin(label: string): boolean {
    if (this.disposed) return false;
    if (this.isActive()) {
      this.report(`${label}: a transfer is already running`, "error");
      return false;
    }
    this.held = [];
    return true;
  }

  /** The dialog was canceled: the held output belongs to the terminal. */
  private release() {
    const held = this.held;
    this.held = null;
    if (!held || this.disposed) return;
    for (const bytes of held) this.callbacks.toTerminal(bytes);
  }

  /** The dialog was confirmed: the held output opens the transfer's input. */
  private activate(): XmodemTransfer {
    const transfer = new XmodemTransfer({
      send: (bytes) =>
        api.writeSessionBinary(this.sessionId, api.bytesToBase64(bytes)),
    });
    for (const bytes of this.held ?? []) transfer.consume(bytes);
    this.held = null;
    this.transfer = transfer;
    return transfer;
  }

  /** The transfer is over: the stream is the terminal's again. */
  private settle(transfer: XmodemTransfer) {
    if (this.transfer !== transfer) return;
    this.transfer = null;
    const rest = transfer.leftover();
    if (rest.length > 0 && !this.disposed) this.callbacks.toTerminal(rest);
  }

  private reportFailure(label: string, error: unknown) {
    if (this.disposed) return;
    if (error instanceof TransferCanceled) {
      this.report(`${label}: ${error.message}`, "success");
    } else {
      this.report(`${label} failed: ${errorMessage(error)}`, "error");
    }
  }

  private report(message: string, kind: TransferNoticeKind = "active") {
    if (this.disposed) return;
    this.callbacks.onStatus(message, kind === "error");
    this.callbacks.onNotice(message, kind);
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

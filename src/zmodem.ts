import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import Zmodem, {
  type Detection,
  type Offer,
  type ReceiveSession,
  type SendSession,
  type Session,
} from "zmodem.js";

import * as api from "./api";
import {
  BufferedFileWriter,
  concatBytes,
  errorMessage,
  FILE_CHUNK_SIZE,
  formatBytes,
  formatProgress,
  withTimeout,
  type TransferCallbacks,
  type TransferNoticeKind,
} from "./terminalTransfer";

const OUTBOUND_FLUSH_SIZE = 1024 * 1024;
const PEER_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Intercepts a terminal's raw output long enough to detect and run ZMODEM.
 * Ordinary bytes are handed straight back to xterm by the Sentry. File I/O is
 * delegated to Rust in fixed-size chunks so neither uploads nor downloads need
 * to fit in the WebView's memory.
 */
export class ZmodemController {
  private readonly sentry: InstanceType<typeof Zmodem.Sentry>;
  private disposed = false;
  private failed = false;
  private activeSession: Session | null = null;
  private suppressInitialTerminalBytes = false;

  private outboundParts: Uint8Array[] = [];
  private outboundLength = 0;
  private outboundFlushScheduled = false;
  private outboundQueue: Promise<void> = Promise.resolve();
  private outboundError: unknown = null;

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TransferCallbacks,
  ) {
    this.sentry = new Zmodem.Sentry({
      to_terminal: (bytes) => {
        if (!this.disposed && bytes.length > 0) {
          if (this.suppressInitialTerminalBytes) {
            this.suppressInitialTerminalBytes = false;
            this.hideInitialHandshake(Uint8Array.from(bytes));
          } else {
            this.callbacks.toTerminal(Uint8Array.from(bytes));
          }
        }
      },
      sender: (bytes) => this.queueOutbound(bytes),
      on_detect: (detection) => this.confirmDetection(detection),
      on_retract: () => undefined,
    });
  }

  consume(bytes: Uint8Array) {
    if (this.disposed || bytes.length === 0) return;
    try {
      this.sentry.consume(bytes);
    } catch (error) {
      this.failSession(this.activeSession, error);
    }
  }

  isActive(): boolean {
    return this.activeSession !== null;
  }

  cancel(): boolean {
    const session = this.activeSession;
    if (!session) return false;

    this.failed = true;
    this.report("ZMODEM: transfer canceled", "success");
    try {
      session.abort();
    } catch {
      this.activeSession = null;
    }
    this.flushOutbound();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.outboundParts = [];
    this.outboundLength = 0;
  }

  private confirmDetection(detection: Detection) {
    if (this.disposed || this.activeSession || !detection.is_valid()) {
      detection.deny();
      return;
    }

    try {
      this.failed = false;
      this.outboundError = null;
      const session = detection.confirm();
      this.activeSession = session;
      // Sentry deliberately echoes the first ZRQINIT/ZRINIT header through
      // to_terminal. Suppress that one callback so xterm does not render the
      // binary header as `**B0000…` text.
      this.suppressInitialTerminalBytes = true;
      session.on("session_end", () => {
        if (this.activeSession === session) this.activeSession = null;
      });

      if (session.type === "receive") {
        this.startReceive(session);
      } else {
        void this.startSend(session).catch((error) =>
          this.failSession(session, error),
        );
      }
    } catch (error) {
      this.failSession(this.activeSession, error);
    }
  }

  private startReceive(session: ReceiveSession) {
    this.report("ZMODEM: waiting for a file offer…");

    let offerQueue = Promise.resolve();
    let received = 0;
    session.on("offer", (offer) => {
      offerQueue = offerQueue
        .then(async () => {
          if (this.disposed || session.has_ended()) return;
          const saved = await this.receiveOffer(session, offer);
          if (saved) received += 1;
        })
        .catch((error) => this.failSession(session, error));
    });
    session.on("session_end", () => {
      void offerQueue.then(() => {
        if (!this.failed && !this.disposed) {
          this.report(
            received > 0
              ? `ZMODEM: received ${received} file${received === 1 ? "" : "s"}`
              : "ZMODEM: receive session ended",
            "success",
          );
        }
      });
    });

    try {
      void session.start();
    } catch (error) {
      this.failSession(session, error);
    }
  }

  private async receiveOffer(
    session: ReceiveSession,
    offer: Offer,
  ): Promise<boolean> {
    const details = offer.get_details();
    const name = safeOfferedName(details.name);
    const reportedSize = validSize(details.size);
    this.report(
      `ZMODEM: ${name} offered${reportedSize === null ? "" : ` (${formatBytes(reportedSize)})`}`,
    );

    const target = await saveDialog({ defaultPath: name });
    if (!target || this.disposed || session.has_ended()) {
      if (!session.has_ended()) void offer.skip();
      if (!this.disposed) this.report(`ZMODEM: skipped ${name}`);
      return false;
    }

    try {
      await api.zmodemCreateFile(target);
    } catch (error) {
      void offer.skip();
      throw error;
    }

    let lastStatusAt = 0;
    const writer = new BufferedFileWriter(
      target,
      (transferred) => {
        const now = performance.now();
        if (now - lastStatusAt < 50 && transferred !== reportedSize) return;
        lastStatusAt = now;
        this.report(
          `ZMODEM receiving ${name}: ${formatProgress(transferred, reportedSize)}`,
        );
      },
      () => {
        try {
          void offer.skip();
        } catch {
          // The peer may have completed the file at the same instant the
          // local write failed. The original disk error is more useful.
        }
      },
    );

    const accepted = offer.accept({
      on_input: (bytes) => writer.push(bytes),
    });
    const result = await Promise.race([
      accepted.then(() => "complete" as const),
      writer.whenFailed.then(() => "failed" as const),
    ]);
    if (result === "failed") throw writer.error;

    const transferred = await writer.finish();
    this.report(
      `ZMODEM received ${name} (${formatBytes(transferred)})`,
    );
    return true;
  }

  private async startSend(session: SendSession) {
    this.report("ZMODEM: choose files to send…");
    const selected = await openDialog({ multiple: true, directory: false });
    if (this.disposed || session.has_ended()) return;

    const paths = selected
      ? Array.isArray(selected)
        ? selected
        : [selected]
      : [];
    if (paths.length === 0) {
      const closing = session.close();
      await this.drainOutbound();
      await withTimeout(
        closing,
        PEER_CONFIRM_TIMEOUT_MS,
        "peer did not close the canceled ZMODEM session",
      );
      this.report("ZMODEM: send canceled", "success");
      return;
    }

    const files = await Promise.all(
      paths.map(async (path) => ({ path, info: await api.zmodemFileInfo(path) })),
    );
    for (const file of files) {
      if (!Number.isSafeInteger(file.info.size)) {
        throw new Error(`${file.info.name} is too large for ZMODEM in this WebView`);
      }
    }

    let bytesRemaining = files.reduce((sum, file) => sum + file.info.size, 0);
    if (!Number.isSafeInteger(bytesRemaining)) {
      throw new Error("the selected ZMODEM batch is too large");
    }

    let sentFiles = 0;
    for (let index = 0; index < files.length; index += 1) {
      if (this.disposed || session.has_ended()) return;
      const { path, info } = files[index];
      const offerResponse = session.send_offer({
        name: info.name,
        size: info.size,
        mtime: info.modified,
        files_remaining: files.length - index,
        bytes_remaining: bytesRemaining,
      });
      await this.drainOutbound();
      const transfer = await offerResponse;

      if (!transfer) {
        this.report(`ZMODEM: peer skipped ${info.name}`);
        bytesRemaining -= info.size;
        continue;
      }
      if (transfer.get_offset() !== 0) {
        throw new Error("resuming a partial ZMODEM upload is not supported");
      }

      let offset = 0;
      if (info.size === 0) {
        const ending = transfer.end();
        await this.drainOutbound();
        this.report(`ZMODEM finalizing ${info.name}: waiting for peer confirmation…`);
        await withTimeout(
          ending,
          PEER_CONFIRM_TIMEOUT_MS,
          `peer did not confirm ${info.name}`,
        );
      } else {
        while (offset < info.size) {
          if (this.disposed || session.has_ended()) return;
          const requested = Math.min(FILE_CHUNK_SIZE, info.size - offset);
          const encoded = await api.zmodemReadChunk(path, offset, requested);
          const bytes = api.base64ToBytes(encoded);
          if (bytes.length === 0) {
            throw new Error(`${info.name} ended before its reported size`);
          }

          const final = offset + bytes.length >= info.size;
          if (final) {
            const ending = transfer.end(bytes);
            offset += bytes.length;
            await this.drainOutbound();
            this.report(
              `ZMODEM finalizing ${info.name}: ${formatProgress(offset, info.size)} · waiting for peer confirmation…`,
            );
            await withTimeout(
              ending,
              PEER_CONFIRM_TIMEOUT_MS,
              `peer did not confirm ${info.name}`,
            );
          } else {
            transfer.send(bytes);
            offset += bytes.length;
            await this.drainOutbound();
          }
          this.report(
            `ZMODEM sending ${info.name}: ${formatProgress(offset, info.size)}`,
          );
        }
      }

      sentFiles += 1;
      bytesRemaining -= info.size;
      this.report(
        `ZMODEM sent ${info.name} (${formatBytes(info.size)})`,
      );
    }

    const closing = session.close();
    await this.drainOutbound();
    await withTimeout(
      closing,
      PEER_CONFIRM_TIMEOUT_MS,
      "peer did not close the ZMODEM session",
    );
    if (!this.failed && !this.disposed) {
      this.report(
        `ZMODEM: sent ${sentFiles} file${sentFiles === 1 ? "" : "s"}`,
        "success",
      );
    }
  }

  private queueOutbound(bytes: number[] | Uint8Array) {
    if (this.disposed || bytes.length === 0) return;
    const copy = Uint8Array.from(bytes);
    this.outboundParts.push(copy);
    this.outboundLength += copy.length;

    if (this.outboundLength >= OUTBOUND_FLUSH_SIZE) {
      this.flushOutbound();
    } else if (!this.outboundFlushScheduled) {
      this.outboundFlushScheduled = true;
      queueMicrotask(() => {
        this.outboundFlushScheduled = false;
        this.flushOutbound();
      });
    }
  }

  private flushOutbound() {
    if (this.disposed || this.outboundLength === 0) return;
    const bytes = concatBytes(this.outboundParts, this.outboundLength);
    this.outboundParts = [];
    this.outboundLength = 0;

    this.outboundQueue = this.outboundQueue.then(async () => {
      if (this.outboundError || this.disposed) return;
      try {
        await api.writeSessionBinary(this.sessionId, api.bytesToBase64(bytes));
      } catch (error) {
        this.outboundError = error;
        this.failSession(this.activeSession, error);
      }
    });
  }

  private async drainOutbound() {
    this.outboundFlushScheduled = false;
    this.flushOutbound();
    await this.outboundQueue;
    if (this.outboundError) throw this.outboundError;
  }

  private failSession(session: Session | null, error: unknown) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    const message = errorMessage(error);
    this.report(`ZMODEM failed: ${message}`, "error");

    if (session && !session.has_ended()) {
      try {
        session.abort();
      } catch {
        // Preserve the original protocol, transport, or filesystem error.
      }
    }
    this.flushOutbound();
  }

  private report(message: string, kind: TransferNoticeKind = "active") {
    this.callbacks.onStatus(message, kind === "error");
    this.callbacks.onNotice(message, kind);
  }

  private hideInitialHandshake(bytes: Uint8Array) {
    const marker = findSubarray(bytes, [42, 42, 24, 66, 48]);
    if (marker >= 0) {
      let prefixEnd = 0;
      for (let index = marker - 1; index >= 0; index -= 1) {
        if (bytes[index] === 10 || bytes[index] === 13) {
          prefixEnd = index + 1;
          break;
        }
      }
      if (prefixEnd > 0) {
        this.callbacks.toTerminal(bytes.slice(0, prefixEnd));
      }
    }

    // If a header was split across backend reads, its first bytes may already
    // have reached xterm before Sentry could recognize it. Clear that partial
    // current line as well as dropping this callback's remaining bytes.
    this.callbacks.toTerminal(Uint8Array.from([13, 27, 91, 50, 75]));
  }
}

function findSubarray(haystack: Uint8Array, needle: number[]): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function safeOfferedName(offered: string): string {
  const leaf = offered.split(/[\\/]/).pop() ?? "";
  let safe = leaf
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
    safe = `_${safe}`;
  }
  return safe && safe !== "." && safe !== ".." ? safe : "zmodem-download";
}

function validSize(size: number | null | undefined): number | null {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0
    ? size
    : null;
}

import { describe, expect, it } from "vitest";

import {
  buildBlock,
  checksum,
  crc16,
  PeerCanceled,
  TransferCanceled,
  XmodemTransfer,
  type XmodemBlockSize,
  type XmodemLink,
  type XmodemSource,
  type XmodemTiming,
} from "./xmodem";

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const C = 0x43;

/**
 * Real time, but short: every wait in a test is a real wait. Generous
 * enough that a slow test runner does not trip a timeout the test did not
 * mean to exercise.
 */
const FAST: XmodemTiming = {
  crcRequestMs: 30,
  crcRequests: 3,
  blockMs: 150,
  interByteMs: 100,
  purgeQuietMs: 20,
  crcProbeMs: 30,
  handshakeMs: 150,
};

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = state >> 16;
  }
  return out;
}

function source(data: Uint8Array): XmodemSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
  };
}

class Collector {
  readonly parts: Uint8Array[] = [];
  write(chunk: Uint8Array) {
    this.parts.push(Uint8Array.from(chunk));
  }
  get data(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Two transfers joined by an in-memory line. `tamper` may rewrite or drop
 * (return null) what one side sends before the other sees it; every byte
 * that crosses is recorded per direction for the assertions.
 */
class Wire {
  readonly sender: XmodemTransfer;
  readonly receiver: XmodemTransfer;
  readonly toReceiver: Uint8Array[] = [];
  readonly toSender: Uint8Array[] = [];
  tamper: {
    toReceiver?: (chunk: Uint8Array, index: number) => Uint8Array | null;
    toSender?: (chunk: Uint8Array, index: number) => Uint8Array | null;
  } = {};

  constructor(
    senderTiming: Partial<XmodemTiming> = {},
    receiverTiming: Partial<XmodemTiming> = {},
  ) {
    let toReceiverCount = 0;
    let toSenderCount = 0;
    const senderLink: XmodemLink = {
      send: async (chunk) => {
        await tick();
        const index = toReceiverCount;
        toReceiverCount += 1;
        this.toReceiver.push(chunk);
        const delivered = this.tamper.toReceiver
          ? this.tamper.toReceiver(chunk, index)
          : chunk;
        if (delivered) this.receiver.consume(Uint8Array.from(delivered));
      },
    };
    const receiverLink: XmodemLink = {
      send: async (chunk) => {
        await tick();
        const index = toSenderCount;
        toSenderCount += 1;
        this.toSender.push(chunk);
        const delivered = this.tamper.toSender
          ? this.tamper.toSender(chunk, index)
          : chunk;
        if (delivered) this.sender.consume(Uint8Array.from(delivered));
      },
    };
    this.sender = new XmodemTransfer(senderLink, { ...FAST, ...senderTiming });
    this.receiver = new XmodemTransfer(receiverLink, {
      ...FAST,
      ...receiverTiming,
    });
  }

  /** The header byte of every block the receiver was sent, in order. */
  blockHeaders(): number[] {
    return this.toReceiver
      .filter((chunk) => chunk[0] === SOH || chunk[0] === STX)
      .map((chunk) => chunk[0]);
  }

  /** The single control bytes the sender was sent, in order. */
  replies(): number[] {
    return this.toSender.filter((chunk) => chunk.length === 1).map((chunk) => chunk[0]);
  }
}

function padded(data: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total).fill(0x1a);
  out.set(data);
  return out;
}

describe("XMODEM framing", () => {
  it("computes CRC-16/XMODEM and the arithmetic checksum", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc16(check)).toBe(0x31c3);
    expect(crc16(new Uint8Array(0))).toBe(0);
    expect(checksum(Uint8Array.from([0xff, 0x01, 0x02]))).toBe(0x02);
  });

  it("builds padded blocks with the sequence complement and check bytes", () => {
    const data = Uint8Array.from([1, 2, 3]);
    const crc = buildBlock(1, data, 128, "crc");
    expect(crc.length).toBe(133);
    expect([...crc.subarray(0, 6)]).toEqual([SOH, 1, 0xfe, 1, 2, 3]);
    expect(crc[6]).toBe(0x1a);
    expect(crc[130]).toBe(0x1a);
    expect((crc[131] << 8) | crc[132]).toBe(crc16(crc.subarray(3, 131)));

    const sum = buildBlock(255, data, 1024, "checksum");
    expect(sum.length).toBe(1028);
    expect([...sum.subarray(0, 3)]).toEqual([STX, 255, 0]);
    expect(sum[1027]).toBe(checksum(sum.subarray(3, 1027)));
  });
});

describe("XMODEM transfer", () => {
  it("moves a file in CRC mode with 128-byte blocks and ^Z padding", async () => {
    const wire = new Wire();
    const file = bytes(1000);
    const sink = new Collector();
    const progress: number[] = [];

    const [, received] = await Promise.all([
      wire.sender.send(source(file), 128, (sent) => progress.push(sent)),
      wire.receiver.receive(sink),
    ]);

    expect(received).toBe(1024);
    expect(sink.data).toEqual(padded(file, 1024));
    expect(wire.blockHeaders()).toEqual(new Array(8).fill(SOH));
    expect(wire.replies()[0]).toBe(C);
    expect(wire.replies().filter((byte) => byte === NAK)).toEqual([]);
    expect(wire.toReceiver[wire.toReceiver.length - 1]).toEqual(Uint8Array.of(EOT));
    expect(progress[progress.length - 1]).toBe(1000);
    // A CRC block reads its second check byte at once: no probe wait, no
    // padding beyond the last block.
    expect(wire.toReceiver.filter((chunk) => chunk[0] === SOH).every((chunk) => chunk.length === 133)).toBe(true);
  });

  it("uses 1K blocks and finishes a short tail in 128-byte blocks, as sx -k does", async () => {
    const wire = new Wire();
    const file = bytes(2500, 7);
    const sink = new Collector();

    await Promise.all([
      wire.sender.send(source(file), 1024),
      wire.receiver.receive(sink),
    ]);

    // 2500 = 1024 + 1024 + 452; the 452-byte tail is under 896 bytes, so it
    // goes as four 128-byte blocks (512 bytes) rather than one 1K block.
    expect(wire.blockHeaders()).toEqual([STX, STX, SOH, SOH, SOH, SOH]);
    expect(sink.data).toEqual(padded(file, 2560));
  });

  it("sends an empty file as a bare EOT", async () => {
    const wire = new Wire();
    const sink = new Collector();
    const [, received] = await Promise.all([
      wire.sender.send(source(new Uint8Array(0)), 128),
      wire.receiver.receive(sink),
    ]);
    expect(received).toBe(0);
    expect(wire.blockHeaders()).toEqual([]);
  });

  it("resends a block the receiver rejected as corrupt", async () => {
    const wire = new Wire();
    const file = bytes(300, 3);
    const sink = new Collector();
    let corrupted = 0;
    wire.tamper.toReceiver = (chunk) => {
      if (chunk[0] === SOH && chunk[1] === 2 && corrupted === 0) {
        corrupted += 1;
        const bad = Uint8Array.from(chunk);
        bad[10] ^= 0xff;
        return bad;
      }
      return chunk;
    };

    await Promise.all([
      wire.sender.send(source(file), 128),
      wire.receiver.receive(sink),
    ]);

    expect(corrupted).toBe(1);
    expect(sink.data).toEqual(padded(file, 384));
    expect(wire.replies()).toContain(NAK);
    // Block 2 went twice; the file has three blocks.
    expect(wire.blockHeaders()).toEqual([SOH, SOH, SOH, SOH]);
  });

  it("repeats a block whose ACK was lost, which the receiver then ignores", async () => {
    // The receiver waits longer than the sender, so only the sender acts on
    // the silence: it repeats the block, and the receiver, which already has
    // it, acknowledges it again without writing it twice.
    const wire = new Wire({}, { blockMs: FAST.blockMs * 4 });
    const file = bytes(300, 5);
    const sink = new Collector();
    let dropped = 0;
    let acks = 0;
    wire.tamper.toSender = (chunk) => {
      if (chunk.length === 1 && chunk[0] === ACK) {
        acks += 1;
        if (acks === 2 && dropped === 0) {
          dropped += 1;
          return null;
        }
      }
      return chunk;
    };

    await Promise.all([
      wire.sender.send(source(file), 128),
      wire.receiver.receive(sink),
    ]);

    expect(dropped).toBe(1);
    expect(sink.data).toEqual(padded(file, 384));
    expect(wire.blockHeaders()).toEqual([SOH, SOH, SOH, SOH]);
  });

  it("gives up after the peer cancels", async () => {
    const wire = new Wire();
    const file = bytes(1000, 9);
    const sink = new Collector();
    let seen = 0;
    wire.tamper.toReceiver = (chunk) => {
      if (chunk[0] === SOH) {
        seen += 1;
        if (seen === 3) wire.receiver.cancel("stop");
      }
      return chunk;
    };

    const results = await Promise.allSettled([
      wire.sender.send(source(file), 128),
      wire.receiver.receive(sink),
    ]);
    await tick();

    expect(results[0].status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(PeerCanceled);
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TransferCanceled);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("stop");
    // The canceling side sent CANs; the side that was canceled did not.
    expect(wire.toSender.some((chunk) => chunk[0] === CAN)).toBe(true);
    expect(wire.toReceiver.some((chunk) => chunk[0] === CAN)).toBe(false);
  });

  it("fails the sender when no receiver ever asks for the file", async () => {
    const wire = new Wire();
    await expect(wire.sender.send(source(bytes(10)), 128)).rejects.toThrow(
      /no receiver asked/,
    );
    await tick();
    expect(wire.toReceiver.some((chunk) => chunk[0] === CAN)).toBe(true);
  });

  it("stops on abandon without telling the peer", async () => {
    const wire = new Wire();
    const pending = wire.receiver.receive(new Collector());
    await tick();
    wire.receiver.abandon("the session ended");
    await expect(pending).rejects.toThrow("the session ended");
    await tick();
    expect(wire.toSender.some((chunk) => chunk[0] === CAN)).toBe(false);
  });
});

/** A sender that predates XMODEM-CRC: it ignores `C` and answers only NAK. */
function checksumOnlySender(
  file: Uint8Array,
  onSend: (chunk: Uint8Array) => void,
): { consume: (chunk: Uint8Array) => void; log: number[] } {
  const log: number[] = [];
  let block = 0;
  let sentEot = false;
  const blocks = Math.ceil(file.length / 128);
  const sendNext = () => {
    if (block >= blocks) {
      sentEot = true;
      onSend(Uint8Array.of(EOT));
      return;
    }
    const data = file.subarray(block * 128, (block + 1) * 128);
    onSend(buildBlock(block + 1, data, 128, "checksum"));
  };
  return {
    log,
    consume: (chunk) => {
      for (const byte of chunk) {
        log.push(byte);
        if (sentEot) continue;
        if (byte === NAK) {
          sendNext();
        } else if (byte === ACK) {
          block += 1;
          sendNext();
        }
      }
    },
  };
}

/** A receiver in a bootloader that wants CRC 1K blocks and sends `C`. */
function crcReceiver(onSend: (chunk: Uint8Array) => void) {
  const out = new Collector();
  let pending = new Uint8Array(0);
  let expected = 1;
  const consume = (chunk: Uint8Array) => {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    for (;;) {
      if (pending.length === 0) return;
      if (pending[0] === EOT) {
        pending = pending.subarray(1);
        onSend(Uint8Array.of(ACK));
        continue;
      }
      const size = pending[0] === STX ? 1024 : 128;
      const total = 3 + size + 2;
      if (pending.length < total) return;
      const block = pending.subarray(0, total);
      pending = pending.subarray(total);
      const data = block.subarray(3, 3 + size);
      const crc = (block[3 + size] << 8) | block[4 + size];
      if (block[1] === expected && crc16(data) === crc) {
        out.write(data);
        expected = (expected + 1) & 0xff;
        onSend(Uint8Array.of(ACK));
      } else {
        onSend(Uint8Array.of(NAK));
      }
    }
  };
  return { out, consume };
}

describe("XMODEM interoperability", () => {
  it("receives from a checksum-only sender after the C requests go unanswered", async () => {
    const file = bytes(200, 11);
    const receiver = new XmodemTransfer(
      { send: async (chunk) => { await tick(); peer.consume(chunk); } },
      FAST,
    );
    const peer = checksumOnlySender(file, (chunk) => receiver.consume(chunk));
    const sink = new Collector();

    const received = await receiver.receive(sink);

    expect(received).toBe(256);
    expect(sink.data).toEqual(padded(file, 256));
    expect(peer.log.slice(0, FAST.crcRequests)).toEqual(new Array(FAST.crcRequests).fill(C));
    expect(peer.log[FAST.crcRequests]).toBe(NAK);
    // Every block was accepted on the first try: the mode was read off the
    // block itself, so the checksum sender never saw a spurious NAK.
    expect(peer.log.filter((byte) => byte === NAK)).toHaveLength(1);
  });

  it("sends 1K CRC blocks to a receiver that opens with C", async () => {
    const file = bytes(3000, 13);
    const sender = new XmodemTransfer(
      { send: async (chunk) => { await tick(); peer.consume(chunk); } },
      FAST,
    );
    const peer = crcReceiver((chunk) => sender.consume(chunk));
    // The receiver has been asking for a while: two requests are already
    // waiting when the sender starts, as after a file dialog.
    sender.consume(Uint8Array.of(C));
    sender.consume(Uint8Array.of(C));

    await sender.send(source(file), 1024 as XmodemBlockSize);

    // 3000 = 1024 + 1024 + 952; the 952-byte tail exceeds 896, so it goes
    // as one 1K block, padded.
    expect(peer.out.data).toEqual(padded(file, 3072));
  });

  it("falls back to 128-byte blocks for a receiver that asks for checksums", async () => {
    const file = bytes(400, 17);
    const headers: number[] = [];
    const sender = new XmodemTransfer(
      {
        send: async (chunk) => {
          await tick();
          if (chunk[0] === SOH || chunk[0] === STX) headers.push(chunk[0]);
          if (chunk[0] === SOH && checksum(chunk.subarray(3, 131)) === chunk[131]) {
            sender.consume(Uint8Array.of(ACK));
          } else if (chunk[0] === EOT) {
            sender.consume(Uint8Array.of(ACK));
          } else {
            sender.consume(Uint8Array.of(NAK));
          }
        },
      },
      FAST,
    );
    sender.consume(Uint8Array.of(C, NAK));

    await sender.send(source(file), 1024);

    expect(headers).toEqual([SOH, SOH, SOH, SOH]);
  });

  it("rejects a YMODEM batch header instead of saving it as data", async () => {
    const sent: Uint8Array[] = [];
    const receiver = new XmodemTransfer(
      {
        send: async (chunk) => {
          await tick();
          sent.push(chunk);
          if (chunk[0] === C) {
            receiver.consume(buildBlock(0, new TextEncoder().encode("name\x00123"), 128, "crc"));
          }
        },
      },
      FAST,
    );

    await expect(receiver.receive(new Collector())).rejects.toThrow(/YMODEM/);
    await tick();
    expect(sent.some((chunk) => chunk[0] === CAN)).toBe(true);
  });
});

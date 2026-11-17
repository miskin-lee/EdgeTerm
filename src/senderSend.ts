import * as api from "./api";
import type { SendUnit } from "./senderUnits";
import { getController } from "./terminalRegistry";
import { getTmux } from "./tmuxRegistry";
import type { LineEnding } from "./types";

// The Sender's write path, shared by the panel's Run button and the repeat
// schedule (`senderSchedule.ts`). A script goes to a session one line at a
// time: a line the terminal can track (it has a line ending and the shell
// is at a prompt) is followed only once its prompt is back, so `cd` and a
// slow command are done before the next line arrives, instead of the whole
// script landing as typeahead that a password prompt or a pager would eat.

/**
 * Pause between lines the terminal cannot track — no line ending, an
 * agentic CLI holding the terminal, a serial device without a shell — the
 * way a paste is paced for such a device.
 */
export const LINE_GAP_MS = 100;
/**
 * Longest wait for a tracked line's prompt before the next line goes
 * anyway: a prompt the heuristics never recognise again must not hang the
 * script, and typeahead is what a plain paste would have done from the
 * start.
 */
export const LINE_TIMEOUT_MS = 30_000;

/** Lets a send in progress be abandoned between lines. */
export interface StopSignal {
  readonly stopped: boolean;
  stop(): void;
  readonly promise: Promise<void>;
}

export function newStopSignal(): StopSignal {
  let stopped = false;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      resolve();
    },
    promise,
  };
}

const busy = new Set<string>();

/** Whether a send to the session is still in progress. */
export const isSending = (id: string) => busy.has(id);

export interface SendOutcome {
  sent: string[];
  /** Sessions left out: a file transfer or another send owned them. */
  skipped: string[];
}

/**
 * Writes `units` to each session in `ids`, in order per session and all
 * sessions in parallel. A session with a transfer or a send in progress is
 * skipped rather than interleaved. Rejects with the first write failure.
 */
export async function sendUnits(
  ids: string[],
  units: SendUnit[],
  ending: LineEnding,
  stop: StopSignal,
): Promise<SendOutcome> {
  const sent = ids.filter(
    (id) => !busy.has(id) && !getController(id)?.isTransferActive(),
  );
  const skipped = ids.filter((id) => !sent.includes(id));
  for (const id of sent) busy.add(id);
  try {
    await Promise.all(sent.map((id) => sendSequence(id, units, ending, stop)));
  } finally {
    for (const id of sent) busy.delete(id);
  }
  return { sent, skipped };
}

async function sendSequence(
  id: string,
  units: SendUnit[],
  ending: LineEnding,
  stop: StopSignal,
): Promise<void> {
  const tmux = getTmux(id);
  const pane = tmux?.snapshot()?.activePane;
  const target = pane && tmux ? tmux.paneControllerId(pane) : id;
  for (let index = 0; index < units.length; index += 1) {
    if (stop.stopped) return;
    const unit = units[index];
    const controller = getController(target);
    // Told before the write so the prompt on screen becomes the completion
    // signature; false when the terminal cannot track this line.
    const tracked =
      ending !== "none" &&
      controller !== undefined &&
      controller.noteCommandSent(unit);
    try {
      if (pane && tmux) await tmux.writePane(pane, unit);
      else await api.writeSession(id, unit);
    } catch (error) {
      if (tracked) controller.cancelCommandSent();
      throw error;
    }
    if (index === units.length - 1) return;
    await Promise.race([
      tracked ? controller.waitForCommand(LINE_TIMEOUT_MS) : delay(LINE_GAP_MS),
      stop.promise,
    ]);
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

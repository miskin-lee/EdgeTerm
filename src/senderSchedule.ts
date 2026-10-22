import { useSyncExternalStore } from "react";

import { newStopSignal, sendUnits, type StopSignal } from "./senderSend";
import { buildUnits, type SendUnit } from "./senderUnits";
import { useStore } from "./store";
import { isFileSession, type LineEnding } from "./types";

// Repeated sending: one command on a timer, for keeping a session alive
// past a server's idle timeout or running a check every few minutes. The
// schedule lives here, outside the Sender panel, so hiding the panel does
// not stop it; the panel shows and stops whatever is running.

/** Seconds between sends, and how many sends in all (0: until stopped). */
export interface RepeatSettings {
  every: number;
  times: number;
}

export const REPEAT_LIMITS = {
  minEvery: 1,
  maxEvery: 86_400,
  maxTimes: 100_000,
} as const;

const REPEAT_KEY = "edgeterm.senderRepeat";
const DEFAULT_REPEAT: RepeatSettings = { every: 60, times: 0 };

export function clampRepeat(settings: RepeatSettings): RepeatSettings {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
  return {
    every: clamp(settings.every, REPEAT_LIMITS.minEvery, REPEAT_LIMITS.maxEvery),
    times: clamp(settings.times, 0, REPEAT_LIMITS.maxTimes),
  };
}

/** The interval and count used last time; a per-browser convenience. */
export function loadRepeatSettings(): RepeatSettings {
  try {
    const raw = localStorage.getItem(REPEAT_KEY);
    if (!raw) return DEFAULT_REPEAT;
    const parsed = JSON.parse(raw) as Partial<RepeatSettings>;
    return clampRepeat({
      every: Number(parsed.every ?? DEFAULT_REPEAT.every),
      times: Number(parsed.times ?? DEFAULT_REPEAT.times),
    });
  } catch {
    return DEFAULT_REPEAT;
  }
}

export function storeRepeatSettings(settings: RepeatSettings): void {
  try {
    localStorage.setItem(REPEAT_KEY, JSON.stringify(clampRepeat(settings)));
  } catch {
    // Storage may be unavailable; the values still apply for this run.
  }
}

export interface ScheduleSpec {
  text: string;
  ending: LineEnding;
  /**
   * `all` resolves the open terminal sessions at every tick; `current`
   * pins the session that was active when the schedule started.
   */
  target: "current" | "all";
  sessionId: string | null;
  /** Seconds between sends. */
  every: number;
  /** Sends in all, 0 for until stopped. */
  times: number;
}

export interface ScheduleState {
  spec: ScheduleSpec;
  sent: number;
  /** Unix milliseconds of the next send, null while one is in progress. */
  nextAt: number | null;
}

interface Active {
  state: ScheduleState;
  units: SendUnit[];
  timer: number | null;
  stop: StopSignal;
}

let active: Active | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeSchedule(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The running schedule; the same object until something about it changes. */
export function getSchedule(): ScheduleState | null {
  return active?.state ?? null;
}

export function useSchedule(): ScheduleState | null {
  return useSyncExternalStore(subscribeSchedule, getSchedule);
}

/** Sessions a tick goes to right now; closed tabs and file sessions are not typed into. */
function targetsOf(spec: ScheduleSpec): { ids: string[]; gone: boolean } {
  const tabs = useStore.getState().tabs;
  if (spec.target === "all") {
    return {
      ids: tabs
        .filter((tab) => !isFileSession(tab.info.kind) && tab.state === "connected")
        .map((tab) => tab.info.id),
      gone: false,
    };
  }
  const tab = tabs.find((candidate) => candidate.info.id === spec.sessionId);
  return {
    ids: tab && tab.state === "connected" ? [tab.info.id] : [],
    gone: tab === undefined,
  };
}

/**
 * Starts sending `spec` on its timer, replacing any schedule running. The
 * first send is immediate. Returns a problem with the command, or null.
 */
export function startSchedule(spec: ScheduleSpec): string | null {
  let units: SendUnit[];
  try {
    units = buildUnits(spec.text, spec.ending);
  } catch (error) {
    return String(error);
  }
  if (units.length === 0) return "enter a command before repeating it";
  if (spec.target === "current" && !spec.sessionId) return "no session selected";

  stopSchedule();
  const entry: Active = {
    state: { spec, sent: 0, nextAt: null },
    units,
    timer: null,
    stop: newStopSignal(),
  };
  active = entry;
  notify();

  const tick = async () => {
    if (active !== entry) return;
    entry.timer = null;
    entry.state = { ...entry.state, nextAt: null };
    notify();

    const { ids, gone } = targetsOf(spec);
    if (gone) {
      stopSchedule();
      return;
    }
    if (ids.length > 0) {
      try {
        await sendUnits(ids, entry.units, spec.ending, entry.stop);
      } catch (error) {
        console.error("Sender:", error);
      }
    }
    if (active !== entry) return;

    const sent = entry.state.sent + 1;
    if (spec.times > 0 && sent >= spec.times) {
      active = null;
      notify();
      return;
    }
    const nextAt = Date.now() + spec.every * 1000;
    entry.state = { spec, sent, nextAt };
    notify();
    entry.timer = window.setTimeout(() => void tick(), spec.every * 1000);
  };
  void tick();
  return null;
}

/** Ends the running schedule, abandoning a send in progress between lines. */
export function stopSchedule(): void {
  const entry = active;
  if (!entry) return;
  active = null;
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.stop.stop();
  notify();
}

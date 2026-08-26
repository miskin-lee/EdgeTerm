import * as api from "./api";
import type { CommandHistoryEntry } from "./api";

const MAX_ENTRIES = 5000;
const MAX_SUGGESTIONS = 8;

/** One row of the completion popup. */
export interface CommandSuggestion {
  command: string;
  /** Where the typed input occurs in the command, for highlighting. */
  matchStart: number;
}

// Score components. Prefix matches outrank substring matches, same-host
// outranks other hosts, and recency (a Unix-ms timestamp, ~2e12) breaks ties;
// the sum stays well inside Number.MAX_SAFE_INTEGER (9e15).
const PREFIX_BONUS = 4e15;
const HOST_BONUS = 2e15;

/**
 * In-memory mirror of the persisted command history, shared by every terminal.
 * Reads are answered from memory on each keystroke; writes update memory
 * immediately and persist through the backend in the background.
 *
 * Suggestion lookup is IDE-style: every entry containing the typed input is a
 * candidate, ranked prefix-first, same-host-first, most-recent-first. The list
 * stays small enough that a linear scan per keystroke is well under a
 * millisecond.
 */
class CommandHistory {
  private entries: CommandHistoryEntry[] = [];
  private loadStarted = false;

  load() {
    if (this.loadStarted) return;
    this.loadStarted = true;
    api.listCommandHistory().then(
      (entries) => {
        this.entries = entries;
      },
      () => {
        // Allow a retry on the next call when the backend was not ready.
        this.loadStarted = false;
      },
    );
  }

  record(command: string, host: string) {
    const existing = this.entries.find(
      (entry) => entry.command === command && entry.host === host,
    );
    if (existing) {
      existing.count += 1;
      existing.lastUsed = Date.now();
    } else {
      this.entries.push({ command, host, count: 1, lastUsed: Date.now() });
      if (this.entries.length > MAX_ENTRIES) {
        let oldest = 0;
        for (let i = 1; i < this.entries.length; i += 1) {
          if (this.entries[i].lastUsed < this.entries[oldest].lastUsed) {
            oldest = i;
          }
        }
        this.entries.splice(oldest, 1);
      }
    }
    void api.recordCommand(command, host).catch(() => undefined);
  }

  suggest(input: string, host: string): CommandSuggestion[] {
    if (!input) return [];
    // The same command may be remembered for several hosts; keep only the
    // best-scoring occurrence of each command text.
    const byCommand = new Map<
      string,
      { score: number; matchStart: number }
    >();
    for (const entry of this.entries) {
      if (entry.command === input) continue;
      const matchStart = entry.command.indexOf(input);
      if (matchStart === -1) continue;
      const score =
        (matchStart === 0 ? PREFIX_BONUS : 0) +
        (entry.host === host ? HOST_BONUS : 0) +
        entry.lastUsed;
      const seen = byCommand.get(entry.command);
      if (!seen || score > seen.score) {
        byCommand.set(entry.command, { score, matchStart });
      }
    }
    return [...byCommand.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_SUGGESTIONS)
      .map(([command, { matchStart }]) => ({ command, matchStart }));
  }

  clear(): Promise<void> {
    this.entries = [];
    return api.clearCommandHistory();
  }
}

export const commandHistory = new CommandHistory();

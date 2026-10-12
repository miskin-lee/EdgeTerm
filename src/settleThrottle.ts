/**
 * Runs `apply` at once and collapses the calls behind it inside `settleMs`
 * into one trailing pass — for work too expensive to run per event, like a
 * terminal resize that reflows the whole buffer. A call inside the window
 * pushes the trailing pass back, so a burst that outlasts the window (a
 * splitter drag) still ends in a single final application.
 */
export function createSettleThrottle<T>(
  apply: () => T,
  settleMs: number,
): {
  /** Applies now, or folds into the trailing pass; null when folded. */
  run: () => T | null;
  /** Drops a pending trailing pass. */
  cancel: () => void;
} {
  let timer: number | null = null;
  let pending = false;
  const settle = () => {
    timer = null;
    if (pending) {
      pending = false;
      apply();
    }
  };
  return {
    run() {
      if (timer !== null) {
        pending = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(settle, settleMs);
        return null;
      }
      const result = apply();
      timer = window.setTimeout(settle, settleMs);
      return result;
    },
    cancel() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}

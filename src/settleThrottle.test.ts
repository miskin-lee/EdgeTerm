import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettleThrottle } from "./settleThrottle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createSettleThrottle", () => {
  it("applies a lone call at once and returns its value", () => {
    const apply = vi.fn(() => 7);
    const throttle = createSettleThrottle(apply, 100);

    expect(throttle.run()).toBe(7);
    expect(apply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst inside the window into one trailing pass", () => {
    const apply = vi.fn(() => 1);
    const throttle = createSettleThrottle(apply, 100);

    expect(throttle.run()).toBe(1);
    for (let index = 0; index < 49; index += 1) {
      expect(throttle.run()).toBeNull();
    }
    expect(apply).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(99);
    expect(apply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("keeps pushing the trailing pass back while calls keep coming", () => {
    // A drag outlasts the window: every call re-arms, so the one trailing
    // pass still lands only after the burst ends.
    const apply = vi.fn(() => 1);
    const throttle = createSettleThrottle(apply, 100);

    throttle.run();
    for (let tick = 1; tick <= 10; tick += 1) {
      vi.advanceTimersByTime(80);
      throttle.run();
      expect(apply).toHaveBeenCalledTimes(1);
    }
    vi.advanceTimersByTime(100);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("applies calls that arrive after the window immediately", () => {
    const apply = vi.fn(() => 1);
    const throttle = createSettleThrottle(apply, 100);

    throttle.run();
    vi.advanceTimersByTime(100);
    throttle.run();
    vi.advanceTimersByTime(100);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending trailing pass", () => {
    const apply = vi.fn(() => 1);
    const throttle = createSettleThrottle(apply, 100);

    throttle.run();
    expect(throttle.run()).toBeNull();
    throttle.cancel();
    vi.advanceTimersByTime(1000);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

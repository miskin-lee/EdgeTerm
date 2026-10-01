// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  hideOverflowTooltip,
  installOverflowTooltip,
  OVERFLOW_TOOLTIP_DELAY_MS,
  truncatedLabel,
} from "./overflowTooltip";

// jsdom does no layout, so a label's widths are set by hand.
function label(text: string, scrollWidth: number, clientWidth = 100) {
  const row = document.createElement("div");
  row.className = "row";
  row.title = "user@example:22";
  const span = document.createElement("span");
  span.style.textOverflow = "ellipsis";
  span.textContent = text;
  Object.defineProperty(span, "scrollWidth", { value: scrollWidth });
  Object.defineProperty(span, "clientWidth", { value: clientWidth });
  row.appendChild(span);
  document.body.appendChild(row);
  return { row, span };
}

const over = (target: Element) =>
  target.dispatchEvent(
    new MouseEvent("pointerover", { bubbles: true }) as PointerEvent,
  );
const out = (target: Element, relatedTarget: Element | null) =>
  target.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget }),
  );
const tip = () => document.querySelector<HTMLElement>(".overflow-tooltip");

beforeAll(() => installOverflowTooltip());

afterEach(() => {
  hideOverflowTooltip();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("truncatedLabel", () => {
  it("finds a label that is cut, from the label or a node inside it", () => {
    const { span } = label("a-very-long-session-name", 240);
    expect(truncatedLabel(span)).toBe(span);
    const inner = document.createElement("b");
    span.appendChild(inner);
    expect(truncatedLabel(inner)).toBe(span);
  });

  it("ignores a label that fits and one with its own tooltip", () => {
    const { span } = label("short", 100);
    expect(truncatedLabel(span)).toBeNull();
    const { row, span: owned } = label("a-very-long-name", 240);
    row.setAttribute("data-own-tooltip", "");
    expect(truncatedLabel(owned)).toBeNull();
  });
});

describe("overflow tooltip", () => {
  it("shows the full text after a pause, with the row's title under it", () => {
    vi.useFakeTimers();
    const { row, span } = label("a-very-long-session-name", 240);
    over(span);
    expect(tip()?.classList.contains("is-visible") ?? false).toBe(false);
    vi.advanceTimersByTime(OVERFLOW_TOOLTIP_DELAY_MS);
    expect(tip()?.classList.contains("is-visible")).toBe(true);
    expect(tip()?.querySelector("div")?.textContent).toBe(
      "a-very-long-session-name",
    );
    expect(tip()?.querySelector("span")?.textContent).toBe("user@example:22");
    // The native tooltip would cover ours: the title is lifted meanwhile.
    expect(row.hasAttribute("title")).toBe(false);

    out(span, row);
    expect(tip()?.classList.contains("is-visible")).toBe(false);
    expect(row.getAttribute("title")).toBe("user@example:22");
  });

  it("is cancelled when the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    const { row, span } = label("a-very-long-session-name", 240);
    over(span);
    out(span, row);
    vi.advanceTimersByTime(OVERFLOW_TOOLTIP_DELAY_MS * 2);
    expect(tip()?.classList.contains("is-visible") ?? false).toBe(false);
  });

  it("hides on a press", () => {
    vi.useFakeTimers();
    const { span } = label("a-very-long-session-name", 240);
    over(span);
    vi.advanceTimersByTime(OVERFLOW_TOOLTIP_DELAY_MS);
    span.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(tip()?.classList.contains("is-visible")).toBe(false);
  });
});

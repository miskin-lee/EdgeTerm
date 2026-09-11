import { describe, expect, it, vi } from "vitest";

// fonts.ts picks its default stacks by build platform, a constant vitest
// does not define.
vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));

import { fontChoices, fontStack } from "./fonts";

describe("fontChoices", () => {
  const system = [
    { name: "Menlo", monospaced: true },
    { name: "Helvetica Neue", monospaced: false },
    { name: "Iosevka Custom", monospaced: true },
  ];

  it("adds the machine's fixed-pitch families to the terminal list", () => {
    expect(fontChoices("mono", ["Menlo", "MyNerdFont"], system)).toEqual([
      "Iosevka Custom",
      "Menlo",
      "MyNerdFont",
    ]);
  });

  it("offers every family for the interface", () => {
    expect(fontChoices("ui", ["Inter"], system)).toEqual([
      "Helvetica Neue",
      "Inter",
      "Iosevka Custom",
      "Menlo",
    ]);
  });

  it("is only the probe until the backend answers", () => {
    expect(fontChoices("mono", ["Menlo"], [])).toEqual(["Menlo"]);
  });
});

describe("fontStack", () => {
  it("puts the chosen family in front of the platform default", () => {
    expect(fontStack("mono", "JetBrains Mono")).toBe(
      "\"JetBrains Mono\", Menlo, Monaco, 'Courier New', monospace",
    );
    expect(fontStack("mono", "")).toBe(
      "Menlo, Monaco, 'Courier New', monospace",
    );
  });
});

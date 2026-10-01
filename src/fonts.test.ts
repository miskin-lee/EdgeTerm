import { describe, expect, it, vi } from "vitest";

// fonts.ts picks its default stacks by build platform, a constant vitest
// does not define.
vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));

import { fontChoices, fontStack, symbolFallbacks } from "./fonts";

describe("fontChoices", () => {
  const system = [
    { name: "Menlo", monospaced: true, symbols: false },
    { name: "Helvetica Neue", monospaced: false, symbols: false },
    { name: "Iosevka Custom", monospaced: true, symbols: false },
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

  it("falls back to the icon families before the generic family", () => {
    expect(fontStack("mono", "", ["Symbols Nerd Font", "MesloLGS NF"])).toBe(
      "Menlo, Monaco, 'Courier New', \"Symbols Nerd Font\", \"MesloLGS NF\", monospace",
    );
    // A chosen Nerd Font is not named twice.
    expect(fontStack("mono", "MesloLGS NF", ["MesloLGS NF"])).toBe(
      "\"MesloLGS NF\", Menlo, Monaco, 'Courier New', monospace",
    );
  });

  it("leads the default faces with the system monospace face", () => {
    expect(fontStack("mono", "", [], "Ubuntu Sans Mono")).toBe(
      "\"Ubuntu Sans Mono\", Menlo, Monaco, 'Courier New', monospace",
    );
    // Behind a chosen family, and never named twice.
    expect(fontStack("mono", "Hack", [], "Ubuntu Sans Mono")).toBe(
      "\"Hack\", \"Ubuntu Sans Mono\", Menlo, Monaco, 'Courier New', monospace",
    );
    expect(fontStack("mono", "Hack", ["Hack", "Symbols Nerd Font"], "Hack")).toBe(
      "\"Hack\", Menlo, Monaco, 'Courier New', \"Symbols Nerd Font\", monospace",
    );
    expect(fontStack("ui", "", [], "Ubuntu Sans Mono")).not.toContain("Ubuntu Sans Mono");
  });

  it("leaves the interface stack without icon fallbacks", () => {
    expect(fontStack("ui", "", ["MesloLGS NF"])).not.toContain("MesloLGS");
  });
});

describe("symbolFallbacks", () => {
  const family = (name: string, symbols: boolean) => ({
    name,
    monospaced: true,
    symbols,
  });

  it("takes the icon families, symbols-only builds first, at most two", () => {
    expect(
      symbolFallbacks([
        family("Hack Nerd Font", true),
        family("Menlo", false),
        family("MesloLGS NF", true),
        family("Symbols Nerd Font Mono", true),
      ]),
    ).toEqual(["Symbols Nerd Font Mono", "Hack Nerd Font"]);
  });

  it("is empty on a machine without any", () => {
    expect(symbolFallbacks([family("Menlo", false)])).toEqual([]);
  });
});

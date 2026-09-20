import { describe, expect, it } from "vitest";

import INDEX from "../index.html?raw";
import { SEMANTIC_BANDS, SEMANTIC_PALETTES } from "./semanticColors";
import STYLES from "./styles.css?raw";
import { THEME_LABELS, isLightTheme, type ThemeMode } from "./types";

const MODES = Object.keys(THEME_LABELS) as ThemeMode[];

// Record<ThemeMode, …> makes the compiler check the palettes a theme is
// looked up in; the stylesheet and the pre-paint script in index.html are
// plain text, and a theme missing from either shows up only at runtime — as
// the dark palette with no warning.
describe("every theme", () => {
  it("has a palette block in the stylesheet", () => {
    for (const mode of MODES) {
      // The dark palette is the :root default the others override.
      if (mode === "dark") continue;
      expect(STYLES, mode).toContain(`:root[data-theme="${mode}"] {`);
    }
  });

  it("declares the color-scheme its canvas needs", () => {
    for (const mode of MODES) {
      if (mode === "dark") continue;
      const block = STYLES.slice(
        STYLES.indexOf(`:root[data-theme="${mode}"] {`),
      );
      const scheme = isLightTheme(mode) ? "light" : "dark";
      expect(block.slice(0, block.indexOf("}")), mode).toContain(
        `color-scheme: ${scheme};`,
      );
    }
  });

  it("is accepted by the first-paint guard in index.html", () => {
    for (const mode of MODES) {
      expect(INDEX, mode).toContain(`"${mode}"`);
    }
  });

  it("colors semantic ranges and bands", () => {
    for (const mode of MODES) {
      expect(SEMANTIC_PALETTES[mode].red, mode).toMatch(/^#[0-9a-f]{6}$/);
      expect(SEMANTIC_BANDS[mode].error, mode).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

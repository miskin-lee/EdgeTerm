import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // themes.test.ts reads the stylesheet as text to check that every
    // ThemeMode has a palette block; without this vitest stubs CSS
    // imports, `?raw` included, with an empty string.
    css: { include: [/styles\.css/] },
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});

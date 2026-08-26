import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const targetIsMac: boolean = process.platform === "darwin";
// @ts-expect-error process is a nodejs global
const targetIsWindows: boolean = process.platform === "win32";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Keyboard shortcuts follow platform-specific flows (⌘ on macOS, Alt
  // elsewhere; see src/shortcuts.ts) and the window chrome differs per
  // platform (see src/components/MenuBar.tsx). Tauri builds the frontend on
  // the target OS, so the platform is fixed at build time and the other
  // platforms' branches are eliminated from the bundle.
  define: {
    __EDGETERM_MAC__: JSON.stringify(targetIsMac),
    __EDGETERM_WINDOWS__: JSON.stringify(targetIsWindows),
  },

  build: {
    // The Material file icons are ~1000 small SVGs; emit them as files instead of
    // inlining a megabyte of base64 into the main bundle.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes("material-icon-theme") ? false : undefined,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

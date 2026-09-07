import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyFonts } from "./fonts";
import { useStore } from "./store";
import "./styles.css";

// The default stacks are picked per platform in fonts.ts (VS Code's editor
// and UI defaults) and the user may put a family of their own in front;
// publish both as --font-mono / --font-ui so CSS and xterm agree on one
// value. Applied before the first render, so the page never paints a frame
// in a font the user replaced.
applyFonts(
  useStore.getState().bufferFontFamily,
  useStore.getState().panelFontFamily,
);

// The WebView's native context menu exposes a Reload action. Reloading only
// resets the React page while the Rust session manager (and serial handles)
// keeps running, leaving invisible sessions behind. EdgeTerm provides its own
// context menus where needed, so suppress the native menu and its common
// keyboard shortcuts entirely.
document.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener(
  "keydown",
  (event) => {
    const reloadShortcut =
      event.key === "F5" ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r");
    if (reloadShortcut) event.preventDefault();
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

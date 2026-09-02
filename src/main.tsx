import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyMonoFontFamily } from "./fonts";
import { loadTheme } from "./store";
import "./styles.css";

// Apply the stored theme before the first paint so a light-theme user never
// sees a dark flash while React mounts.
document.documentElement.dataset.theme = loadTheme();

// The monospace stack is picked per platform in fonts.ts (VS Code's editor
// defaults); publish it as --font-mono so CSS and xterm agree on one value.
applyMonoFontFamily();

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

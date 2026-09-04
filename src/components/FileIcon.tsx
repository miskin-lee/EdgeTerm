import { useEffect, useReducer } from "react";

import type { ThemeMode } from "../types";

// The Material icons ship as ~1000 separate SVG files (see vite.config.ts) that
// the webview requests through Tauri's custom asset protocol. WKWebView does
// not cache those responses, so a plain <img src="tauri://…/icon.svg"> goes
// back through the Rust protocol handler every time a row is (re)created,
// which made large file lists visibly stall. Fetch each icon once, keep it as
// an in-memory blob URL, and hand that to every <img> for the rest of the run.
const sources = new Map<string, string>();
const loading = new Map<string, Promise<void>>();

function loadIconSource(assetUrl: string): Promise<void> {
  const inflight = loading.get(assetUrl);
  if (inflight) return inflight;

  const request = fetch(assetUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(
      (svg) => {
        // Set the type explicitly rather than trusting the protocol handler's
        // Content-Type; an SVG blob with the wrong type renders as nothing.
        const blob = new Blob([svg], { type: "image/svg+xml" });
        sources.set(assetUrl, URL.createObjectURL(blob));
      },
      () => {
        // Fall back to the asset URL so the icon still shows, just uncached.
        sources.set(assetUrl, assetUrl);
      },
    )
    .finally(() => {
      loading.delete(assetUrl);
    });
  loading.set(assetUrl, request);
  return request;
}

// The theme is a megabyte of name-to-icon mapping plus the URL of every SVG
// in it, and nothing needs it until a file list is drawn, so it is fetched
// with the first icon rather than with the window. Once it is here, every row
// resolves its icon synchronously.
let theme: typeof import("../fileIcons") | null = null;
let themeRequest: Promise<void> | null = null;

function loadIconTheme(): Promise<void> {
  return (themeRequest ??= import("../fileIcons").then((module) => {
    theme = module;
  }));
}

function useIconSource(
  name: string,
  isDir: boolean,
  mode: ThemeMode,
): string | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const assetUrl = theme?.fileIconUrl(name, isDir, mode) ?? null;
  const source = assetUrl ? (sources.get(assetUrl) ?? null) : null;

  useEffect(() => {
    if (source) return;
    let active = true;
    void loadIconTheme()
      .then(() => loadIconSource(theme!.fileIconUrl(name, isDir, mode)))
      .then(() => {
        if (active) rerender();
      });
    return () => {
      active = false;
    };
  }, [name, isDir, mode, source]);

  return source;
}

interface Props {
  name: string;
  isDir: boolean;
  theme: ThemeMode;
}

/**
 * Material file / folder icon for a list row. Renders nothing while the icon
 * is being fetched; the wrapping element keeps the 16 px slot so rows do not
 * shift when it arrives.
 */
export function FileIcon({ name, isDir, theme: mode }: Props) {
  const source = useIconSource(name, isDir, mode);
  if (!source) return null;
  return <img src={source} alt="" draggable={false} />;
}

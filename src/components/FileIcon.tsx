import { useEffect, useReducer } from "react";

import type { ThemeMode } from "../types";

// The theme contains the name-to-icon mapping and the SVG markup. Nothing
// needs it until a file list is drawn, so load it with the first icon rather
// than with the window. Once it is here, every row resolves synchronously.
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
  const source = theme?.fileIconSource(name, isDir, mode) ?? null;

  useEffect(() => {
    if (source) return;
    let active = true;
    void loadIconTheme().then(() => {
      if (active) rerender();
    });
    return () => {
      active = false;
    };
  }, [source]);

  return source;
}

interface Props {
  name: string;
  isDir: boolean;
  theme: ThemeMode;
}

/**
 * Material file / folder icon for a list row. The wrapping element keeps the
 * 16 px slot while the lazily loaded theme arrives.
 */
export function FileIcon({ name, isDir, theme: mode }: Props) {
  const source = useIconSource(name, isDir, mode);
  if (!source) return null;
  return <img src={source} alt="" draggable={false} />;
}

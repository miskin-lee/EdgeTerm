// File and folder icons from the VS Code "Material Icon Theme" (PKief), resolved
// the way VS Code resolves a file icon theme: exact file name first, then the
// longest matching extension, then the theme's default file / folder icon.
import {
  file as defaultFileIcon,
  fileExtensions,
  fileNames,
  folder as defaultFolderIcon,
  folderNames,
  light,
} from "material-icon-theme/dist/material-icons.json";

import { isLightTheme, type ThemeMode } from "./types";

// Keep the SVGs in this lazy-loaded module instead of emitting one asset per
// icon. Each icon used by a file list gets one blob URL, shared by its rows;
// <img> keeps the SVG's IDs isolated from those in other icons.
// The `.clone` suffix marks generated colour variants, not part of the name.
// The Filer is a flat list, so expanded "-open" folders are never shown.
const iconMarkup: Record<string, string> = {};
for (const [path, svg] of Object.entries(
  import.meta.glob(
    [
      "/node_modules/material-icon-theme/icons/*.svg",
      "!/node_modules/material-icon-theme/icons/*-open.svg",
    ],
    { eager: true, query: "?raw", import: "default" },
  ) as Record<string, string>,
)) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  iconMarkup[base.replace(/\.svg$/, "").replace(/\.clone$/, "")] = svg;
}

const iconSources = new Map<string, string>();

// VS Code matches names case-insensitively, so lower-case the mapping keys
// once instead of on every lookup.
function lowerKeys(map: Record<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) {
    result.set(key.toLowerCase(), value);
  }
  return result;
}

interface IconMaps {
  fileNames: Map<string, string>;
  fileExtensions: Map<string, string>;
  folderNames: Map<string, string>;
}

const darkMaps: IconMaps = {
  fileNames: lowerKeys(fileNames),
  fileExtensions: lowerKeys(fileExtensions),
  folderNames: lowerKeys(folderNames),
};

const lightMaps: IconMaps = {
  fileNames: lowerKeys(light.fileNames),
  fileExtensions: lowerKeys(light.fileExtensions),
  folderNames: lowerKeys(light.folderNames),
};

function lookupFile(maps: IconMaps, name: string): string | undefined {
  const exact = maps.fileNames.get(name);
  if (exact) return exact;
  // "archive.tar.gz" tries "tar.gz" before "gz", matching VS Code's preference
  // for the most specific extension.
  const segments = name.split(".");
  for (let index = 1; index < segments.length; index++) {
    const icon = maps.fileExtensions.get(segments.slice(index).join("."));
    if (icon) return icon;
  }
  return undefined;
}

function resolveIconName(
  name: string,
  isDir: boolean,
  theme: ThemeMode,
): string {
  const lower = name.toLowerCase();
  if (isDir) {
    return (
      (isLightTheme(theme) ? lightMaps.folderNames.get(lower) : undefined) ??
      darkMaps.folderNames.get(lower) ??
      defaultFolderIcon
    );
  }
  return (
    (isLightTheme(theme) ? lookupFile(lightMaps, lower) : undefined) ??
    lookupFile(darkMaps, lower) ??
    defaultFileIcon
  );
}

/** Blob URL of the Material icon for a file or folder entry. */
export function fileIconSource(
  name: string,
  isDir: boolean,
  theme: ThemeMode,
): string {
  const icon = resolveIconName(name, isDir, theme);
  const key = iconMarkup[icon] ? icon : isDir ? defaultFolderIcon : defaultFileIcon;
  let source = iconSources.get(key);
  if (!source) {
    source = URL.createObjectURL(
      new Blob([iconMarkup[key]], { type: "image/svg+xml" }),
    );
    iconSources.set(key, source);
  }
  return source;
}

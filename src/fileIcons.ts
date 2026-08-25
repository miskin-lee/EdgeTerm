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

import type { ThemeMode } from "./types";

// Every SVG in the theme, keyed by icon name (the `.clone` suffix marks
// generated colour variants and is not part of the icon name). The Filer is a
// flat list, so the expanded "-open" folder variants are never shown.
const iconUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(
  import.meta.glob(
    [
      "/node_modules/material-icon-theme/icons/*.svg",
      "!/node_modules/material-icon-theme/icons/*-open.svg",
    ],
    { eager: true, query: "?url", import: "default" },
  ) as Record<string, string>,
)) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  iconUrls[base.replace(/\.svg$/, "").replace(/\.clone$/, "")] = url;
}

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
      (theme === "light" ? lightMaps.folderNames.get(lower) : undefined) ??
      darkMaps.folderNames.get(lower) ??
      defaultFolderIcon
    );
  }
  return (
    (theme === "light" ? lookupFile(lightMaps, lower) : undefined) ??
    lookupFile(darkMaps, lower) ??
    defaultFileIcon
  );
}

/** URL of the Material icon for a file or folder entry. */
export function fileIconUrl(
  name: string,
  isDir: boolean,
  theme: ThemeMode,
): string {
  return (
    iconUrls[resolveIconName(name, isDir, theme)] ??
    iconUrls[isDir ? defaultFolderIcon : defaultFileIcon]
  );
}

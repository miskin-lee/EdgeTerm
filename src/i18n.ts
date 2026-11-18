/**
 * Minimal interface translation layer.
 *
 * English source text is the key: `t("Import Data…")` returns the translation
 * for the active language, or the English text when a translation is missing.
 * Keeping the source text as the key means untranslated strings never render
 * as placeholder ids and the code stays readable without looking anything up.
 */
import { ZH_CN } from "./i18n.zh";

export type Language = "en" | "zh-CN";

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: "en", name: "English" },
  { id: "zh-CN", name: "简体中文" },
];

const STORAGE_KEY = "edgeterm.language";

function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    // Storage unavailable: fall through to the system language.
  }
  if (typeof navigator !== "undefined" && /^zh/i.test(navigator.language)) {
    return "zh-CN";
  }
  return "en";
}

let language: Language = detectLanguage();

export function getLanguage(): Language {
  return language;
}

/** Persists the choice; the caller is expected to restart the app. */
export function setLanguage(next: Language): void {
  language = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not fatal: the next start falls back to the system language.
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
}

export function initLanguage(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}

/** Translates one interface string; unknown strings fall through as English. */
export function t(text: string): string {
  if (language === "en") return text;
  return ZH_CN[text] ?? text;
}

/** `tf("{n} sessions", { n: 3 })` — `{name}` placeholders are substituted. */
export function tf(text: string, vars: Record<string, string | number>): string {
  return t(text).replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

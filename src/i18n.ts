import { useCallback } from "react";

import { create } from "zustand";

import { zhCN } from "./locales/zh-CN";

/** 界面语言。英文原文即翻译键：en 下 t() 原样返回，其他语言查字典。 */
export type UiLanguage = "en" | "zh-CN";

/** 每种语言的自治名（菜单里不参与翻译）。 */
export const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

const STORAGE_KEY = "edgeterm.uiLanguage";

export const parseUiLanguage = (value: unknown): UiLanguage | null =>
  value === "en" || value === "zh-CN" ? value : null;

/** 无存储值时跟随系统语言（zh 开头选中文，其余英文）；繁体等 zh 变体暂回落简体。 */
const detectUiLanguage = (): UiLanguage => {
  try {
    const preferred = navigator.languages?.[0] ?? navigator.language;
    return (preferred ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  } catch {
    return "en";
  }
};

const loadUiLanguage = (): UiLanguage => {
  try {
    return parseUiLanguage(localStorage.getItem(STORAGE_KEY)) ?? detectUiLanguage();
  } catch {
    return detectUiLanguage();
  }
};

interface I18nState {
  uiLanguage: UiLanguage;
}

/** 同步 <html lang>：屏幕阅读器按界面语言选择语音引擎。 */
const applyDocumentLang = (language: UiLanguage) => {
  document.documentElement.lang = language;
};

// 独立的小 store：语言是唯一数据源，设置导入 / 重置经 setUiLanguage /
// resetUiLanguage 走到这里，组件经 useT 订阅。
const useI18nStore = create<I18nState>()(() => ({ uiLanguage: loadUiLanguage() }));

applyDocumentLang(useI18nStore.getState().uiLanguage);

export const getUiLanguage = (): UiLanguage => useI18nStore.getState().uiLanguage;

/** 语言值的响应式订阅（如菜单里的选中态）。 */
export const useUiLanguage = (): UiLanguage =>
  useI18nStore((s) => s.uiLanguage);

export const setUiLanguage = (language: UiLanguage) => {
  useI18nStore.setState({ uiLanguage: language });
  applyDocumentLang(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // 本次运行内仍然生效；存储不可用时不阻塞。
  }
};

/** 回到默认：跟随系统语言，并清除显式存储值。 */
export const resetUiLanguage = () => {
  const language = detectUiLanguage();
  useI18nStore.setState({ uiLanguage: language });
  applyDocumentLang(language);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上。
  }
};

/** 插值：把 {name} 占位符换成 params 里的值；未提供的占位符原样保留。 */
export const translate = (
  language: UiLanguage,
  key: string,
  params?: Record<string, string | number>,
): string => {
  let text = (language === "zh-CN" ? zhCN[key] : undefined) ?? key;
  if (params) {
    text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match,
    );
  }
  return text;
};

/** 非 React 代码用的即时翻译（瞬态消息，切换语言后不追溯）。 */
export const t = (
  key: string,
  params?: Record<string, string | number>,
): string => translate(getUiLanguage(), key, params);

/** 组件用的响应式 t：语言切换时触发重渲染。 */
export const useT = () => {
  const language = useI18nStore((s) => s.uiLanguage);
  return useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(language, key, params),
    [language],
  );
};

import { describe, expect, it, vi } from "vitest";

// platform.ts 读构建期 define，测试里用固定值代替。
vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));

import { zhCN } from "./locales/zh-CN";
import { PROGRAM_CLIPBOARD_LABELS } from "./osc52";
import { DOCK_LABELS, PANEL_LABELS } from "./panelDock";
import { KIND_LABELS, SESSION_SECTIONS } from "./sessionGroups";
import { SHORTCUT_COMMANDS } from "./shortcuts";
import { THEME_LABELS } from "./types";

// 词典完整性守卫。英文原文即键：漏译的键在英文下静默退化，改版后失配的
// 键则变成无人查阅的死条目。这里对源码与 zh-CN 字典双向对账：
// 1) 源码中 t() 可能收到的每个键（调用点字面量 + 标签常量 + 策划的动态键）
//    必须能在 zhCN 中查到；
// 2) zhCN 中的每个键必须仍以字符串字面量的形式存在于源码中。

// 源码原文；locales 与测试文件不参与：zh-CN.ts 自身含全部键，会把死键洗白，
// 测试里的断言字符串也不承担界面文案的职责。
const sources = Object.values(
  import.meta.glob<string>(
    [
      "/src/**/*.{ts,tsx}",
      "!/src/locales/**",
      "!/src/**/*.test.*",
    ],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ),
);

/** 单引号是否开启字符串：仅在像参数位的位置（前一个有效字符是括号、
 * 逗号、赋值等）才成立，句子里的撇号不算；且必须同行闭合。 */
const opensSingleQuote = (text: string, i: number): boolean => {
  let j = i - 1;
  while (j >= 0 && (text[j] === " " || text[j] === "\t")) j -= 1;
  return j >= 0 && "([{,;=:?<>!&|+-*/%^~".includes(text[j]);
};

/** 剥离行/块注释，保留双/单引号字符串与模板字面量。 */
const stripComments = (text: string): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' || char === "`") {
      const quote = char;
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      out += text.slice(start, i);
    } else if (char === "'" && opensSingleQuote(text, i)) {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== "'" && text[i] !== "\n") {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      if (text[i] === "'") i += 1;
      out += text.slice(start, i);
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 2;
      out += " ";
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
};

const unescapeLiteral = (raw: string): string =>
  raw.replace(/\\(.)/g, (_, char: string) =>
    char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char,
  );

const LITERAL_RE = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g;

const literalsIn = (text: string): string[] =>
  Array.from(text.matchAll(LITERAL_RE), (match) =>
    unescapeLiteral(match[1] ?? match[2]),
  );

/** 每个 t( 调用第一个实参的文本（到顶层逗号或右括号为止），含三元中的键。 */
const tCallArgs = (text: string): string[] => {
  const args: string[] = [];
  for (const match of text.matchAll(/\bt\(/g)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const char = text[i];
      if (char === '"' || char === "`") {
        const quote = char;
        i += 1;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\") i += 1;
          i += 1;
        }
      } else if (char === "'" && opensSingleQuote(text, i)) {
        i += 1;
        while (i < text.length && text[i] !== "'" && text[i] !== "\n") {
          if (text[i] === "\\") i += 1;
          i += 1;
        }
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (char === "," && depth === 1) {
        break;
      }
      i += 1;
    }
    args.push(text.slice(start, i).trim());
  }
  return args;
};

// 经 Record 变量传入 t() 的标签常量：值即键。
const labelConstants: string[] = [
  ...Object.values(THEME_LABELS),
  ...Object.values(PANEL_LABELS),
  ...Object.values(DOCK_LABELS),
  ...Object.values(PROGRAM_CLIPBOARD_LABELS),
  ...Object.values(KIND_LABELS),
  ...SHORTCUT_COMMANDS.flatMap((command) => [command.label, command.hint]),
  ...SESSION_SECTIONS.map((section) => section.label),
];

/** 模块内未导出的标签来源，无法从调用点提取，逐一注明出处。 */
const dynamicKeys: string[] = [
  // SenderPanel 的 LINE_ENDINGS 标签
  "None",
  "LF (\\n)",
  "CRLF (\\r\\n)",
  // DeleteEntryDialog 的条目类别（三元生成）
  "folder",
  "file",
  "link",
  // SessionDialog 的 PROTOCOL_OPTIONS
  "SSH / Telnet",
  "(S)FTP",
  "Shell",
  "Serial",
  "Remote shell",
  "File transfer",
  "Local shell",
  "Device port",
  // SessionPanel 的 POWER_TITLES
  "Disconnect",
  "Connecting…",
  "Reconnect",
  // FilerPanel 的 TRANSFER_LABELS（每种传输的状态）
  "Uploading",
  "Upload complete",
  "Upload failed",
  "Upload cancelled",
  "Downloading",
  "Download complete",
  "Download failed",
  "Download cancelled",
  "Syncing",
  "Synced",
  "Sync failed",
  "Sync cancelled",
  "Copying",
  "Copy complete",
  "Copy failed",
  "Copy cancelled",
  // dataTransfer 的 describe() 计数键
  "1 session",
  "{count} sessions",
  "1 group",
  "{count} groups",
  "1 Sender command",
  "{count} Sender commands",
];

const usedKeys = new Set<string>([...labelConstants, ...dynamicKeys]);
const sourceLiterals = new Set<string>();

for (const raw of sources) {
  const text = stripComments(raw);
  for (const arg of tCallArgs(text)) {
    for (const literal of literalsIn(arg)) usedKeys.add(literal);
  }
  for (const literal of literalsIn(text)) sourceLiterals.add(literal);
}

describe("zh-CN dictionary integrity", () => {
  it("covers every key the source can pass to t()", () => {
    const missing = [...usedKeys].filter((key) => !(key in zhCN));
    expect(missing).toEqual([]);
  });

  it("keeps no dead entries — every zh-CN key exists in the source", () => {
    const dead = Object.keys(zhCN).filter((key) => !sourceLiterals.has(key));
    expect(dead).toEqual([]);
  });

  it("keeps interpolation placeholders intact", () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const [key, value] of Object.entries(zhCN)) {
      expect(
        placeholders(value),
        `zhCN["${key}"] placeholder mismatch`,
      ).toEqual(placeholders(key));
    }
  });
});

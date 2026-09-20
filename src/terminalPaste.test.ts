import { describe, expect, it } from "vitest";

import { needsPasteWarning, pasteLineCount, pasteLines } from "./terminalPaste";

describe("what a paste would submit", () => {
  it("counts the commands a paste runs, not its line breaks", () => {
    expect(pasteLineCount("uptime")).toBe(1);
    // The trailing newline is the Enter the user meant: still one command.
    expect(pasteLineCount("uptime\n")).toBe(1);
    expect(pasteLineCount("uptime\r\n")).toBe(1);
    expect(pasteLineCount("uptime\r")).toBe(1);
    expect(pasteLineCount("cd /etc\nrm -rf nginx\n")).toBe(2);
    // A bare CR submits a line just as LF does.
    expect(pasteLineCount("a\rb\rc")).toBe(3);
    expect(pasteLineCount("")).toBe(0);
    expect(pasteLineCount("\n")).toBe(0);
  });

  it("previews the same lines it counted", () => {
    expect(pasteLines("cd /etc\nls\n")).toEqual(["cd /etc", "ls"]);
    expect(pasteLines("")).toEqual([]);
  });
});

describe("which pastes are confirmed", () => {
  it("lets one command line through, whether or not it ends in Enter", () => {
    expect(needsPasteWarning("systemctl restart nginx")).toBe(false);
    expect(needsPasteWarning("systemctl restart nginx\n")).toBe(false);
    expect(needsPasteWarning("systemctl restart nginx\r\n")).toBe(false);
  });

  it("asks before a paste that would run several commands", () => {
    expect(needsPasteWarning("cd /srv\nrm -rf old\n")).toBe(true);
    // Empty lines in between are Enters too — the shell sees every one.
    expect(needsPasteWarning("uptime\n\n")).toBe(true);
  });

  it("asks before a single line too long to have been read", () => {
    expect(needsPasteWarning("x".repeat(2048))).toBe(false);
    expect(needsPasteWarning("x".repeat(2049))).toBe(true);
  });
});

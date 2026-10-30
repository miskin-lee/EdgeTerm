import { describe, expect, it } from "vitest";

import { buildUnits, firstLine, splitLines } from "./senderUnits";

describe("Sender units", () => {
  it("sends a multi-line command one line at a time, each with the ending", () => {
    expect(buildUnits("cd /var/log\n\ntail -n 5 syslog\r\n", "lf")).toEqual([
      "cd /var/log\n",
      "\n",
      "tail -n 5 syslog\n",
    ]);
    expect(buildUnits("a\nb", "crlf")).toEqual(["a\r\n", "b\r\n"]);
    expect(buildUnits("a\nb", "none")).toEqual(["a", "b"]);
  });

  it("keeps blank lines and each line's whitespace", () => {
    expect(splitLines("\n  indented\n   \n\t\nlast")).toEqual([
      "",
      "  indented",
      "   ",
      "\t",
      "last",
    ]);
    expect(buildUnits("", "lf")).toEqual([]);
    expect(buildUnits("\n\n", "lf")).toEqual(["\n", "\n"]);
  });

  it("preserves the empty answers inside a here-document (#115)", () => {
    const script = "cat <<'EOF'\nn\np\n1\n\n\nt\n8e\nwq\nEOF\n";
    expect(buildUnits(script, "lf")).toEqual([
      "cat <<'EOF'\n",
      "n\n",
      "p\n",
      "1\n",
      "\n",
      "\n",
      "t\n",
      "8e\n",
      "wq\n",
      "EOF\n",
    ]);
  });

  it("counts a trailing newline as the last line's terminator", () => {
    expect(buildUnits("uptime\n", "lf")).toEqual(["uptime\n"]);
    expect(buildUnits("uptime\n\n", "lf")).toEqual(["uptime\n", "\n"]);
    expect(buildUnits("\r\nuptime\r\n\r\n", "crlf")).toEqual([
      "\r\n",
      "uptime\r\n",
      "\r\n",
    ]);
  });

  it("names a command after its first nonblank line", () => {
    expect(firstLine("\nuptime\ndf -h")).toBe("uptime");
    expect(firstLine("\n \t\nuptime\n")).toBe("uptime");
    expect(firstLine("   ")).toBe("   ");
  });
});

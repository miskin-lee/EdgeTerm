import { describe, expect, it } from "vitest";

import {
  createOutputDecoder,
  DEFAULT_ENCODING,
  encodingLabel,
  LOCALE_NAME,
  TERMINAL_ENCODINGS,
} from "./encodings";

describe("terminal encodings", () => {
  it("feeds UTF-8 sessions to xterm undecoded", () => {
    expect(createOutputDecoder(undefined)).toBeNull();
    expect(createOutputDecoder(null)).toBeNull();
    expect(createOutputDecoder("")).toBeNull();
    expect(createOutputDecoder("utf-8")).toBeNull();
    expect(createOutputDecoder(" UTF-8 ")).toBeNull();
    // An alias of UTF-8 in the WHATWG registry.
    expect(createOutputDecoder("unicode-1-1-utf-8")).toBeNull();
  });

  it("treats what the backend treats as UTF-8 the same way", () => {
    // Unknown label, UTF-16, and the "replacement" family: all UTF-8 on
    // the backend (session/encoding.rs), so no decoder here either.
    expect(createOutputDecoder("no-such-encoding")).toBeNull();
    expect(createOutputDecoder("utf-16le")).toBeNull();
    expect(createOutputDecoder("utf-16")).toBeNull();
    expect(createOutputDecoder("hz-gb-2312")).toBeNull();
  });

  it("decodes a legacy encoding across chunk boundaries", () => {
    const decoder = createOutputDecoder("GBK");
    expect(decoder?.encoding).toBe("gbk");
    // 你好 in GBK, split inside the first character.
    const first = decoder!.decode(Uint8Array.from([0x6c, 0x73, 0x20, 0xc4]), {
      stream: true,
    });
    const rest = decoder!.decode(Uint8Array.from([0xe3, 0xba, 0xc3, 0x0d]), {
      stream: true,
    });
    expect(first + rest).toBe("ls 你好\r");
  });

  it("offers labels the webview can decode", () => {
    for (const { label } of TERMINAL_ENCODINGS) {
      if (label === DEFAULT_ENCODING) continue;
      expect(createOutputDecoder(label)?.encoding, label).toBe(label);
    }
    expect(encodingLabel(" Big5 ")).toBe("big5");
    expect(encodingLabel(null)).toBe(DEFAULT_ENCODING);
  });

  it("accepts locale names and nothing else", () => {
    for (const name of ["en_US.UTF-8", "C.UTF-8", "zh_CN.GB18030", "de_DE@euro"]) {
      expect(LOCALE_NAME.test(name), name).toBe(true);
    }
    for (const name of ["", "en US", "en_US.UTF-8; id", "$(id)", "x".repeat(65)]) {
      expect(LOCALE_NAME.test(name), name).toBe(false);
    }
  });
});

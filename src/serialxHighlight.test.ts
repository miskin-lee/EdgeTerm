import { describe, expect, it } from "vitest";

import { serialxLine, serialxRoles, setSerialxTheme } from "./serialxHighlight";
import type { Role } from "./serialxHighlight";

/** The line as it would be colored: each stretch with its role, or null. */
function painted(text: string): [string, Role | null][] {
  const roles = serialxRoles(text);
  const out: [string, Role | null][] = [];
  for (let i = 0; i < text.length; i += 1) {
    const last = out[out.length - 1];
    if (last && last[1] === roles[i]) last[0] += text[i];
    else out.push([text[i], roles[i]]);
  }
  return out;
}

/** Only the colored stretches, for lines where the plain gaps are noise. */
function coloured(text: string): [string, Role][] {
  return painted(text).filter((entry): entry is [string, Role] => !!entry[1]);
}

/** The last stretch; `Array.at` is ES2022 and the tsconfig lib is ES2020. */
const last = (list: [string, Role][]) => list[list.length - 1];

// The cases are serialX's own (src/highlight.rs tests), so a rule that drifts
// from the port's source shows up here rather than on someone's screen.
describe("serialX highlighting", () => {
  it("reads an ESP-IDF line by its parts", () => {
    expect(coloured("I (1234) wifi: connected to 192.168.1.20 in 350ms")).toEqual([
      ["I", "info"],
      ["1234", "uptime"],
      ["wifi", "tag"],
      ["connected", "success"],
      ["192", "ipDigit"],
      [".", "ipSeparator"],
      ["168", "ipDigit"],
      [".", "ipSeparator"],
      ["1", "ipDigit"],
      [".", "ipSeparator"],
      ["20", "ipDigit"],
      ["350", "duration"],
      ["ms", "durationUnit"],
    ]);
    expect(coloured("E (99) main: failed")[0]).toEqual(["E", "error"]);
    expect(coloured("W (99) x: y")[0]).toEqual(["W", "warning"]);
    expect(coloured("D (99) x: y")[0]).toEqual(["D", "debug"]);
    expect(coloured("V (99) x: y")[0]).toEqual(["V", "trace"]);
  });

  it("reads a Zephyr line by its parts", () => {
    const line = coloured("[00:00:01.234,567] <wrn> bt_hci: timeout");
    expect(line[0]).toEqual(["[", "tagBracket"]);
    expect(line[1]).toEqual(["00", "uptime"]);
    expect(line[2]).toEqual([":", "timeSeparator"]);
    expect(line).toContainEqual(["wrn", "warning"]);
    expect(line).toContainEqual(["bt_hci", "tag"]);
    expect(line).toContainEqual(["timeout", "warning"]);
  });

  it("reads severity words in any case", () => {
    expect(coloured("Error: it broke")[0]).toEqual(["Error", "error"]);
    expect(coloured("[WARN] careful")[1]).toEqual(["WARN", "warning"]);
    expect(coloured("debug: x")[0]).toEqual(["debug", "debug"]);
    expect(coloured("Guru Meditation Error: Core 0 panic'ed")[0][1]).toBe("error");
    // Not the middle of another word.
    expect(coloured("errors")).toEqual([]);
  });

  it("splits a time into its parts", () => {
    expect(coloured("2024-03-05T10:20:30.123Z")).toEqual([
      ["2024", "date"],
      ["-", "timeSeparator"],
      ["03", "date"],
      ["-", "timeSeparator"],
      ["05", "date"],
      ["T", "timeSeparator"],
      ["10", "time"],
      [":", "timeSeparator"],
      ["20", "time"],
      [":", "timeSeparator"],
      ["30", "time"],
      [".", "timeSeparator"],
      ["123", "time"],
      ["Z", "zone"],
    ]);
    expect(coloured("at 10:20:30 UTC")[0]).toEqual(["10", "time"]);
    expect(last(coloured("at 10:20:30 UTC"))).toEqual([" UTC", "zone"]);
    expect(coloured("[    1.234567] usb 1-1")[1]).toEqual([
      "    1.234567",
      "uptime",
    ]);
  });

  it("splits a URL into its parts", () => {
    expect(
      coloured("see https://example.com:8080/api/v1?key=abc&n=2 now"),
    ).toEqual([
      ["https", "urlScheme"],
      ["://", "urlSymbol"],
      ["example.com", "urlHost"],
      [":", "urlSymbol"],
      ["8080", "urlHost"],
      ["/", "urlSymbol"],
      ["api", "urlPath"],
      ["/", "urlSymbol"],
      ["v1", "urlPath"],
      ["?", "urlSymbol"],
      ["key", "queryKey"],
      ["=", "urlSymbol"],
      ["abc", "queryValue"],
      ["&", "urlSymbol"],
      ["n", "queryKey"],
      ["=", "urlSymbol"],
      ["2", "queryValue"],
    ]);
    expect(coloured("mail ops@example.org")).toEqual([
      ["ops", "emailName"],
      ["@", "emailSymbol"],
      ["example", "emailDomain"],
      [".", "emailSymbol"],
      ["org", "emailDomain"],
    ]);
  });

  it("shows an address by its shape", () => {
    expect(coloured("mac aa:bb:cc:00:11:22")).toEqual([
      ["aa", "macLetter"],
      [":", "macSeparator"],
      ["bb", "macLetter"],
      [":", "macSeparator"],
      ["cc", "macLetter"],
      [":", "macSeparator"],
      ["00", "macDigit"],
      [":", "macSeparator"],
      ["11", "macDigit"],
      [":", "macSeparator"],
      ["22", "macDigit"],
    ]);
    expect(coloured("at 0x3ffb1a2c")).toEqual([
      ["0x", "hexPrefix"],
      ["3", "hexDigit"],
      ["ffb", "hexLetter"],
      ["1", "hexDigit"],
      ["a", "hexLetter"],
      ["2", "hexDigit"],
      ["c", "hexLetter"],
    ]);
    expect(coloured("fe80::1")[0]).toEqual(["fe", "ipLetter"]);
    const uuid = coloured("id 123e4567-e89b-12d3-a456-426614174000");
    expect(uuid[0]).toEqual(["123", "uuidDigit"]);
    expect(uuid[2]).toEqual(["4567", "uuidDigit"]);
    expect(coloured("rx: DE AD BE EF")).toEqual([
      ["rx", "tag"],
      ["DE", "hexLetter"],
      [" ", "punctuation"],
      ["AD", "hexLetter"],
      [" ", "punctuation"],
      ["BE", "hexLetter"],
      [" ", "punctuation"],
      ["EF", "hexLetter"],
    ]);
    // A Rust path is not an IPv6 address.
    expect(coloured("core::fmt::write")).toEqual([]);
  });

  it("keeps the words inside a place part of it", () => {
    expect(coloured("open /dev/tty.usbserial-1410 failed")).toEqual([
      ["/", "pathSeparator"],
      ["dev", "pathSegment"],
      ["/", "pathSeparator"],
      ["tty.usbserial-1410", "pathSegment"],
      ["failed", "error"],
    ]);
    expect(coloured("assert at main.c:42")).toEqual([
      ["assert", "error"],
      ["main.c", "sourceFile"],
      [":", "punctuation"],
      ["42", "lineNumber"],
    ]);
    // The `error` in a path is part of the path.
    expect(coloured("/var/log/error.log")[5]).toEqual(["error.log", "pathSegment"]);
    expect(coloured("ERROR/WARN")).toEqual([
      ["ERROR", "error"],
      ["WARN", "warning"],
    ]);
  });

  it("steps structure back and values forward", () => {
    expect(coloured('count is "value 42 here" end')).toEqual([
      ['"value ', "quote"],
      ["42", "number"],
      [' here"', "quote"],
    ]);
    expect(coloured("temp=25 ok=true err=null")).toEqual([
      ["temp", "key"],
      ["=", "keySeparator"],
      ["25", "number"],
      ["ok", "key"],
      ["=", "keySeparator"],
      ["true", "true"],
      ["err", "key"],
      ["=", "keySeparator"],
      ["null", "null"],
    ]);
    expect(coloured('{"rssi": -67}')).toEqual([
      ['{"', "punctuation"],
      ["rssi", "jsonKey"],
      ['":', "punctuation"],
      ["-67", "number"],
      ["}", "punctuation"],
    ]);
    expect(coloured("kernel[123]: [main] up")).toEqual([
      ["kernel", "processName"],
      ["[", "processBracket"],
      ["123", "processId"],
      ["]", "processBracket"],
      ["[", "tagBracket"],
      ["main", "tag"],
      ["]", "tagBracket"],
    ]);
  });

  it("splits a quantity from its unit", () => {
    expect(coloured("vbat 3.3V rssi -67dBm temp 25°C")).toEqual([
      ["3.3", "measure"],
      ["V", "measureUnit"],
      ["-67", "measure"],
      ["dBm", "measureUnit"],
      ["25", "measure"],
      ["°C", "measureUnit"],
    ]);
    expect(coloured("free 12 KB of 4MiB, 75% used, fw v1.2.3-rc1")).toEqual([
      ["12", "size"],
      ["KB", "sizeUnit"],
      ["4", "size"],
      ["MiB", "sizeUnit"],
      ["75%", "percent"],
      ["v1.2.3-rc1", "version"],
    ]);
    expect(coloured("took 5s")[0]).toEqual(["5", "duration"]);
    expect(coloured("took 5s")[1]).toEqual(["s", "durationUnit"]);
  });

  it("knows a device's own words", () => {
    expect(coloured('AT+CWJAP="ssid","pw"')[0]).toEqual(["AT+CWJAP", "command"]);
    expect(coloured("+CWJAP:1")[0]).toEqual(["+CWJAP:", "command"]);
    expect(coloured("GPIO12 high, UART1 open")[0]).toEqual(["GPIO12", "peripheral"]);
    expect(coloured("GPIO12 high, UART1 open")[1]).toEqual(["UART1", "peripheral"]);
    expect(coloured("CRC32 mismatch")[0]).toEqual(["CRC32", "checksum"]);
    expect(coloured("OK")).toEqual([["OK", "success"]]);
    expect(coloured("GET /index.html 200")[0]).toEqual(["GET", "httpGet"]);
    expect(coloured("DELETE /item")[0]).toEqual(["DELETE", "httpDelete"]);
    expect(coloured("err=0x103 (ESP_ERR_INVALID_STATE)")[4]).toEqual([
      "ESP_ERR_INVALID_STATE",
      "constant",
    ]);
    // A key named like a level is still a key.
    expect(coloured('{"err": null}')[1]).toEqual(["err", "jsonKey"]);
  });

  it("reads a listing column by column", () => {
    expect(coloured("drwxr-xr-x  3 root root 4096 Aug 19 17:15 ..")).toEqual([
      ["d", "directory"],
      ["r", "permRead"],
      ["w", "permWrite"],
      ["x", "permExec"],
      ["r", "permRead"],
      ["-", "punctuation"],
      ["x", "permExec"],
      ["r", "permRead"],
      ["-", "punctuation"],
      ["x", "permExec"],
      ["3", "number"],
      ["root", "user"],
      ["root", "group"],
      ["4096", "size"],
      ["Aug 19", "date"],
      ["17", "time"],
      [":", "timeSeparator"],
      ["15", "time"],
      ["..", "directory"],
    ]);
    const file = coloured("-rw-r--r-- 1 dietpi dietpi  220 May  9 10:58 .bash_logout");
    expect(file[0]).toEqual(["-", "punctuation"]);
    expect(file).toContainEqual(["dietpi", "user"]);
    expect(file).toContainEqual(["dietpi", "group"]);
    expect(file).toContainEqual(["May  9", "date"]);
    expect(last(file)).toEqual([".bash_logout", "fileName"]);
    expect(
      last(coloured("-rwxr-xr-x 1 root root 220 May  9 10:58 run.sh")),
    ).toEqual(["run.sh", "executable"]);
    const link = coloured("lrwxrwxrwx 1 root root 7 Aug 19  2023 bin -> usr/bin");
    expect(link[0]).toEqual(["l", "symlink"]);
    expect(link).toContainEqual(["2023", "date"]);
    expect(link).toContainEqual(["bin", "symlink"]);
    expect(link).toContainEqual(["->", "punctuation"]);
    expect(last(link)).toEqual(["bin", "pathSegment"]);
    // BusyBox pads its columns wide and a device has a major and minor; a
    // mode string on its own is still read as one.
    const device = coloured("crw-rw-rw-    1 root     root        1,   3 Aug 19 17:15 null");
    expect(device[0]).toEqual(["c", "special"]);
    expect(device).toContainEqual(["1,   3", "size"]);
    expect(last(device)).toEqual(["null", "fileName"]);
    expect(coloured("mode is -rw-r--r-- now")[1]).toEqual(["r", "permRead"]);
  });

  it("reads a prompt and its command line", () => {
    expect(coloured("dietpi@DietPi:~$ ls -la --color=auto")).toEqual([
      ["dietpi", "user"],
      ["@", "emailSymbol"],
      ["DietPi", "host"],
      [":", "punctuation"],
      ["~", "pathSegment"],
      ["$", "prompt"],
      ["-la", "flag"],
      ["--color", "flag"],
      ["=", "keySeparator"],
    ]);
    const prompt = coloured("[root@board ~]# cat /etc/os-release");
    expect(prompt).toContainEqual(["root", "user"]);
    expect(prompt).toContainEqual(["board", "host"]);
    expect(prompt).toContainEqual(["#", "prompt"]);
    expect(last(coloured("sh: foo: command not found"))).toEqual([
      "command not found",
      "error",
    ]);
    // A clock without seconds is a clock; a minus before a digit is not a switch.
    expect(coloured("at 17:35 today")).toEqual([
      ["17", "time"],
      [":", "timeSeparator"],
      ["35", "time"],
    ]);
    expect(coloured("rssi -67")[0]).toEqual(["-67", "number"]);
  });

  it("paints the runs in the ink of the active canvas", () => {
    setSerialxTheme("serialx-dark");
    const dark = serialxLine("GET https://example.com/a 200");
    expect(dark.ranges[0]).toEqual({
      start: 0,
      end: 3,
      color: "#0b0d11",
      background: "#5be49b",
    });
    expect(dark.ranges).toContainEqual({
      start: 12,
      end: 23,
      color: "#82aaff",
      underline: true,
    });
    // No line ever gets a band: serialX tints none.
    expect(dark.band).toBeUndefined();

    setSerialxTheme("serialx-light");
    const light = serialxLine("GET https://example.com/a 200");
    expect(light.ranges[0].color).toBe("#ffffff");
    expect(light.ranges[0].background).toBe("#1f8a4c");
    setSerialxTheme("serialx-dark");
  });
});

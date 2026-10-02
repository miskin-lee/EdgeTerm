import { afterEach, describe, expect, it, vi } from "vitest";

import { fileIconSource } from "./fileIcons";

afterEach(() => vi.unstubAllGlobals());

describe("bundled Material file icons", () => {
  it("creates one SVG blob per icon and shares its URL across file rows", () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:ts")
      .mockReturnValueOnce("blob:light")
      .mockReturnValueOnce("blob:dark");
    vi.stubGlobal("URL", { createObjectURL });

    const first = fileIconSource("first.ts", false, "dark");
    const second = fileIconSource("second.TS", false, "dark");
    expect(first).toBe("blob:ts");
    expect(second).toBe(first);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(createObjectURL.mock.calls[0][0].type).toBe("image/svg+xml");

    const light = fileIconSource("sconstruct", false, "light");
    const dark = fileIconSource("sconstruct", false, "dark");
    expect(light).toBe("blob:light");
    expect(dark).toBe("blob:dark");
    expect(light).not.toBe(dark);
  });
});

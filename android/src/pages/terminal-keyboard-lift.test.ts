import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveKeyboardLiftPx,
  resolveTerminalHeaderTopInsetPx,
} from "./terminal-keyboard-lift";

describe("terminal-keyboard-lift", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 0 when inset is zero", () => {
    expect(resolveKeyboardLiftPx(0, 1000)).toBe(0);
  });

  it("caps reported inset by actual occluded bottom", () => {
    vi.stubGlobal("window", {
      innerHeight: 1000,
      visualViewport: {
        height: 700,
        offsetTop: 0,
      },
    });
    expect(resolveKeyboardLiftPx(500, 1000)).toBe(300);
  });

  it("uses reported inset when visualViewport is absent", () => {
    vi.stubGlobal("window", {
      innerHeight: 1000,
      visualViewport: undefined,
    });
    expect(resolveKeyboardLiftPx(280, 1000)).toBe(280);
  });

  it("resolves non-android header inset from visual viewport", () => {
    vi.stubGlobal("window", {
      visualViewport: { offsetTop: 23 },
    });
    expect(resolveTerminalHeaderTopInsetPx(false)).toBe(23);
    expect(resolveTerminalHeaderTopInsetPx(true)).toBe(16);
  });
});

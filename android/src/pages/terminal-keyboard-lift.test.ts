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


  it("caps lift by portrait safety ratio when visual viewport does not expose occlusion", () => {
    vi.stubGlobal("window", {
      innerWidth: 1080,
      innerHeight: 2000,
      document: {
        documentElement: {
          clientWidth: 1080,
        },
      },
      visualViewport: {
        height: 2000,
        offsetTop: 0,
      },
    });
    // 2000 * 0.6 = 1200
    expect(resolveKeyboardLiftPx(1600, 2000)).toBe(1200);
  });

  it("caps lift by landscape safety ratio when visual viewport does not expose occlusion", () => {
    vi.stubGlobal("window", {
      innerWidth: 2000,
      innerHeight: 1000,
      document: {
        documentElement: {
          clientWidth: 2000,
        },
      },
      visualViewport: {
        height: 1000,
        offsetTop: 0,
      },
    });
    // 1000 * 0.5 = 500
    expect(resolveKeyboardLiftPx(900, 1000)).toBe(500);
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

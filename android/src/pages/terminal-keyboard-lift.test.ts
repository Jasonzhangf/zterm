import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isKeyboardViewportAlreadyResized,
  resolveCurrentLayoutViewportHeight,
  resolveTerminalBottomChromeLiftPx,
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


  it("keeps portrait lift when a reported keyboard inset is present", () => {
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
    // 2000 * 0.45 = 900
    expect(resolveKeyboardLiftPx(1600, 2000)).toBe(900);
  });

  it("keeps landscape lift when a reported keyboard inset is present", () => {
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
    // 1000 * 0.38 = 380
    expect(resolveKeyboardLiftPx(900, 1000)).toBe(380);
  });

  it("normalizes Android physical-pixel keyboard heights before applying lift", () => {
    vi.stubGlobal("window", {
      innerWidth: 393,
      innerHeight: 900,
      devicePixelRatio: 2,
      document: {
        documentElement: {
          clientWidth: 393,
          clientHeight: 900,
        },
      },
      visualViewport: {
        height: 900,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(760, 900)).toBe(380);
  });

  it("does not add lift when WebView has already resized to the keyboard top", () => {
    vi.stubGlobal("window", {
      innerWidth: 1080,
      innerHeight: 620,
      document: {
        documentElement: {
          clientWidth: 1080,
          clientHeight: 620,
        },
      },
      visualViewport: {
        height: 618,
        offsetTop: 2,
      },
    });

    expect(resolveCurrentLayoutViewportHeight()).toBe(620);
    expect(isKeyboardViewportAlreadyResized(320, 900)).toBe(true);
    expect(resolveKeyboardLiftPx(320, 900)).toBe(0);
  });

  it("keeps overlay lift when visual viewport shrinks inside a stable layout viewport", () => {
    vi.stubGlobal("window", {
      innerWidth: 1080,
      innerHeight: 900,
      document: {
        documentElement: {
          clientWidth: 1080,
          clientHeight: 900,
        },
      },
      visualViewport: {
        height: 620,
        offsetTop: 0,
      },
    });

    expect(resolveCurrentLayoutViewportHeight()).toBe(900);
    expect(isKeyboardViewportAlreadyResized(320, 900)).toBe(false);
    expect(resolveKeyboardLiftPx(320, 900)).toBe(280);
  });

  it("ignores tiny visual viewport remainder when the keyboard inset is much larger", () => {
    vi.stubGlobal("window", {
      innerWidth: 712,
      innerHeight: 770,
      devicePixelRatio: 3.25,
      document: {
        documentElement: {
          clientWidth: 711,
          clientHeight: 770,
        },
      },
      visualViewport: {
        height: 770,
        offsetTop: 0,
      },
    });

    expect(resolveCurrentLayoutViewportHeight()).toBe(770);
    expect(isKeyboardViewportAlreadyResized(293, 778)).toBe(false);
    expect(resolveKeyboardLiftPx(293, 778)).toBe(293);
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

  it("does not add bottom chrome lift for normal portrait phone width", () => {
    expect(resolveTerminalBottomChromeLiftPx({
      viewportWidth: 393,
      viewportHeight: 852,
      landscape: false,
    })).toBe(0);
  });

  it("raises foldable portrait bottom chrome above the bottom quick controls", () => {
    expect(resolveTerminalBottomChromeLiftPx({
      viewportWidth: 712,
      viewportHeight: 770,
      landscape: false,
    })).toBe(14);
  });

  it("raises landscape bottom chrome with a compact shell lift", () => {
    expect(resolveTerminalBottomChromeLiftPx({
      viewportWidth: 900,
      viewportHeight: 393,
      landscape: true,
    })).toBe(10);
  });

  it("does not add bottom chrome lift for desktop-like landscape height", () => {
    expect(resolveTerminalBottomChromeLiftPx({
      viewportWidth: 1024,
      viewportHeight: 768,
      landscape: true,
    })).toBe(0);
  });

  it("does not treat a wide short viewport as foldable portrait when orientation input is stale", () => {
    expect(resolveTerminalBottomChromeLiftPx({
      viewportWidth: 1024,
      viewportHeight: 768,
      landscape: false,
    })).toBe(0);
  });
});

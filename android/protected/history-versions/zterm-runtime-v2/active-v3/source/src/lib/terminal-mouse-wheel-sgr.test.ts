
import { describe, expect, it } from "vitest";
import {
  encodeTerminalSgrMouseWheel,
  TERMINAL_WHEEL_UP_BUTTON_CODE,
  TERMINAL_WHEEL_DOWN_BUTTON_CODE,
} from "./terminal-mouse-wheel-sgr";

describe("encodeTerminalSgrMouseWheel", () => {
  it("encodes upward wheel events with button code 64", () => {
    expect(encodeTerminalSgrMouseWheel("up", 10, 5)).toBe(
      `\u001b[<${TERMINAL_WHEEL_UP_BUTTON_CODE};10;5M`,
    );
  });

  it("encodes downward wheel events with button code 65", () => {
    expect(encodeTerminalSgrMouseWheel("down", 1, 1)).toBe(
      `\u001b[<${TERMINAL_WHEEL_DOWN_BUTTON_CODE};1;1M`,
    );
  });

  it("clamps coordinates to 1-based minimum", () => {
    expect(encodeTerminalSgrMouseWheel("up", 0, -3)).toBe(
      "\u001b[<64;1;1M",
    );
  });

  it("caps coordinates to 9999 to avoid pathological encodings", () => {
    expect(encodeTerminalSgrMouseWheel("up", 50000, 50000)).toBe(
      "\u001b[<64;9999;9999M",
    );
  });
});


import { describe, expect, it } from "vitest";
import {
  resolveCopySelectionBuffer,
  terminalBufferCoversRows,
  terminalBufferRowsToPlainText,
} from "./terminal-copy-selection";

const buffer = {
  startIndex: 10,
  lines: [
    [{ char: 65, width: 1 }, { char: 32, width: 1 }, { char: 32, width: 1 }],
    [{ char: 66, width: 1 }],
    [{ char: 67, width: 1 }],
  ],
} as any;

describe("terminal-copy-selection", () => {
  it("detects row coverage", () => {
    expect(terminalBufferCoversRows(buffer, 10, 12)).toBe(true);
    expect(terminalBufferCoversRows(buffer, 9, 12)).toBe(false);
  });

  it("projects selected rows to plain text and trims line-end whitespace", () => {
    expect(terminalBufferRowsToPlainText(buffer, 10, 11)).toBe("A\nB");
    expect(terminalBufferRowsToPlainText(buffer, 11, 10)).toBe("A\nB");
  });

  it("prefers render buffer from store when it covers rows", () => {
    const store = {
      getSnapshot: () => ({ buffer }),
    } as any;
    const sessions = [{ id: "s1", buffer: null } as any];
    expect(resolveCopySelectionBuffer(store, sessions, "s1", 10, 11)).toBe(buffer);
  });

  it("falls back to session buffer when render store does not cover rows", () => {
    const sessionBuffer = { ...buffer, startIndex: 20 } as any;
    const store = {
      getSnapshot: () => ({ buffer: null }),
    } as any;
    const sessions = [{ id: "s1", buffer: sessionBuffer } as any];
    expect(resolveCopySelectionBuffer(store, sessions, "s1", 20, 21)).toBe(sessionBuffer);
  });
});

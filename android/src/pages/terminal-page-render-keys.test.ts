import { describe, expect, it } from "vitest";
import {
  resolveRenderedSessionsInputEpochKey,
  resolveSessionInputEpoch,
  terminalPageActiveRuntimeStatusKey,
  terminalPageHeaderSessionUiKey,
  terminalPageRenderedSessionUiKey,
  toTerminalTabChromeItem,
} from "./terminal-page-render-keys";

const session = {
  id: "s1",
  hostId: "h1",
  connectionName: "conn",
  bridgeHost: "127.0.0.1",
  bridgePort: 8765,
  sessionName: "main",
  customName: "Main",
  resolvedPath: "/tmp",
  state: "connected",
  lastError: "",
} as any;

describe("terminal-page-render-keys", () => {
  it("builds rendered key with host+connection fields", () => {
    expect(terminalPageRenderedSessionUiKey(session)).toBe(
      "s1::h1::conn::127.0.0.1::8765::main::Main::/tmp",
    );
  });

  it("builds header key without hostId/connectionName", () => {
    expect(terminalPageHeaderSessionUiKey(session)).toBe(
      "s1::127.0.0.1::8765::main::Main::/tmp",
    );
  });

  it("builds runtime status key", () => {
    expect(terminalPageActiveRuntimeStatusKey(session)).toBe("s1::connected::");
  });

  it("resolves input epoch keys", () => {
    expect(resolveSessionInputEpoch({ s1: 3 }, "s1")).toBe(3);
    expect(resolveSessionInputEpoch(undefined, null)).toBe(-1);
    expect(resolveRenderedSessionsInputEpochKey({ s1: 3 }, [session])).toBe("s1:3");
  });

  it("projects terminal tab chrome item", () => {
    expect(toTerminalTabChromeItem(session)).toEqual({
      id: "s1",
      bridgeHost: "127.0.0.1",
      bridgePort: 8765,
      sessionName: "main",
      customName: "Main",
      resolvedPath: "/tmp",
    });
  });
});

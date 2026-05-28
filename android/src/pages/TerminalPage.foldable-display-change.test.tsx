// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPage } from "./TerminalPage";
import type { Session } from "../lib/types";

const imeListeners = new Map<string, (event?: any) => void>();
const keyboardListeners = new Map<string, (event?: any) => void>();

function makeSession(id: string): Session {
  return {
    id,
    sessionName: "term-" + id,
    state: "connected",
    hostId: "h1",
    connectionName: "conn-1",
    bridgeHost: "127.0.0.1",
    bridgePort: 3333,
    title: "term-" + id,
    ws: null,
    hasUnread: false,
    createdAt: 1,
    buffer: { lines: [], gapRanges: [], startIndex: 0, endIndex: 0, bufferHeadStartIndex: 0, bufferTailEndIndex: 0, cols: 80, rows: 24, cursorKeysApp: false, cursor: null, updateKind: "replace" as const, revision: 1 },
  };
}

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: vi.fn(async (n: string, l: (e: any) => void) => { keyboardListeners.set(n, l); return { remove: vi.fn(async () => { keyboardListeners.delete(n); }) }; }),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));
vi.mock("../plugins/ImeAnchorPlugin", () => ({
  ImeAnchor: { show: vi.fn(async () => ({})), hide: vi.fn(async () => undefined), blur: vi.fn(async () => undefined), setEditorActive: vi.fn(async () => ({})), addListener: vi.fn(async (n: string, l: (e: any) => void) => { imeListeners.set(n, l); return { remove: vi.fn(async () => { imeListeners.delete(n); }) }; }), },
}));
vi.mock("../plugins/DeviceClipboardPlugin", () => ({ DeviceClipboardPlugin: { readText: vi.fn(async () => ({ value: "" })), writeText: vi.fn(async () => undefined) }, isNativeClipboardSupported: () => true }));
vi.mock("../plugins/StoragePermissionPlugin", () => ({ StoragePermissionPlugin: { check: vi.fn(async () => ({ granted: true, mode: "manage-external-storage" })), request: vi.fn(async () => ({ granted: true, mode: "manage-external-storage" })) } }));
vi.mock("../components/terminal/TerminalHeader", () => ({ TerminalHeader: () => <div data-testid="terminal-header" /> }));
vi.mock("../components/terminal/TabManagerSheet", () => ({ TabManagerSheet: () => null }));
vi.mock("../components/terminal/TerminalQuickBar", () => ({
  TerminalQuickBar: ({ onToggleKeyboard, keyboardVisible, collapsed }: any) => (
    <div data-testid="terminal-quickbar" data-keyboard-visible={keyboardVisible ? "true" : "false"} data-collapsed={collapsed ? "true" : "false"}>
      <button onClick={() => onToggleKeyboard?.()}>toggle-keyboard</button>
    </div>
  ),
}));
vi.mock("../components/TerminalView", () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={"terminal-view-" + sessionId}>
      <textarea data-wterm-input="true" data-terminal-input-session-id={sessionId} />
    </div>
  ),
}));
vi.mock("../components/terminal/TerminalTabSwipeSurface", () => ({ TerminalTabSwipeSurface: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../components/terminal/FileTransferSheet", () => ({ FileTransferSheet: () => null }));
vi.mock("../components/terminal/RemoteScreenshotSheet", () => ({ RemoteScreenshotSheet: () => null }));
vi.mock("../components/terminal/SessionScheduleSheet", () => ({ SessionScheduleSheet: () => null }));
vi.mock("../components/terminal/TerminalDebugOverlay", () => ({ TerminalDebugOverlay: () => null }));
vi.mock("../pages/TerminalPageDebugOverlay", () => ({ TerminalDebugOverlay: () => null }));

function makeProps(session: Session) {
  return { sessions: [session], activeSession: session, onSwitchSession: vi.fn(), onMoveSession: vi.fn(), onRenameSession: vi.fn(), onCloseSession: vi.fn(), onOpenConnections: vi.fn(), onOpenQuickTabPicker: vi.fn(), onResize: vi.fn(), onTerminalInput: vi.fn(), onTerminalViewportChange: vi.fn(), quickActions: [], shortcutActions: [], sessionDraft: "", onLoadSavedTabList: vi.fn() };
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function getShellBottom(testId: string): string {
  const el = screen.getByTestId(testId);
  const style = el.getAttribute("style") || "";
  const m = style.match(/bottom:\s*([^;]+)/);
  return m?.[1]?.trim() || "";
}

describe("foldable display change - quick bar debounce regression", () => {
  beforeEach(() => {
    imeListeners.clear();
    keyboardListeners.clear();
    vi.stubGlobal("innerWidth", 1080);
    vi.stubGlobal("innerHeight", 2400);
    vi.stubGlobal("visualViewport", { height: 2400, width: 1080, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); imeListeners.clear(); keyboardListeners.clear(); });

  it("quick bar is not collapsed during rapid hide+show (display change)", async () => {
    const session = makeSession("s1");
    render(<TerminalPage {...makeProps(session)} />);
    await waitFor(() => { expect(imeListeners.has("keyboardState")).toBe(true); });
    // Verify initial state: not collapsed
    expect(screen.getByTestId("terminal-quickbar").getAttribute("data-collapsed")).not.toBe("true");
    // Open keyboard
    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });
    await wait(10);
    // Rapid hide then show (foldable display change)
    keyboardListeners.get("keyboardDidHide")?.();
    await wait(50);
    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 340 });
    await wait(50);
    // Must NOT be collapsed
    expect(screen.getByTestId("terminal-quickbar").getAttribute("data-collapsed")).not.toBe("true");
  });

  it("stage shell always reserves space for quick bar (bottom > 0)", async () => {
    const session = makeSession("s2");
    render(<TerminalPage {...makeProps(session)} />);
    await wait(20);
    const stageBottom = getShellBottom("terminal-stage-shell");
    const px = parseInt(stageBottom.replace("px", ""), 10);
    expect(px).toBeGreaterThan(0);
  });

  it("stage shell bottom does not become negative after hide+show (no off-screen quick bar)", async () => {
    const session = makeSession("s3");
    render(<TerminalPage {...makeProps(session)} />);
    await waitFor(() => { expect(imeListeners.has("keyboardState")).toBe(true); });
    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });
    await wait(10);
    // Display change: rapid hide+show
    keyboardListeners.get("keyboardDidHide")?.();
    await wait(50);
    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 340 });
    await wait(50);
    const stageBottom = getShellBottom("terminal-stage-shell");
    const px = parseInt(stageBottom.replace("px", ""), 10);
    expect(px).toBeGreaterThanOrEqual(0);
    // Quick bar shell must exist in DOM
    expect(screen.getByTestId("terminal-quickbar-shell")).toBeTruthy();
  });

  it("after keyboard fully closes (no re-show within 400ms), quick bar shell bottom returns to 0px", async () => {
    const session = makeSession("s4");
    render(<TerminalPage {...makeProps(session)} />);
    await waitFor(() => { expect(imeListeners.has("keyboardState")).toBe(true); });
    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });
    await wait(10);
    keyboardListeners.get("keyboardDidHide")?.();
    await wait(500); // Wait past the 400ms debounce
    // Now quick bar shell must have bottom: 0px (no keyboard lift)
    expect(getShellBottom("terminal-quickbar-shell")).toBe("0px");
  });

  it("stage shell bottom does not become negative after multiple display changes", async () => {
    const session = makeSession("s5");
    render(<TerminalPage {...makeProps(session)} />);
    await waitFor(() => { expect(imeListeners.has("keyboardState")).toBe(true); });
    // Multiple display change cycles
    for (let i = 0; i < 3; i++) {
      keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 300 + i * 20 });
      await wait(10);
      keyboardListeners.get("keyboardDidHide")?.();
      await wait(10);
      keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 + i * 20 });
      await wait(10);
    }
    // Quick bar must still exist and not be collapsed
    expect(screen.getByTestId("terminal-quickbar-shell")).toBeTruthy();
    expect(screen.getByTestId("terminal-quickbar").getAttribute("data-collapsed")).not.toBe("true");
    // Stage shell bottom must be non-negative
    const stageBottom = getShellBottom("terminal-stage-shell");
    const px = parseInt(stageBottom.replace("px", ""), 10);
    expect(px).toBeGreaterThanOrEqual(0);
  });
});

// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS, type Session } from "../lib/types";
import {
  TerminalPage,
  resolveKeyboardLiftPx,
  resolveLayoutViewportHeight,
  resolveTerminalHeaderTopInsetPx,
} from "./TerminalPage";
import { ImeAnchor } from "../plugins/ImeAnchorPlugin";

const imeListeners = new Map<string, (event: any) => void>();
const keyboardListeners = new Map<string, (event: any) => void>();
const { nativeClipboardWriteText } = vi.hoisted(() => ({
  nativeClipboardWriteText: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
  },
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: vi.fn(
      async (eventName: string, listener: (event: any) => void) => {
        keyboardListeners.set(eventName, listener);
        return {
          remove: vi.fn(async () => {
            keyboardListeners.delete(eventName);
          }),
        };
      },
    ),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock("../plugins/ImeAnchorPlugin", () => ({
  ImeAnchor: {
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    setEditorActive: vi.fn(async () => ({})),
    addListener: vi.fn(
      async (eventName: string, listener: (event: any) => void) => {
        imeListeners.set(eventName, listener);
        return {
          remove: vi.fn(async () => {
            imeListeners.delete(eventName);
          }),
        };
      },
    ),
  },
}));

vi.mock("../plugins/DeviceClipboardPlugin", () => ({
  DeviceClipboardPlugin: {
    readText: vi.fn(async () => ({ value: "" })),
    writeText: nativeClipboardWriteText,
  },
  isNativeClipboardSupported: () => true,
}));

vi.mock("../plugins/StoragePermissionPlugin", () => ({
  StoragePermissionPlugin: {
    check: vi.fn(async () => ({
      granted: true,
      mode: "manage-external-storage",
    })),
    request: vi.fn(async () => ({
      granted: true,
      mode: "manage-external-storage",
    })),
  },
}));

vi.mock("../components/terminal/TerminalHeader", () => ({
  TerminalHeader: ({ topInsetPx }: { topInsetPx?: number }) => (
    <div
      data-testid="terminal-header"
      data-top-inset={String(topInsetPx || 0)}
    />
  ),
}));

vi.mock("../components/terminal/TabManagerSheet", () => ({
  TabManagerSheet: () => null,
}));

vi.mock("../components/terminal/TerminalQuickBar", () => ({
  TerminalQuickBar: ({
    onEditorDomFocusChange,
    onToggleKeyboard,
    onToggleCopyMode,
    keyboardVisible,
    keyboardInsetPx,
    sessionDraft,
  }: {
    onEditorDomFocusChange?: (active: boolean) => void;
    onToggleKeyboard?: () => void;
    onToggleCopyMode?: () => void;
    keyboardVisible?: boolean;
    keyboardInsetPx?: number;
    sessionDraft?: string;
  }) => (
    <div
      data-testid="terminal-quickbar"
      data-keyboard-visible={keyboardVisible ? "true" : "false"}
      data-keyboard-inset={String(keyboardInsetPx || 0)}
      data-session-draft={sessionDraft || ""}
    >
      <button onClick={() => onEditorDomFocusChange?.(true)}>
        focus-quick-editor
      </button>
      <button onClick={() => onEditorDomFocusChange?.(false)}>
        blur-quick-editor
      </button>
      <button onClick={() => onToggleKeyboard?.()}>toggle-keyboard</button>
      <button onClick={() => onToggleCopyMode?.()}>toggle-copy-mode</button>
      <div data-testid="terminal-quickbar-draft">{sessionDraft || ""}</div>
    </div>
  ),
}));

vi.mock("../components/TerminalView", () => ({
  TerminalView: ({
    sessionId,
    allowDomFocus,
    onActivateInput,
    onInput,
    onLongPressRow,
    onResize,
    onWidthModeChange,
    widthMode,
    copyStartRowIndex,
    copyEndRowIndex,
    copyPreviewRowIndex,
  }: {
    sessionId: string;
    allowDomFocus?: boolean;
    onActivateInput?: () => void;
    onInput?: (sessionId: string, data: string) => void;
    onLongPressRow?: (
      sessionId: string,
      rowIndex: number,
      clientX: number,
      clientY: number,
    ) => void;
    onResize?: (...args: any[]) => void;
    onWidthModeChange?: (...args: any[]) => void;
    widthMode?: string;
    copyStartRowIndex?: number | null;
    copyEndRowIndex?: number | null;
    copyPreviewRowIndex?: number | null;
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-allow-dom-focus={allowDomFocus ? "true" : "false"}
      data-has-onresize={onResize ? "true" : "false"}
      data-has-onwidthmodechange={onWidthModeChange ? "true" : "false"}
      data-width-mode={widthMode || "adaptive-phone"}
      data-copy-start={copyStartRowIndex ?? ""}
      data-copy-end={copyEndRowIndex ?? ""}
      data-copy-preview={copyPreviewRowIndex ?? ""}
      onClick={() => onActivateInput?.()}
    >
      <textarea
        data-wterm-input="true"
        data-terminal-input-session-id={sessionId}
        defaultValue=""
        onKeyDown={(event) => {
          if (!onInput) {
            return;
          }
          if (event.key === "ArrowUp") {
            onInput(sessionId, "\u001b[A");
            return;
          }
          if (event.key === "Escape") {
            onInput(sessionId, "\u001b");
          }
        }}
      />
      <button onClick={() => onLongPressRow?.(sessionId, 100, 44, 120)}>
        longpress-row-100
      </button>
      <button onClick={() => onLongPressRow?.(sessionId, 102, 44, 160)}>
        longpress-row-102
      </button>
    </div>
  ),
}));

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: "100.127.23.27",
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
    ws: null,
    state: "connected",
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: "replace",
      revision: 1,
    },
  };
}

async function flushAndroidImeFocusTimer() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("TerminalPage Android IME bridge", () => {
  beforeEach(() => {
    imeListeners.clear();
    keyboardListeners.clear();
    nativeClipboardWriteText.mockClear();
    const storageBacking = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    imeListeners.clear();
    keyboardListeners.clear();
  });

  it("disables DOM terminal focus on Android and routes native IME input to active session", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("keyboardState")).toBe(true);
    });
    await flushAndroidImeFocusTimer();
    imeListeners.get("keyboardState")?.({ visible: true, height: 320 });

    await waitFor(() => {
      expect(imeListeners.has("keyboardState")).toBe(true);
    });
    await flushAndroidImeFocusTimer();
    imeListeners.get("keyboardState")?.({ visible: true, height: 320 });

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
      expect(imeListeners.has("backspace")).toBe(true);
    });

    expect(
      screen
        .getByTestId("terminal-view-s1")
        .getAttribute("data-allow-dom-focus"),
    ).toBe("false");
    expect(
      screen.getByTestId("terminal-view-s1").getAttribute("data-has-onresize"),
    ).toBe("false");

    imeListeners.get("input")?.({ text: "语音输入\n下一行" });
    imeListeners.get("backspace")?.({ count: 2 });

    expect(onTerminalInput).toHaveBeenCalledWith("s1", "语音输入\r下一行");
    expect(onTerminalInput).toHaveBeenCalledWith("s1", "\x7f\x7f");
  });

  it("routes Android IME input to the focused split pane session instead of the old runtime active session", async () => {
    localStorage.setItem(
      STORAGE_KEYS.TERMINAL_LAYOUT,
      JSON.stringify({
        panes: [
          {
            id: "pane-1",
            size: 0.5,
            activeTabId: "tab-s1",
            tabs: [{ id: "tab-s1", sessionId: "s1" }],
          },
          {
            id: "pane-2",
            size: 0.5,
            activeTabId: "tab-s2",
            tabs: [{ id: "tab-s2", sessionId: "s2" }],
          },
        ],
        activePaneId: "pane-1",
      }),
    );
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const onTerminalInput = vi.fn();
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={[session1, session2]}
        activeSession={session1}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
      expect(screen.getByTestId("terminal-view-s2")).toBeTruthy();
    });

    const paneShell = screen
      .getAllByTestId("terminal-pane-shell")
      .find((element) => element.getAttribute("data-pane-id") === "pane-2");
    expect(paneShell).toBeTruthy();

    fireEvent.pointerDown(paneShell!);
    await waitFor(() => expect(onSwitchSession).toHaveBeenCalledWith("s2"));

    imeListeners.get("input")?.({ text: "pane2" });

    expect(onTerminalInput).toHaveBeenCalledWith("s2", "pane2");
    expect(onTerminalInput).not.toHaveBeenCalledWith("s1", "pane2");
  });

  it("routes Android IME input to the newly selected tab immediately after active session changes", async () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const onTerminalInput = vi.fn();

    function Harness() {
      const [activeSessionId, setActiveSessionId] = useState("s1");
      const activeSession = activeSessionId === "s2" ? session2 : session1;
      return (
        <>
          <button type="button" onClick={() => setActiveSessionId("s2")}>
            switch-to-s2
          </button>
          <TerminalPage
            sessions={[session1, session2]}
            activeSession={activeSession}
            onSwitchSession={setActiveSessionId}
            onMoveSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            onOpenConnections={vi.fn()}
            onOpenQuickTabPicker={vi.fn()}
            onResize={vi.fn()}
            onTerminalInput={onTerminalInput}
            onTerminalViewportChange={vi.fn()}
            quickActions={[]}
            shortcutActions={[]}
            sessionDraft=""
            onLoadSavedTabList={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);

    await waitFor(() => expect(imeListeners.has("input")).toBe(true));
    fireEvent.click(screen.getByText("switch-to-s2"));
    imeListeners.get("input")?.({ text: "fast-after-switch" });

    expect(onTerminalInput).toHaveBeenCalledWith("s2", "fast-after-switch");
    expect(onTerminalInput).not.toHaveBeenCalledWith("s1", "fast-after-switch");
  });

  it("keeps editor overlay draft outside terminal body truth on Android", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft="overlay-draft-中文"
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-session-draft"),
      ).toBe("overlay-draft-中文");
    });

    expect(screen.getByTestId("terminal-quickbar-draft").textContent).toBe(
      "overlay-draft-中文",
    );
    expect(screen.getByTestId("terminal-view-s1").textContent).not.toContain(
      "overlay-draft-中文",
    );
  });

  it("does not render the legacy copy menu in TerminalPage after copy button toggle", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("toggle-copy-mode"));
    fireEvent.click(screen.getByText("longpress-row-100"));

    expect(screen.queryByTestId("terminal-copy-menu")).toBeNull();
    expect(
      screen.getByTestId("terminal-view-s1").getAttribute("data-copy-preview"),
    ).toBe("");
    expect(
      screen.getByTestId("terminal-view-s1").getAttribute("data-copy-start"),
    ).toBe("");
  });

  it("releases editor mode before keyboard toggle and requests Android IME focus", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => expect(imeListeners.has("input")).toBe(true));

    fireEvent.click(screen.getByText("focus-quick-editor"));
    expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenCalledWith({
      active: true,
    });

    vi.mocked(ImeAnchor.show).mockClear();
    fireEvent.click(screen.getByText("toggle-keyboard"));
    await flushAndroidImeFocusTimer();

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenCalledWith({
        active: false,
      });
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalled();
    });
  });

  it("switching tabs keeps TerminalPage free of legacy copy menu overlays", async () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");

    function Harness() {
      const [activeSessionId, setActiveSessionId] = useState("s1");
      const activeSession = activeSessionId === "s2" ? session2 : session1;
      return (
        <>
          <button type="button" onClick={() => setActiveSessionId("s2")}>
            switch-to-s2
          </button>
          <TerminalPage
            sessions={[session1, session2]}
            activeSession={activeSession}
            onSwitchSession={setActiveSessionId}
            onMoveSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            onOpenConnections={vi.fn()}
            onOpenQuickTabPicker={vi.fn()}
            onResize={vi.fn()}
            onTerminalInput={vi.fn()}
            onTerminalViewportChange={vi.fn()}
            quickActions={[]}
            shortcutActions={[]}
            sessionDraft=""
            onLoadSavedTabList={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByText("toggle-copy-mode"));
    fireEvent.click(screen.getByText("longpress-row-100"));
    expect(screen.queryByTestId("terminal-copy-menu")).toBeNull();

    fireEvent.click(screen.getByText("switch-to-s2"));

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-copy-menu")).toBeNull();
    });
  });

  it("does not pass upstream terminal resize on Android, even when keyboard visibility changes", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(keyboardListeners.has("keyboardDidShow")).toBe(true);
    });

    const terminalView = screen.getByTestId("terminal-view-s1");
    expect(terminalView.getAttribute("data-has-onresize")).toBe("false");
    expect(terminalView.getAttribute("data-has-onwidthmodechange")).toBe(
      "false",
    );

    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-view-s1")
          .getAttribute("data-has-onresize"),
      ).toBe("false");
      expect(
        screen
          .getByTestId("terminal-view-s1")
          .getAttribute("data-has-onwidthmodechange"),
      ).toBe("false");
    });
  });

  it("keeps Android adaptive-phone upstream geometry on the width-mode channel instead of the resize channel", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onTerminalWidthModeChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
        terminalWidthMode="adaptive-phone"
      />,
    );

    const terminalView = screen.getByTestId("terminal-view-s1");
    expect(terminalView.getAttribute("data-has-onresize")).toBe("false");
    expect(terminalView.getAttribute("data-has-onwidthmodechange")).toBe(
      "true",
    );
    expect(terminalView.getAttribute("data-width-mode")).toBe("adaptive-phone");
  });

  it("passes settings terminal width mode down to the active renderer", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
        terminalWidthMode="mirror-fixed"
      />,
    );

    expect(
      screen.getByTestId("terminal-view-s1").getAttribute("data-width-mode"),
    ).toBe("mirror-fixed");
  });

  it("suspends ImeAnchor routing while quick bar DOM editor owns focus but still keeps shell keyboard inset", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "focus-quick-editor" }));

    await waitFor(() => {
      expect(ImeAnchor.blur).toHaveBeenCalled();
      expect(ImeAnchor.setEditorActive).toHaveBeenCalledWith({ active: true });
    });

    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 280 });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("false");
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-inset"),
      ).toBe("280");
    });

    imeListeners.get("input")?.({ text: "不该发到 terminal" });
    expect(onTerminalInput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "blur-quick-editor" }));

    imeListeners.get("input")?.({ text: "恢复路由" });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "恢复路由");
    });
    expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenLastCalledWith({
      active: false,
    });
  });

  it("re-activates ImeAnchor routing when quick editor yields focus while terminal keyboard is already visible", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(keyboardListeners.has("keyboardDidShow")).toBe(true);
    });

    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 280 });
    fireEvent.click(screen.getByRole("button", { name: "focus-quick-editor" }));

    await waitFor(() => {
      expect(ImeAnchor.blur).toHaveBeenCalled();
    });

    vi.mocked(ImeAnchor.show).mockClear();
    vi.mocked(ImeAnchor.setEditorActive).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "blur-quick-editor" }));

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(ImeAnchor.setEditorActive)).toHaveBeenLastCalledWith({
      active: false,
    });
  });

  it("toggles native editor-active state while handing IME focus between terminal and quick editor", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "focus-quick-editor" }));
    fireEvent.click(screen.getByRole("button", { name: "blur-quick-editor" }));

    const calls = vi
      .mocked(ImeAnchor.setEditorActive)
      .mock.calls.map(([payload]) => payload?.active);
    expect(calls).toContain(true);
    expect(calls[calls.length - 1]).toBe(false);
  });

  it("hides ImeAnchor when toggling the already-requested Android keyboard off", async () => {
    const session = makeSession("s1");

    try {
      render(
        <TerminalPage
          sessions={[session]}
          activeSession={session}
          onSwitchSession={vi.fn()}
          onMoveSession={vi.fn()}
          onRenameSession={vi.fn()}
          onCloseSession={vi.fn()}
          onOpenConnections={vi.fn()}
          onOpenQuickTabPicker={vi.fn()}
          onResize={vi.fn()}
          onTerminalInput={vi.fn()}
          onTerminalViewportChange={vi.fn()}
          quickActions={[]}
          shortcutActions={[]}
          sessionDraft=""
          onLoadSavedTabList={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(keyboardListeners.has("keyboardDidShow")).toBe(true);
      });

      vi.mocked(ImeAnchor.hide).mockClear();
      fireEvent.click(screen.getByRole("button", { name: "toggle-keyboard" }));

      await flushAndroidImeFocusTimer();

      expect(vi.mocked(ImeAnchor.hide)).toHaveBeenCalledTimes(1);
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-activates ImeAnchor routing when tapping the Android terminal surface while keyboard stays visible", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(keyboardListeners.has("keyboardDidShow")).toBe(true);
    });

    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });
    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("true");
    });
    vi.mocked(ImeAnchor.show).mockClear();
    fireEvent.click(screen.getByTestId("terminal-view-s1"));

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
    });
  });

  it("re-activates ImeAnchor routing when the active terminal session changes while the Android keyboard is already visible", async () => {
    const sessionOne = makeSession("s1");
    const sessionTwo = makeSession("s2");

    const view = render(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionOne}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(keyboardListeners.has("keyboardDidShow")).toBe(true);
    });

    keyboardListeners.get("keyboardDidShow")?.({ keyboardHeight: 320 });
    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("true");
    });

    vi.mocked(ImeAnchor.show).mockClear();
    vi.mocked(ImeAnchor.setEditorActive).mockClear();

    view.rerender(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionTwo}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await flushAndroidImeFocusTimer();

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(ImeAnchor.setEditorActive)).not.toHaveBeenCalled();

    const onTerminalInput = vi.fn();
    view.rerender(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionTwo}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get("input")?.({ text: "hello-after-switch" });

    expect(onTerminalInput).toHaveBeenCalledWith("s2", "hello-after-switch");
  });

  it("routes hardware special keys through the active session after tab switch", async () => {
    const sessionOne = makeSession("s1");
    const sessionTwo = makeSession("s2");
    const onTerminalInput = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionOne}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("key")).toBe(true);
    });

    view.rerender(
      <TerminalPage
        sessions={[sessionOne, sessionTwo]}
        activeSession={sessionTwo}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get("key")?.({ key: "ArrowUp", code: "ArrowUp" });
    imeListeners.get("key")?.({ key: "Escape", code: "Escape" });

    expect(onTerminalInput).toHaveBeenNthCalledWith(1, "s2", "\u001b[A");
    expect(onTerminalInput).toHaveBeenNthCalledWith(2, "s2", "\u001b");
  });

  it("uses native ImeAnchor keyboardState to raise terminal chrome on Android", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await flushAndroidImeFocusTimer();

    await waitFor(() => {
      expect(imeListeners.has("keyboardState")).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "toggle-keyboard" }));
    imeListeners.get("keyboardState")?.({ visible: true, height: 320 });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("true");
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-inset"),
      ).toBe("320");
    });
  });

  it("requests the Android terminal keyboard on initial terminal entry without waiting for the keyboard button", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("keyboardState")).toBe(true);
    });
    await flushAndroidImeFocusTimer();
    imeListeners.get("keyboardState")?.({ visible: true, height: 320 });

    await waitFor(() => {
      expect(vi.mocked(ImeAnchor.show)).toHaveBeenCalled();
      expect(
        screen
          .getByTestId("terminal-quickbar")
          .getAttribute("data-keyboard-visible"),
      ).toBe("true");
    });
  });

  it("shrinks the terminal stage from the bottom instead of translating the whole page when keyboard is visible", async () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const terminalStage = screen.getByTestId("terminal-stage-shell");
    const quickBarShell = screen.getByTestId("terminal-quickbar-shell");
    expect(terminalStage.getAttribute("style") || "").toContain(
      "bottom: 64px;",
    );
    expect(terminalStage.getAttribute("style") || "").not.toContain(
      "transform: translateY",
    );
    expect(quickBarShell.getAttribute("style") || "").toContain("bottom: 0px;");

    await waitFor(() => {
      expect(imeListeners.has("keyboardState")).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "toggle-keyboard" }));
    imeListeners.get("keyboardState")?.({ visible: true, height: 320 });

    await waitFor(() => {
      const style = terminalStage.getAttribute("style") || "";
      expect(style).toContain("bottom: 384px;");
      expect(style).not.toContain("transform: translateY");
      expect(quickBarShell.getAttribute("style") || "").toContain(
        "bottom: 320px;",
      );
    });
  });

  it("keeps a non-zero terminal header top inset on Android even when CSS safe-area env is unavailable", () => {
    const session = makeSession("s1");

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    expect(
      Number(
        screen.getByTestId("terminal-header").getAttribute("data-top-inset") ||
          "0",
      ),
    ).toBeGreaterThan(0);
  });

  it("does not reattach native IME listeners on buffer rerenders and still routes to latest active session", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
      expect(imeListeners.has("backspace")).toBe(true);
    });
    const addListenerCallsBeforeRerender = vi.mocked(ImeAnchor.addListener).mock
      .calls.length;

    const updatedSession: Session = {
      ...session,
      buffer: {
        ...session.buffer,
        revision: 2,
        endIndex: 1,
      },
    };

    view.rerender(
      <TerminalPage
        sessions={[updatedSession]}
        activeSession={updatedSession}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get("input")?.({ text: "still-immediate" });

    expect(vi.mocked(ImeAnchor.addListener).mock.calls.length).toBe(
      addListenerCallsBeforeRerender,
    );
    expect(onTerminalInput).toHaveBeenCalledWith("s1", "still-immediate");
  });

  it("keeps native IME routing alive after a voice-style CJK commit without needing an extra priming character", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
    });

    imeListeners.get("input")?.({ text: "语音识别结果" });
    imeListeners.get("input")?.({ text: "!" });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "语音识别结果");
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "!");
    });
  });

  it("normalizes Android IME full-width latin, digits, punctuation, and space to half-width before sending to terminal", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
    });

    imeListeners.get("input")?.({ text: "ＡＢＣ１２３，．！　中文" });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "ABC123,.! 中文");
    });
  });

  it("flushes a committed CJK result immediately without waiting for a later priming space", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
    });

    imeListeners.get("input")?.({ text: "你好" });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "你好");
    });

    expect(onTerminalInput).toHaveBeenCalledTimes(1);
    expect(onTerminalInput).not.toHaveBeenCalledWith("s1", " ");
  });

  it("keeps routing later native IME input after a buffer rerender that follows a voice-style commit", async () => {
    const session = makeSession("s1");
    const onTerminalInput = vi.fn();

    const view = render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(imeListeners.has("input")).toBe(true);
    });

    imeListeners.get("input")?.({ text: "语音识别结果" });

    const updatedSession: Session = {
      ...session,
      buffer: {
        ...session.buffer,
        revision: 2,
        endIndex: 1,
      },
    };

    view.rerender(
      <TerminalPage
        sessions={[updatedSession]}
        activeSession={updatedSession}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    imeListeners.get("input")?.({ text: "继续输入" });

    await waitFor(() => {
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "语音识别结果");
      expect(onTerminalInput).toHaveBeenCalledWith("s1", "继续输入");
    });
  });
});

describe("resolveKeyboardLiftPx", () => {
  it("keeps the reported keyboard lift when WebView does not expose viewport occlusion", () => {
    const originalInnerHeight = window.innerHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 900,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(320)).toBe(320);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it("caps the lift to the actual occluded bottom height when the keyboard overlays content", () => {
    const originalInnerHeight = window.innerHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 620,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(400)).toBe(280);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it("does not over-lift when innerHeight has already shrunk to visualViewport height on Android", () => {
    const originalInnerHeight = window.innerHeight;
    const originalDocumentClientHeight = document.documentElement.clientHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 620,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 620,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(280)).toBe(280);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: originalDocumentClientHeight,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });
});

describe("resolveTerminalHeaderTopInsetPx", () => {
  it("keeps Android header inset stable when visualViewport offsetTop jumps during IME popup", () => {
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        offsetTop: 96,
      },
    });

    expect(resolveTerminalHeaderTopInsetPx(true)).toBe(16);

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });
});

describe("resolveLayoutViewportHeight", () => {
  it("prefers stable layout viewport height when Android IME shrinks innerHeight on a tablet", () => {
    const originalInnerHeight = window.innerHeight;
    const originalDocumentClientHeight = document.documentElement.clientHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 620,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 1366,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 620,
        offsetTop: 0,
      },
    });

    expect(resolveLayoutViewportHeight()).toBe(1366);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: originalDocumentClientHeight,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });
});

describe("resolveKeyboardLiftPx with stable layout viewport height override", () => {
  it("uses the pre-keyboard stable layout height when Android shrinks all viewport metrics during IME popup", () => {
    const originalInnerHeight = window.innerHeight;
    const originalDocumentClientHeight = document.documentElement.clientHeight;
    const originalVisualViewport = window.visualViewport;

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 328,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 328,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 328,
        offsetTop: 0,
      },
    });

    expect(resolveKeyboardLiftPx(303, 615)).toBe(287);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: originalDocumentClientHeight,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });
});

// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { TerminalQuickBar } from "./TerminalQuickBar";
import {
  FLOATING_BUBBLE_POSITION_STORAGE_KEY,
  resolveOverlayViewportMetrics,
} from "./terminal-quickbar-helpers";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    hide: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../plugins/DeviceClipboardPlugin", () => ({
  DeviceClipboardPlugin: {
    readText: vi.fn().mockResolvedValue({ value: "" }),
  },
  isNativeClipboardSupported: () => false,
}));

vi.mock("../../plugins/ScreenOrientationPlugin", () => ({
  ScreenOrientationPlugin: {
    setOrientation: vi.fn().mockResolvedValue({ orientation: "landscape" }),
  },
  isScreenOrientationSupported: () => false,
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function stubElementHeight(element: HTMLElement, height: number) {
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 390,
      height,
      top: 0,
      right: 390,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    }),
  });
}

function stubVisualViewport(overrides?: Partial<VisualViewport>) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const visualViewport = {
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    addEventListener,
    removeEventListener,
    ...overrides,
  } as Record<string, unknown>;

  if (!("width" in (overrides || {}))) {
    Object.defineProperty(visualViewport, "width", {
      configurable: true,
      get: () => window.innerWidth,
    });
  }

  if (!("height" in (overrides || {}))) {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => window.innerHeight,
    });
  }

  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: visualViewport as unknown as VisualViewport,
  });

  return {
    visualViewport: visualViewport as unknown as VisualViewport,
    addEventListener,
    removeEventListener,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("TerminalQuickBar", () => {
  beforeEach(() => {
    cleanup();
    const storageBacking = new Map<string, string>();
    const storageShim = {
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
    } as Storage;
    vi.stubGlobal("localStorage", storageShim);
    localStorage.clear();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    stubVisualViewport();
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderQuickBar(
    props?: Partial<React.ComponentProps<typeof TerminalQuickBar>>,
  ) {
    return render(
      <TerminalQuickBar
        activeSessionId="session-1"
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onSendSequence={vi.fn()}
        onSessionDraftChange={vi.fn()}
        onSessionDraftSend={vi.fn()}
        onQuickActionsChange={vi.fn()}
        onShortcutActionsChange={vi.fn()}
        onOpenScheduleComposer={vi.fn()}
        onMeasuredHeightChange={vi.fn()}
        shellMode="inline"
        {...props}
      />,
    );
  }

  it("closes floating quick input when clicking outside", async () => {
    renderQuickBar();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    expect(screen.getByText("快捷输入")).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByText("快捷输入")).toBeNull();
    });
  });

  it("opens schedule composer from current draft text", async () => {
    const onSessionDraftChange = vi.fn();
    const onOpenScheduleComposer = vi.fn();

    renderQuickBar({
      sessionDraft: "echo schedule me",
      onSessionDraftChange,
      onOpenScheduleComposer,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "定时" }));

    await waitFor(() => {
      expect(onOpenScheduleComposer).toHaveBeenCalledWith("echo schedule me");
    });
  });

  it("still opens the current session schedule list even when local draft is empty", async () => {
    const onOpenScheduleComposer = vi.fn();

    renderQuickBar({
      sessionDraft: "",
      onOpenScheduleComposer,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "定时" }));

    await waitFor(() => {
      expect(onOpenScheduleComposer).toHaveBeenCalledWith("");
    });
  });

  it("persists floating bubble position after drag", async () => {
    renderQuickBar();

    const bubble = screen.getByRole("button", {
      name: "Toggle floating quick menu",
    });
    fireEvent.pointerDown(bubble, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(bubble, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 40,
      clientY: 54,
    });
    fireEvent.pointerUp(bubble, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 40,
      clientY: 54,
    });

    await waitFor(() => {
      const raw = localStorage.getItem("zterm:floating-bubble-position");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || "{}");
      expect(typeof parsed.x).toBe("number");
      expect(typeof parsed.y).toBe("number");
    });
  });

  it("rescues stored floating bubble position back into viewport on mount", async () => {
    localStorage.setItem(
      "zterm:floating-bubble-position",
      JSON.stringify({ x: 9999, y: 9999 }),
    );

    renderQuickBar();

    await waitFor(() => {
      const raw = localStorage.getItem("zterm:floating-bubble-position");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || "{}");
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it("re-clamps floating bubble position after viewport resize", async () => {
    localStorage.setItem(
      "zterm:floating-bubble-position",
      JSON.stringify({ x: 500, y: 500 }),
    );
    renderQuickBar();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 220,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 180,
    });

    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      const raw = localStorage.getItem("zterm:floating-bubble-position");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || "{}");
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it("uses stable layout viewport metrics for overlay bottom inset when IME shrinks visual viewport", () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 720,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 1024,
    });
    stubVisualViewport({
      width: 1200,
      height: 560,
      offsetTop: 0,
      offsetLeft: 0,
    });

    const metrics = resolveOverlayViewportMetrics(280);
    expect(metrics.bottomInsetPx).toBe(464);
    expect(metrics.sheetHeightPx).toBe(544);
  });

  it("hides shell quick rows while floating menu is open", async () => {
    renderQuickBar();

    expect(screen.getByRole("button", { name: "状态" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "文件" })).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "状态" })).toBeNull();
      expect(screen.queryByRole("button", { name: "文件" })).toBeNull();
    });
  });

  it("restores shell quick rows after floating menu closes", async () => {
    renderQuickBar();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "状态" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭快捷输入" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "状态" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "文件" })).not.toBeNull();
    });
  });

  it("lifts the primary floating bubble (file browser) above keyboard inset", async () => {
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 240,
    });

    const bubble = screen.getByRole("button", {
      name: "文件浏览",
    });
    const style = bubble.getAttribute("style") || "";
    expect(style).toContain("bottom: calc(312px");
  });

  it("rescues a dragged floating bubble below the status bar guard", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 820,
    });
    stubVisualViewport({ width: 390, height: 820, offsetTop: 0, offsetLeft: 0 });
    localStorage.setItem(
      FLOATING_BUBBLE_POSITION_STORAGE_KEY,
      JSON.stringify({ x: 320, y: 8 }),
    );

    renderQuickBar();

    await waitFor(() => {
      const bubble = screen.getByRole("button", {
        name: "Toggle floating quick menu",
      });
      expect(bubble.getAttribute("style") || "").toContain("top: 64px");
    });
  });

  it("does not add a second keyboard inset padding inside shell quick rows", async () => {
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 240,
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    const style = shellRows.getAttribute("style") || "";
    expect(style).not.toContain("padding-bottom: 240px");
  });

  it("reports the real shell height while keyboard lift is applied outside the quickbar", async () => {
    const onMeasuredHeightChange = vi.fn();
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 320,
      onMeasuredHeightChange,
    });

    const root = screen
      .getByTestId("terminal-quickbar-shell-rows")
      .parentElement as HTMLElement;
    expect(root).not.toBeNull();
    stubElementHeight(root, 184);

    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(onMeasuredHeightChange).toHaveBeenLastCalledWith(184);
    });
  });

  it("reports zero chrome height when quickbar rows are collapsed", async () => {
    const onMeasuredHeightChange = vi.fn();
    const view = renderQuickBar({
      collapseAvailable: true,
      collapsed: false,
      onMeasuredHeightChange,
    });

    const root = screen
      .getByTestId("terminal-quickbar-shell-rows")
      .parentElement as HTMLElement;
    stubElementHeight(root, 184);
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(onMeasuredHeightChange).toHaveBeenLastCalledWith(184);
    });

    view.rerender(
      <TerminalQuickBar
        activeSessionId="session-1"
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onSendSequence={vi.fn()}
        onSessionDraftChange={vi.fn()}
        onSessionDraftSend={vi.fn()}
        onQuickActionsChange={vi.fn()}
        onShortcutActionsChange={vi.fn()}
        onOpenScheduleComposer={vi.fn()}
        onMeasuredHeightChange={onMeasuredHeightChange}
        shellMode="inline"
        collapseAvailable
        collapsed
      />,
    );

    await waitFor(() => {
      expect(onMeasuredHeightChange).toHaveBeenLastCalledWith(0);
    });
  });

  it("pans quickbar scroll tracks only from the expanded shell rows touch region", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      shortcutActions: [
        { id: "s1", label: "S1", sequence: "\u001b[1;2A", row: "top-scroll", order: 1 },
        { id: "s2", label: "S2", sequence: "\u001b[1;2B", row: "bottom-scroll", order: 2 },
      ],
      collapseAvailable: true,
      onCollapsedChange,
      onOpenFileTransfer: vi.fn(),
      onToggleDebugOverlay: vi.fn(),
      onToggleAbsoluteLineNumbers: vi.fn(),
      onRequestRemoteScreenshot: vi.fn(),
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    expect(shellRows.getAttribute("data-quickbar-pan-surface")).toBe("true");
    expect(shellRows.getAttribute("style") || "").toContain("touch-action: pan-y");

    const tracks = Array.from(
      shellRows.querySelectorAll<HTMLElement>('[data-quickbar-scroll-track="true"]'),
    );
    expect(tracks.length).toBeGreaterThan(1);
    for (const track of tracks) {
      Object.defineProperty(track, "scrollWidth", {
        configurable: true,
        value: 900,
      });
      Object.defineProperty(track, "clientWidth", {
        configurable: true,
        value: 260,
      });
      track.scrollLeft = 40;
    }

    fireEvent.touchStart(shellRows, { touches: [{ clientX: 280, clientY: 620 }] });
    fireEvent.touchMove(shellRows, {
      touches: [{ clientX: 120, clientY: 624 }],
      cancelable: true,
    });
    fireEvent.touchEnd(shellRows);

    expect(tracks.map((track) => track.scrollLeft)).toEqual(
      tracks.map(() => 200),
    );
    expect(onCollapsedChange).not.toHaveBeenCalled();
  });

  it("keeps vertical quickbar shell row gestures from panning horizontal tracks", async () => {
    renderQuickBar();

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    const tracks = Array.from(
      shellRows.querySelectorAll<HTMLElement>('[data-quickbar-scroll-track="true"]'),
    );
    for (const track of tracks) {
      Object.defineProperty(track, "scrollWidth", {
        configurable: true,
        value: 900,
      });
      Object.defineProperty(track, "clientWidth", {
        configurable: true,
        value: 260,
      });
      track.scrollLeft = 40;
    }

    fireEvent.touchStart(shellRows, { touches: [{ clientX: 180, clientY: 620 }] });
    fireEvent.touchMove(shellRows, {
      touches: [{ clientX: 184, clientY: 700 }],
      cancelable: true,
    });
    fireEvent.touchEnd(shellRows);

    expect(tracks.map((track) => track.scrollLeft)).toEqual(
      tracks.map(() => 40),
    );
  });

  it("leaves scroll-track gestures to the track native scroll owner", async () => {
    renderQuickBar();

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    const tracks = Array.from(
      shellRows.querySelectorAll<HTMLElement>('[data-quickbar-scroll-track="true"]'),
    );
    expect(tracks.length).toBeGreaterThan(1);
    for (const track of tracks) {
      Object.defineProperty(track, "scrollWidth", {
        configurable: true,
        value: 900,
      });
      Object.defineProperty(track, "clientWidth", {
        configurable: true,
        value: 260,
      });
      track.scrollLeft = 40;
    }

    fireEvent.touchStart(tracks[0]!, {
      touches: [{ clientX: 280, clientY: 620 }],
    });
    fireEvent.touchMove(tracks[0]!, {
      touches: [{ clientX: 120, clientY: 624 }],
      cancelable: true,
    });
    fireEvent.touchEnd(tracks[0]!);

    expect(tracks.map((track) => track.scrollLeft)).toEqual(
      tracks.map(() => 40),
    );
  });

  it("does not start rows-level pan from a quickbar action button", async () => {
    renderQuickBar();

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    const tracks = Array.from(
      shellRows.querySelectorAll<HTMLElement>('[data-quickbar-scroll-track="true"]'),
    );
    for (const track of tracks) {
      Object.defineProperty(track, "scrollWidth", {
        configurable: true,
        value: 900,
      });
      Object.defineProperty(track, "clientWidth", {
        configurable: true,
        value: 260,
      });
      track.scrollLeft = 40;
    }

    const keyboardButton = screen.getByRole("button", { name: "键盘" });
    fireEvent.touchStart(keyboardButton, {
      touches: [{ clientX: 120, clientY: 620 }],
    });
    fireEvent.touchMove(keyboardButton, {
      touches: [{ clientX: 40, clientY: 624 }],
      cancelable: true,
    });
    fireEvent.touchEnd(keyboardButton);

    expect(tracks.map((track) => track.scrollLeft)).toEqual(
      tracks.map(() => 40),
    );
  });

  it("collapses expanded quickbar from a downward vertical swipe on its rows", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      collapseAvailable: true,
      collapsed: false,
      onCollapsedChange,
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    const track = shellRows.querySelector<HTMLElement>(
      '[data-quickbar-scroll-track="true"]',
    );
    expect(track).not.toBeNull();
    track!.scrollLeft = 40;

    fireEvent.touchStart(track!, {
      touches: [{ clientX: 240, clientY: 610 }],
    });
    fireEvent.touchMove(track!, {
      touches: [{ clientX: 244, clientY: 676 }],
      cancelable: true,
    });
    fireEvent.touchEnd(track!);

    expect(track!.scrollLeft).toBe(40);
    expect(onCollapsedChange).toHaveBeenCalledTimes(1);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("does not collapse quickbar for a short vertical touch", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      collapseAvailable: true,
      collapsed: false,
      onCollapsedChange,
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    fireEvent.touchStart(shellRows, {
      touches: [{ clientX: 240, clientY: 610 }],
    });
    fireEvent.touchMove(shellRows, {
      touches: [{ clientX: 242, clientY: 638 }],
      cancelable: true,
    });
    fireEvent.touchEnd(shellRows);

    expect(onCollapsedChange).not.toHaveBeenCalled();
  });

  it("reveals collapsed quickbar from an upward swipe on the bottom trigger", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      collapseAvailable: true,
      collapsed: true,
      onCollapsedChange,
    });

    const trigger = screen.getByRole("button", { name: "展开快捷栏" });
    fireEvent.touchStart(trigger, {
      touches: [{ clientX: 320, clientY: 720 }],
    });
    fireEvent.touchMove(trigger, {
      touches: [{ clientX: 316, clientY: 650 }],
      cancelable: true,
    });
    fireEvent.touchEnd(trigger);

    expect(onCollapsedChange).toHaveBeenCalledTimes(1);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("extends the raised reveal surface through the full lower edge", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      collapseAvailable: true,
      collapsed: true,
      onCollapsedChange,
    });

    const surface = screen.getByTestId("terminal-quickbar-collapsed-reveal-surface");
    expect(surface.style.bottom).toBe("0px");
    expect(surface.style.height).toContain("136px");
    fireEvent.click(surface);

    expect(onCollapsedChange).toHaveBeenCalledTimes(1);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("reveals collapsed quickbar from an upward swipe near the bottom of the full reveal surface", async () => {
    const onCollapsedChange = vi.fn();
    renderQuickBar({
      collapseAvailable: true,
      collapsed: true,
      onCollapsedChange,
    });

    const surface = screen.getByTestId("terminal-quickbar-collapsed-reveal-surface");
    fireEvent.touchStart(surface, {
      touches: [{ clientX: 180, clientY: 730 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 178, clientY: 650 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface);

    expect(onCollapsedChange).toHaveBeenCalledTimes(1);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("renders two shell rows in landscape with tools merged into the second row", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });
    renderQuickBar({
      onOpenFileTransfer: vi.fn(),
      onToggleDebugOverlay: vi.fn(),
      onToggleAbsoluteLineNumbers: vi.fn(),
      onRequestRemoteScreenshot: vi.fn(),
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    expect(
      shellRows.querySelectorAll('[data-quickbar-shell-row="true"]').length,
    ).toBe(2);
    expect(screen.getByRole("button", { name: "状态" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "键盘" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "↑" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "←" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "↓" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "→" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "文件" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "图片" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "同步" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "截图" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "行号" })).not.toBeNull();

    const topFixedClusterButtons = screen
      .getByTestId("quickbar-fixed-cluster-top")
      .querySelectorAll("button");
    expect(
      Array.from(topFixedClusterButtons).map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["拷贝", "↑滚", "↓滚", "↑", "键盘"]);
    const topClusterStyle =
      screen.getByTestId("quickbar-fixed-cluster-top").getAttribute("style") ||
      "";
    expect(topClusterStyle).toContain("width: 262px");
  });

  it("hides inline shell rows and keeps only the floating toggle when shellMode is floating-collapsed", async () => {
    renderQuickBar({
      shellMode: "floating-collapsed",
    });

    expect(screen.queryByTestId("terminal-quickbar-shell-rows")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "状态" })).toBeNull();
    expect(screen.queryByRole("button", { name: "文件" })).toBeNull();
  });

  it("keeps the inline quickbar free of a dedicated collapse button", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });
    stubVisualViewport({
      width: 1200,
      height: 700,
      offsetTop: 0,
      offsetLeft: 0,
    });

    renderQuickBar({
      collapseAvailable: true,
      collapsed: false,
    });

    const toolRow = screen.getByTestId("quickbar-tool-row");
    expect(toolRow.textContent).not.toContain("收起");
    expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("does not reserve empty width after removing the collapse button", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });
    stubVisualViewport({
      width: 1200,
      height: 700,
      offsetTop: 0,
      offsetLeft: 0,
    });

    renderQuickBar({
      collapseAvailable: true,
      collapsed: false,
    });

    const shellRows = screen.getByTestId("terminal-quickbar-shell-rows");
    expect(shellRows.style.paddingRight).toBe("");

    const rows = screen.getAllByTestId(/quickbar-fixed-cluster-(top|bottom)/);
    expect(rows).toHaveLength(2);
    const topRowShell = rows[0].closest('[data-quickbar-shell-row="true"]') as
      | HTMLDivElement
      | null;
    const bottomRowShell = rows[1].closest('[data-quickbar-shell-row="true"]') as
      | HTMLDivElement
      | null;

    expect(topRowShell).not.toBeNull();
    expect(bottomRowShell).not.toBeNull();
    expect(topRowShell?.style.paddingRight).toBe("6px");
    expect(bottomRowShell?.style.paddingRight).toBe("6px");
  });

  it("keeps a keyboard button available when collapsed in portrait", () => {
    const onToggleKeyboard = vi.fn();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 840,
    });
    stubVisualViewport({
      width: 390,
      height: 840,
      offsetTop: 0,
      offsetLeft: 0,
    });

    renderQuickBar({
      collapseAvailable: true,
      collapsed: true,
      onToggleKeyboard,
    });

    expect(screen.queryByTestId("terminal-quickbar-shell-rows")).toBeNull();
    expect(
      screen.getByTestId("terminal-quickbar-collapsed-keyboard"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "键盘" }));
    expect(onToggleKeyboard).toHaveBeenCalledTimes(1);
  });

  it("shows floating quick menu content after tapping the toggle in floating-collapsed shell mode", async () => {
    renderQuickBar({
      shellMode: "floating-collapsed",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );

    await waitFor(() => {
      expect(screen.getByText("快捷输入")).not.toBeNull();
      expect(screen.queryByTestId("terminal-quickbar-shell-rows")).toBeNull();
    });
  });

  it("marks collapsed and floating-menu quickbar surfaces as transparent", () => {
    const collapsedView = renderQuickBar({
      shellMode: "floating-collapsed",
      collapsed: true,
    });
    expect(
      collapsedView.container.querySelector(".zterm-neo-quickbar")?.getAttribute("data-quickbar-surface"),
    ).toBe("transparent");
    collapsedView.unmount();

    const expandedView = renderQuickBar();
    const root = expandedView.container.querySelector(".zterm-neo-quickbar");
    expect(root?.getAttribute("data-quickbar-surface")).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: "Toggle floating quick menu" }));
    expect(root?.getAttribute("data-quickbar-surface")).toBe("transparent");
  });

  it("exposes real quick and clipboard tabs in the floating menu", async () => {
    renderQuickBar({
      shellMode: "floating-collapsed",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );

    expect(screen.getByRole("button", { name: "快捷" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "剪贴板" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "" })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "剪贴板" }));
    expect(screen.getByRole("button", { name: "读取系统剪贴板" })).toBeTruthy();
  });

  it("routes visible tool bar actions through explicit callbacks and keeps upload/sync semantics correct", async () => {
    const onOpenFileTransfer = vi.fn();
    const onFileAttach = vi.fn();
    const onToggleCopyMode = vi.fn();
    const onToggleAbsoluteLineNumbers = vi.fn();
    const onRequestRemoteScreenshot = vi.fn().mockResolvedValue(undefined);

    renderQuickBar({
      onOpenFileTransfer,
      onFileAttach,
      onToggleCopyMode,
      onToggleAbsoluteLineNumbers,
      onRequestRemoteScreenshot,
    });

    // First fixed button is now "拷贝" (was "状态"), calls onToggleCopyMode
    fireEvent.click(screen.getByRole("button", { name: "拷贝" }));
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    fireEvent.click(screen.getByRole("button", { name: "同步" }));
    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    fireEvent.click(screen.getByRole("button", { name: "行号" }));

    await waitFor(() => {
      expect(onOpenFileTransfer).toHaveBeenCalledTimes(1);
      expect(onOpenFileTransfer).toHaveBeenNthCalledWith(1, "sync");
      expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
      expect(onToggleAbsoluteLineNumbers).toHaveBeenCalledTimes(1);
      expect(onRequestRemoteScreenshot).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "文件浏览" }));
    expect(onOpenFileTransfer).toHaveBeenCalledTimes(2);
    expect(onOpenFileTransfer).toHaveBeenNthCalledWith(2, "browser");
    expect(screen.queryByText("快捷输入")).toBeNull();
    // The floating quick-menu bubble coexists with the file-browser entry.
    expect(
      screen.queryByRole("button", { name: "Toggle floating quick menu" }),
    ).not.toBeNull();
  });

  it("shows the file browser entry above the floating quick menu bubble", () => {
    const onCollapsedChange = vi.fn();
    const onOpenFileTransfer = vi.fn();

    renderQuickBar({
      collapseAvailable: true,
      collapsed: true,
      onCollapsedChange,
      onOpenFileTransfer,
    });

    fireEvent.click(screen.getByRole("button", { name: "文件浏览" }));

    expect(onOpenFileTransfer).toHaveBeenCalledWith("browser");
    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "文件浏览" })).not.toBeNull();
    // The quick-menu bubble stays available (split/quick-input entry) even
    // when the file-browser entry is present; collapsed label is 展开快捷栏.
    expect(
      screen.queryByRole("button", { name: "展开快捷栏" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Toggle floating quick menu" }),
    ).toBeNull();
  });

  it("keeps the file browser entry draggable without opening it", async () => {
    const onOpenFileTransfer = vi.fn();

    renderQuickBar({ onOpenFileTransfer });

    const fileBrowserButton = screen.getByRole("button", { name: "文件浏览" });
    Object.defineProperty(fileBrowserButton, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 100,
        left: 40,
        right: 88,
        bottom: 148,
        width: 48,
        height: 48,
        x: 40,
        y: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(fileBrowserButton, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 48,
      clientY: 108,
    });
    fireEvent.pointerMove(fileBrowserButton, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 108,
      clientY: 168,
    });
    fireEvent.pointerUp(fileBrowserButton, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 108,
      clientY: 168,
    });
    fireEvent.click(fileBrowserButton);

    expect(onOpenFileTransfer).not.toHaveBeenCalled();
    await waitFor(() => {
      const position = JSON.parse(localStorage.getItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY) || "{}");
      expect(position.x).toBe(100);
      expect(position.y).toBe(160);
    });
  });

  it("activates copy mode immediately from pointer press and suppresses the follow-up click", () => {
    const onToggleCopyMode = vi.fn();

    renderQuickBar({ onToggleCopyMode });

    const copyButton = screen.getByRole("button", { name: "拷贝" });
    fireEvent.pointerDown(copyButton, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(copyButton, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(copyButton);

    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
  });

  it("activates copy mode immediately from touch start and suppresses the follow-up click", () => {
    const onToggleCopyMode = vi.fn();

    renderQuickBar({ onToggleCopyMode });

    const copyButton = screen.getByRole("button", { name: "拷贝" });
    fireEvent.touchStart(copyButton, {
      touches: [{ clientX: 20, clientY: 20 }],
    });
    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
    fireEvent.touchEnd(copyButton, {
      changedTouches: [{ clientX: 20, clientY: 20 }],
    });
    fireEvent.click(copyButton);

    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
  });

  it("still activates copy mode after a long press before release", () => {
    vi.useFakeTimers();
    const onToggleCopyMode = vi.fn();

    renderQuickBar({ onToggleCopyMode });

    const copyButton = screen.getByRole("button", { name: "拷贝" });
    fireEvent.pointerDown(copyButton, { pointerId: 1, clientX: 20, clientY: 20 });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    fireEvent.pointerUp(copyButton, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.click(copyButton);

    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
  });

  it("keeps click as a fallback for copy mode when no press event arrives", () => {
    const onToggleCopyMode = vi.fn();

    renderQuickBar({ onToggleCopyMode });

    fireEvent.click(screen.getByRole("button", { name: "拷贝" }));

    expect(onToggleCopyMode).toHaveBeenCalledTimes(1);
  });

  it("routes image/file entries directly through system pickers and keeps sync on the sheet", async () => {
    const onOpenFileTransfer = vi.fn();
    const onImagePaste = vi.fn();
    const onFileAttach = vi.fn();
    renderQuickBar({ onOpenFileTransfer, onImagePaste, onFileAttach });

    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    expect(inputs).toHaveLength(2);
    const imageInput = inputs.find((input) => input.accept === "image/*");
    const fileInput = inputs.find((input) => input.accept !== "image/*");
    expect(imageInput).toBeTruthy();
    expect(fileInput).toBeTruthy();
    expect(imageInput?.multiple).toBe(true);
    const imageInputClickSpy = vi.spyOn(imageInput!, "click");
    const fileInputClickSpy = vi.spyOn(fileInput!, "click");

    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(imageInputClickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("transfer-entry-overlay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(fileInputClickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("transfer-entry-overlay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "同步" }));

    expect(onOpenFileTransfer).toHaveBeenCalledTimes(1);
    expect(onOpenFileTransfer).toHaveBeenNthCalledWith(1, "sync");

    await act(async () => {
      fireEvent.change(imageInput!, {
        target: {
          files: [new File(["image"], "photo.png", { type: "image/png" })],
        },
      });
    });
    await act(async () => {
      fireEvent.change(fileInput!, {
        target: {
          files: [
            new File(["file"], "archive.zip", { type: "application/zip" }),
          ],
        },
      });
    });

    expect(onImagePaste).toHaveBeenCalledWith("session-1", expect.any(File));
    expect(onImagePaste.mock.calls[0][1].name).toBe("photo.png");
    expect(onFileAttach).toHaveBeenCalledWith("session-1", expect.any(File));
    expect(onFileAttach.mock.calls[0][1].name).toBe("archive.zip");
  });

  it("uploads multiple images sequentially, caps the batch at 9, and shows progress feedback", async () => {
    const onImagePaste = vi.fn<
      [string, File],
      Promise<void>
    >(async () => {
      await Promise.resolve();
    });
    renderQuickBar({ onImagePaste });

    const imageInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).find((input) => input.accept === "image/*");
    expect(imageInput).toBeTruthy();

    const files = Array.from({ length: 10 }, (_, index) =>
      new File([`image-${index}`], `photo-${index + 1}.png`, {
        type: "image/png",
      }),
    );

    await act(async () => {
      fireEvent.change(imageInput!, {
        target: {
          files,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onImagePaste).toHaveBeenCalledTimes(9);
    });

    expect(onImagePaste).toHaveBeenCalledTimes(9);
    const uploadedNames = onImagePaste.mock.calls.map(
      (call) => (call[1] as File | undefined)?.name,
    );
    expect(uploadedNames).toEqual([
      "photo-1.png",
      "photo-2.png",
      "photo-3.png",
      "photo-4.png",
      "photo-5.png",
      "photo-6.png",
      "photo-7.png",
      "photo-8.png",
      "photo-9.png",
    ]);
    expect(screen.queryByTestId("terminal-quickbar-image-upload-progress")).toBeNull();
    expect(screen.getByText("已发送 9 张图片")).toBeTruthy();
  });

  it("keeps native image and file picker clicks synchronous before keyboard hide resolves", async () => {
    vi.useFakeTimers();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const hideImage = createDeferred<void>();
    const hideFile = createDeferred<void>();
    vi.mocked(Keyboard.hide)
      .mockImplementationOnce(() => hideImage.promise)
      .mockImplementationOnce(() => hideFile.promise);
    const onImagePaste = vi.fn();
    const onFileAttach = vi.fn();
    renderQuickBar({
      keyboardVisible: true,
      onImagePaste,
      onFileAttach,
    });

    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    const imageInput = inputs.find((input) => input.accept === "image/*");
    const fileInput = inputs.find((input) => input.accept !== "image/*");
    expect(imageInput).toBeTruthy();
    expect(fileInput).toBeTruthy();
    const imageInputClickSpy = vi.spyOn(imageInput!, "click");
    const fileInputClickSpy = vi.spyOn(fileInput!, "click");

    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(imageInputClickSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Keyboard.hide)).toHaveBeenCalledTimes(1);
    expect(fileInputClickSpy).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(fileInputClickSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Keyboard.hide)).toHaveBeenCalledTimes(2);

    hideImage.resolve();
    hideFile.resolve();
    await Promise.resolve();
  });

  it("prefers showPicker when the browser exposes a native picker API", () => {
    const onImagePaste = vi.fn();
    renderQuickBar({ onImagePaste });

    const imageInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).find((input) => input.accept === "image/*");
    expect(imageInput).toBeTruthy();

    const showPickerSpy = vi.fn();
    Object.defineProperty(imageInput!, "showPicker", {
      configurable: true,
      value: showPickerSpy,
    });
    const clickSpy = vi.spyOn(imageInput!, "click");

    fireEvent.click(screen.getByRole("button", { name: "图片" }));

    expect(showPickerSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("opens image picker directly in landscape without transfer-entry side sheet", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });
    stubVisualViewport({
      width: 1200,
      height: 700,
      offsetTop: 0,
      offsetLeft: 0,
    });

    renderQuickBar();
    const imageInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).find((input) => input.accept === "image/*");
    expect(imageInput).toBeTruthy();
    const imageInputClickSpy = vi.spyOn(imageInput!, "click");

    fireEvent.click(screen.getByRole("button", { name: "图片" }));

    expect(imageInputClickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("transfer-entry-overlay")).toBeNull();
    expect(screen.queryByTestId("transfer-entry-sheet")).toBeNull();
  });

  it("keeps image file and sync buttons on physically separate quickbar entry handlers", () => {
    const onOpenFileTransfer = vi.fn();
    renderQuickBar({ onOpenFileTransfer });

    const imageButton = screen.getByRole("button", { name: "图片" });
    const fileButton = screen.getByRole("button", { name: "文件" });
    const syncButton = screen.getByRole("button", { name: "同步" });

    expect(imageButton.getAttribute("data-transfer-tool-button")).toBe(
      "image-picker-button",
    );
    expect(fileButton.getAttribute("data-transfer-tool-button")).toBe(
      "file-picker-button",
    );
    expect(syncButton.getAttribute("data-transfer-tool-button")).toBe(
      "sync-sheet-button",
    );

    expect(imageButton.getAttribute("data-transfer-tool-button")).not.toBe(
      fileButton.getAttribute("data-transfer-tool-button"),
    );
    expect(syncButton.getAttribute("data-transfer-tool-button")).not.toBe(
      imageButton.getAttribute("data-transfer-tool-button"),
    );
  });

  it("shows screenshot transfer state on the visible third-row toolbar while keeping keyboard in the old fixed spot", async () => {
    renderQuickBar({
      remoteScreenshotStatus: "transferring",
    });

    expect(screen.getByRole("button", { name: "键盘" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "传图中" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "截图" })).toBeNull();
  });

  it("deduplicates visible shortcut rows when saved shortcuts overlap built-in presets", async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "custom-tab",
          label: "我的 Tab",
          sequence: "\t",
          order: 0,
          row: "top-scroll",
        },
        {
          id: "custom-enter",
          label: "我的回车",
          sequence: "\r",
          order: 1,
          row: "top-scroll",
        },
        {
          id: "custom-paste",
          label: "我的粘贴",
          sequence: "\x16",
          order: 0,
          row: "bottom-scroll",
        },
        {
          id: "custom-senter",
          label: "我的换行",
          sequence: "\n",
          order: 1,
          row: "bottom-scroll",
        },
      ],
    });

    expect(screen.getAllByRole("button", { name: "我的 Tab" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "我的回车" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "我的粘贴" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "我的换行" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste" })).toBeNull();
    expect(screen.queryByRole("button", { name: "S-Enter" })).toBeNull();
  });

  it("blocks non-interactive shell clicks from bubbling to terminal layer", async () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <TerminalQuickBar
          activeSessionId="session-1"
          quickActions={[]}
          shortcutActions={[]}
          sessionDraft=""
          onSendSequence={vi.fn()}
          onSessionDraftChange={vi.fn()}
          onSessionDraftSend={vi.fn()}
          onQuickActionsChange={vi.fn()}
          onShortcutActionsChange={vi.fn()}
          onOpenScheduleComposer={vi.fn()}
          onMeasuredHeightChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId("terminal-quickbar-shell-rows"));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("reports DOM editor focus transitions for quick input textarea", async () => {
    const onEditorDomFocusChange = vi.fn();
    renderQuickBar({
      onEditorDomFocusChange,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );

    const textarea = screen.getByPlaceholderText(
      "预输入内容，按 session 持久化",
    );
    fireEvent.focus(textarea);
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(onEditorDomFocusChange).toHaveBeenCalledWith(true);
      expect(onEditorDomFocusChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("keeps local quick-input textarea value stable while parent rerenders with stale sessionDraft during active editing", async () => {
    const onSessionDraftChange = vi.fn();

    function Harness() {
      const [sessionDraft] = React.useState("");
      const [tick, setTick] = React.useState(0);
      return (
        <div>
          <button
            type="button"
            onClick={() => setTick((current) => current + 1)}
          >
            rerender
          </button>
          <div data-testid="tick">{tick}</div>
          <TerminalQuickBar
            activeSessionId="session-1"
            quickActions={[]}
            shortcutActions={[]}
            sessionDraft={sessionDraft}
            onSendSequence={vi.fn()}
            onSessionDraftChange={(value) => {
              onSessionDraftChange(value);
              // simulate parent persistence lag: do not immediately update sessionDraft prop
            }}
            onSessionDraftSend={vi.fn()}
            onQuickActionsChange={vi.fn()}
            onShortcutActionsChange={vi.fn()}
            onOpenScheduleComposer={vi.fn()}
            onMeasuredHeightChange={vi.fn()}
          />
        </div>
      );
    }

    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    const textarea = screen.getByPlaceholderText(
      "预输入内容，按 session 持久化",
    ) as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "draft typing" } });

    expect(textarea.value).toBe("draft typing");
    expect(onSessionDraftChange).toHaveBeenLastCalledWith("draft typing");

    fireEvent.click(screen.getByText("rerender"));

    await waitFor(() => {
      expect(screen.getByTestId("tick").textContent).toBe("1");
      expect(
        (
          screen.getByPlaceholderText(
            "预输入内容，按 session 持久化",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("draft typing");
    });
  });

  it("sends floating quick action on double tap with trailing enter", async () => {
    const onSendSequence = vi.fn();
    renderQuickBar({
      quickActions: [
        {
          id: "qa-1",
          label: "ls",
          sequence: "ls -la",
          order: 0,
        },
      ],
      onSendSequence,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    const actionLabel = screen.getByText("ls");
    const actionButton = actionLabel.closest("button");
    expect(actionButton).not.toBeNull();
    fireEvent.click(actionButton as HTMLButtonElement);
    expect(onSendSequence).not.toHaveBeenCalled();
    fireEvent.click(actionButton as HTMLButtonElement);

    await waitFor(() => {
      expect(onSendSequence).toHaveBeenCalledWith("ls -la\r");
    });
  });

  it("keeps generic remote-window controls usable while greying terminal-only actions", async () => {
    const onSendSequence = vi.fn();
    const onToggleKeyboard = vi.fn();
    const onToggleCopyMode = vi.fn();
    const onSetSplitCount = vi.fn();

    renderQuickBar({
      remoteWindowInputActive: true,
      splitAvailable: true,
      splitCountOptions: [1, 2],
      currentSplitCount: 1,
      onSendSequence,
      onToggleKeyboard,
      onToggleCopyMode,
      onSetSplitCount,
    });

    const copyButton = screen.getByRole("button", { name: "拷贝" }) as HTMLButtonElement;
    const splitButton = screen.getByRole("button", { name: "2 分屏" }) as HTMLButtonElement;
    const keyboardButton = screen.getByRole("button", { name: "键盘" }) as HTMLButtonElement;
    const arrowButton = screen.getByRole("button", { name: "↑" }) as HTMLButtonElement;

    expect(copyButton.disabled).toBe(true);
    expect(copyButton.getAttribute("aria-disabled")).toBe("true");
    expect(splitButton.disabled).toBe(true);
    expect(keyboardButton.disabled).toBe(false);
    expect(arrowButton.disabled).toBe(false);

    fireEvent.click(copyButton);
    fireEvent.click(splitButton);
    expect(onToggleCopyMode).not.toHaveBeenCalled();
    expect(onSetSplitCount).not.toHaveBeenCalled();

    fireEvent.click(keyboardButton);
    expect(onToggleKeyboard).toHaveBeenCalledTimes(1);

    fireEvent.click(arrowButton);
    expect(onSendSequence).toHaveBeenCalledWith("\x1b[A");
  });

  it("uses combo preview as default shortcut label when saving ctrl combination", async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);
    expect(screen.getByText("快捷按键设置")).not.toBeNull();
    expect(screen.getByText("当前滚动快捷键")).not.toBeNull();
    expect(screen.getByText("第二行（单按键）")).not.toBeNull();
    expect(screen.getByText("第三行（组合键）")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ 添加组合键" }));
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("快捷键名称 / 显示名称"),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    fireEvent.change(
      screen.getByPlaceholderText("输入组合键里的目标字符，例如 c"),
      {
        target: { value: "c" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    fireEvent.click(screen.getByRole("button", { name: "添加快捷键" }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(Array.isArray(latest)).toBe(true);
      expect(latest[latest.length - 1]?.label).toBe("Ctrl + C");
      expect(latest[latest.length - 1]?.row).toBe("bottom-scroll");
    });
  });

  it("saves shift as a one-shot modifier for the next combination key", async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);
    expect(screen.getByText("快捷按键设置")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ 添加组合键" }));
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("快捷键名称 / 显示名称"),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Shift" }));
    fireEvent.click(
      within(screen.getByTestId("shortcut-editor-scroll")).getByRole(
        "button",
        { name: "←" },
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("输入组合键里的目标字符，例如 c"),
      {
        target: { value: "a" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    fireEvent.click(screen.getByRole("button", { name: "添加快捷键" }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(Array.isArray(latest)).toBe(true);
      expect(latest[latest.length - 1]?.label).toBe("Shift + ← + a");
      expect(latest[latest.length - 1]?.sequence).toBe("\u001b[1;2Da");
      expect(latest[latest.length - 1]?.row).toBe("bottom-scroll");
    });
  });

  it("keeps single-key row and combo row separated in shortcut manager", async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "+ 添加单按键" }));
    await waitFor(() => {
      expect(screen.getByText("当前编辑：第二行单按键")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    fireEvent.click(screen.getByRole("button", { name: "添加快捷键" }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(latest[latest.length - 1]?.label).toBe("Return");
      expect(latest[latest.length - 1]?.row).toBe("top-scroll");
    });
  });

  it("blocks saving multi-key content into first single-key row", async () => {
    renderQuickBar();

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加单按键" }));

    expect(screen.queryByRole("button", { name: "Ctrl" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("输入单个字母/数字/符号"), {
      target: { value: "cd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入" }));

    expect(screen.getByText("第二行只支持单个按键。")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "添加快捷键" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps enter decoded as single key when editing existing shortcut", async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-enter",
          label: "Enter",
          sequence: "\r",
          order: 0,
          row: "top-scroll",
        },
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "编辑 Enter" }));

    await waitFor(() => {
      expect(screen.getByText("当前编辑：第二行单按键")).not.toBeNull();
      expect(
        (
          screen.getByPlaceholderText(
            "快捷键名称 / 显示名称",
          ) as HTMLInputElement
        ).value,
      ).toBe("Enter");
      expect(
        (
          screen.getByPlaceholderText(
            "点击下方按钮选择单个按键",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("Enter");
    });
  });

  it("allows renaming existing shortcut from explicit edit action", async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-copy",
          label: "Ctrl + C",
          sequence: "\u0003",
          order: 0,
          row: "bottom-scroll",
        },
      ],
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "编辑 Ctrl + C" }));

    await waitFor(() => {
      expect(screen.getByText("编辑快捷键")).not.toBeNull();
      expect(
        (
          screen.getByPlaceholderText(
            "快捷键名称 / 显示名称",
          ) as HTMLInputElement
        ).value,
      ).toBe("Ctrl + C");
    });

    fireEvent.change(screen.getByPlaceholderText("快捷键名称 / 显示名称"), {
      target: { value: "复制当前行" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(latest).toEqual([
        {
          id: "shortcut-copy",
          label: "复制当前行",
          sequence: "\u0003",
          order: 0,
          row: "bottom-scroll",
        },
      ]);
    });
  });

  it("shows shortcut management list and allows delete from list page", async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-1",
          label: "Ctrl + C",
          sequence: "\u0003",
          order: 0,
          row: "bottom-scroll",
        },
      ],
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    expect(screen.getByText("当前滚动快捷键")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "删除 Ctrl + C" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除 Ctrl + C" }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalledWith([]);
    });
  });

  it("renders special shortcut keys with compact symbols instead of empty previews", async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-tab",
          label: "Tab",
          sequence: "\t",
          order: 0,
          row: "top-scroll",
        },
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    const detailButton = screen.getByRole("button", { name: "查看 Tab 详情" });
    expect(
      detailButton.querySelector('[data-shortcut-keycap="Tab"]'),
    ).not.toBeNull();
    expect(detailButton.textContent).not.toContain("(空)");
  });

  it("renders terminal base special keys with familiar icon glyphs", async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "s-tab",
          label: "Tab",
          sequence: "\t",
          order: 0,
          row: "top-scroll",
        },
        {
          id: "s-enter",
          label: "Enter",
          sequence: "\r",
          order: 1,
          row: "top-scroll",
        },
        {
          id: "s-space",
          label: "Space",
          sequence: " ",
          order: 2,
          row: "top-scroll",
        },
      ],
    });

    expect(
      screen
        .getAllByRole("button", { name: "Tab" })
        .some((button) =>
          button.querySelector('[data-shortcut-keycap=\"Tab\"]'),
        ),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Enter" })
        .some((button) =>
          button.querySelector('[data-shortcut-keycap=\"Enter\"]'),
        ),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Space" })
        .some((button) =>
          button.querySelector('[data-shortcut-space-visual=\"true\"]'),
        ),
    ).toBe(true);
  });

  it("renders space shortcut as a long narrow keycap visual in settings list", async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-space",
          label: "Space",
          sequence: " ",
          order: 0,
          row: "top-scroll",
        },
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    const detailButton = screen.getByRole("button", {
      name: "查看 Space 详情",
    });
    expect(
      detailButton.querySelector('[data-shortcut-space-visual="true"]'),
    ).not.toBeNull();
    expect(detailButton.textContent).toContain("Space");
  });

  it("uses a dedicated scroll container for shortcut settings sheet", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 754,
    });
    stubVisualViewport({
      width: 347.4285583496094,
      height: 456.8571472167969,
      offsetTop: 0,
    });

    renderQuickBar({
      shortcutActions: [
        {
          id: "shortcut-1",
          label: "Ctrl + C",
          sequence: "\u0003",
          order: 0,
          row: "bottom-scroll",
        },
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    const scrollContainer = screen.getByTestId("shortcut-editor-scroll");
    const sheet = scrollContainer.parentElement;
    const overlay = sheet?.parentElement;
    const style = scrollContainer.getAttribute("style") || "";
    expect(style).toContain("flex: 1");
    expect(style).toContain("min-height: 0");
    expect(style).toContain("overflow-y: auto");
    expect(style).toContain("overflow-x: hidden");
    expect(style).toContain("touch-action: pan-y");
    expect(sheet?.getAttribute("style") || "").toContain("height: 441px");
    expect(overlay?.getAttribute("style") || "").toContain(
      "padding-bottom: 567px",
    );
    expect(
      screen.getByTestId("shortcut-editor-list").getAttribute("style") || "",
    ).toContain("min-height: max-content");
  });

  it("lifts quick action editor above visual viewport keyboard occlusion", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 754,
    });
    stubVisualViewport({
      width: 347.4285583496094,
      height: 456.8571472167969,
      offsetTop: 0,
    });

    renderQuickBar({
      quickActions: [
        {
          id: "qa-1",
          label: "ls",
          sequence: "ls -la",
          order: 0,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    );
    fireEvent.click(screen.getByLabelText("Edit ls"));

    await waitFor(() => {
      expect(screen.getByText("快捷输入设置")).not.toBeNull();
    });

    const scrollContainer = screen.getByTestId("quick-action-editor-scroll");
    const sheet = scrollContainer.parentElement;
    const overlay = sheet?.parentElement;
    expect(sheet?.getAttribute("style") || "").toContain("height: 441px");
    expect(overlay?.getAttribute("style") || "").toContain(
      "padding-bottom: 567px",
    );
  });

  it("resets shortcut editor scrollTop when switching from list to form", async () => {
    renderQuickBar({
      shortcutActions: [
        { id: "s1", label: "Tab", sequence: "\t", order: 0, row: "top-scroll" },
        {
          id: "s2",
          label: "Enter",
          sequence: "\r",
          order: 1,
          row: "top-scroll",
        },
        {
          id: "s3",
          label: "Space",
          sequence: " ",
          order: 2,
          row: "top-scroll",
        },
        {
          id: "s4",
          label: "S-Enter",
          sequence: "\n",
          order: 0,
          row: "bottom-scroll",
        },
        {
          id: "s5",
          label: "Esc",
          sequence: "\u001b",
          order: 1,
          row: "bottom-scroll",
        },
        {
          id: "s6",
          label: "Bksp",
          sequence: "\u007f",
          order: 2,
          row: "bottom-scroll",
        },
        {
          id: "s7",
          label: "Paste",
          sequence: "\u0016",
          order: 3,
          row: "bottom-scroll",
        },
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    const scrollContainer = screen.getByTestId("shortcut-editor-scroll");
    scrollContainer.scrollTop = 188;
    fireEvent.click(screen.getByRole("button", { name: "+ 添加组合键" }));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("快捷键名称 / 显示名称"),
      ).not.toBeNull();
      expect(screen.getByTestId("shortcut-editor-scroll").scrollTop).toBe(0);
    });
  });

  it("hides floating bubble while shortcut editor is open", async () => {
    renderQuickBar();

    expect(
      screen.getByRole("button", { name: "Toggle floating quick menu" }),
    ).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "+" })[0]);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Toggle floating quick menu" }),
      ).toBeNull();
    });
  });

  it("starts repeat mode on long press and stops on next short tap", async () => {
    vi.useFakeTimers();
    const onSendSequence = vi.fn();

    renderQuickBar({
      onSendSequence,
      shortcutActions: [
        {
          id: "shortcut-enter",
          label: "Enter",
          sequence: "\r",
          order: 0,
          row: "bottom-scroll",
        },
      ],
    });

    const enterButton = screen.getAllByRole("button", {
      name: "Enter",
    })[0] as HTMLButtonElement;

    fireEvent.pointerDown(enterButton, { pointerId: 1, pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(720);
    });

    expect(onSendSequence.mock.calls.length).toBeGreaterThan(2);
    expect(enterButton.getAttribute("aria-pressed")).toBe("true");

    const callCountBeforeStop = onSendSequence.mock.calls.length;
    fireEvent.click(enterButton);

    act(() => {
      vi.advanceTimersByTime(240);
    });

    expect(enterButton.getAttribute("aria-pressed")).toBe("false");
    expect(onSendSequence).toHaveBeenCalledTimes(callCountBeforeStop);
    vi.useRealTimers();
  });

  it("uses two shell rows in landscape mode", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });

    renderQuickBar();

    expect(
      document.querySelectorAll('[data-quickbar-shell-row="true"]').length,
    ).toBe(2);
  });

  it("shows split controls in the always-visible tool row when the workspace marks split available", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    stubVisualViewport({
      width: 800,
      height: 1200,
      offsetTop: 0,
      offsetLeft: 0,
    });

    renderQuickBar({
      splitAvailable: true,
      splitVisible: false,
      splitCountOptions: [2],
      onSetSplitCount: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "2 分屏" })).not.toBeNull();
  });

  it("hides split controls when the workspace marks split unavailable", async () => {
    renderQuickBar({
      splitAvailable: false,
      splitVisible: false,
      splitCountOptions: [2],
      onSetSplitCount: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "2 分屏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启分屏" })).toBeNull();
  });

  it("routes visible split controls to explicit split count changes", () => {
    const onSetSplitCount = vi.fn();
    renderQuickBar({
      splitAvailable: true,
      splitVisible: false,
      splitCountOptions: [2],
      onSetSplitCount,
    });

    fireEvent.click(screen.getByRole("button", { name: "2 分屏" }));

    expect(onSetSplitCount).toHaveBeenCalledWith(2);
  });

  it("does not invent unsupported split counts beyond the workspace provided options", () => {
    renderQuickBar({
      splitAvailable: true,
      splitVisible: true,
      currentSplitCount: 2,
      splitCountOptions: [1, 2],
      onSetSplitCount: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "1 分屏" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "2 分屏 ✓" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "3 分屏" })).toBeNull();
  });

  it("renders and routes the four-pane option when the workspace provides it", () => {
    const onSetSplitCount = vi.fn();
    renderQuickBar({
      splitAvailable: true,
      splitVisible: true,
      currentSplitCount: 3,
      splitCountOptions: [1, 2, 3, 4],
      onSetSplitCount,
    });

    fireEvent.click(screen.getByRole("button", { name: "4 分屏" }));

    expect(onSetSplitCount).toHaveBeenCalledWith(4);
  });

  it("renders only one visible Paste shortcut when defaults and saved shortcuts overlap", () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: "saved-paste",
          label: "Paste",
          sequence: "\x16",
          order: 0,
          row: "bottom-scroll",
        },
      ],
    });

    expect(screen.getAllByRole("button", { name: "Paste" })).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import {
  appendWindowIdToRendererUrl,
  buildMacRendererLoadTarget,
  createMacWindowManager,
  createMacWindowMenuTemplate,
  createMemoryMacWindowRecordStore,
  type MacManagedWindow,
} from '../../electron/window-manager.js';

class FakeWindow implements MacManagedWindow {
  readonly options: BrowserWindowConstructorOptions;
  readonly listeners = new Map<string, Array<() => void>>();
  readonly webContents = {
    on: vi.fn(),
  };
  loadURL = vi.fn();
  loadFile = vi.fn();
  maximize = vi.fn();
  show = vi.fn();
  focus = vi.fn();
  destroyed = false;

  constructor(options: BrowserWindowConstructorOptions) {
    this.options = options;
  }

  once(event: 'ready-to-show' | 'closed', listener: () => void): this {
    return this.on(event, listener);
  }

  on(event: 'focus' | 'closed' | 'ready-to-show', listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string) {
    (this.listeners.get(event) ?? []).forEach((listener) => listener());
  }

  isDestroyed() {
    return this.destroyed;
  }

  getBounds(): Rectangle {
    return { x: 10, y: 20, width: 1440, height: 900 };
  }
}

describe('MacWindowManager', () => {
  it('adds windowId to dev-server renderer URLs', () => {
    expect(appendWindowIdToRendererUrl('http://127.0.0.1:5174/?foo=bar', 'window-a')).toBe(
      'http://127.0.0.1:5174/?foo=bar&windowId=window-a',
    );
  });

  it('builds file renderer load targets with a windowId query', () => {
    expect(buildMacRendererLoadTarget({
      devServerUrl: null,
      rendererIndexPath: '/tmp/index.html',
      windowId: 'window-a',
    })).toEqual({
      kind: 'file',
      filePath: '/tmp/index.html',
      query: { windowId: 'window-a' },
    });
  });

  it('creates managed BrowserWindows with stable window records', () => {
    const windows: FakeWindow[] = [];
    const manager = createMacWindowManager({
      createBrowserWindow: (options) => {
        const window = new FakeWindow(options);
        windows.push(window);
        return window;
      },
      preloadPath: '/tmp/preload.cjs',
      rendererIndexPath: '/tmp/index.html',
      getDevServerUrl: () => null,
      createWindowId: () => `window-${windows.length + 1}`,
      now: () => 100,
      logger: { error: vi.fn() },
    });

    const created = manager.createWindow();
    expect(created.windowId).toBe('window-1');
    expect(windows[0].options.webPreferences).toMatchObject({ preload: '/tmp/preload.cjs' });
    expect(windows[0].loadFile).toHaveBeenCalledWith('/tmp/index.html', { query: { windowId: 'window-1' } });
    expect(manager.getWindowRecord('window-1')).toMatchObject({
      windowId: 'window-1',
      workspaceId: 'workspace:window-1',
      title: 'ZTerm',
    });

    windows[0].emit('ready-to-show');
    expect(windows[0].maximize).toHaveBeenCalledTimes(1);
    expect(windows[0].show).toHaveBeenCalledTimes(1);
    expect(windows[0].focus).toHaveBeenCalledTimes(1);
  });

  it('focuses an existing window on activate instead of creating a duplicate', () => {
    const windows: FakeWindow[] = [];
    const manager = createMacWindowManager({
      createBrowserWindow: (options) => {
        const window = new FakeWindow(options);
        windows.push(window);
        return window;
      },
      preloadPath: '/tmp/preload.cjs',
      rendererIndexPath: '/tmp/index.html',
      getDevServerUrl: () => null,
      createWindowId: () => `window-${windows.length + 1}`,
      now: () => 100 + windows.length,
      logger: { error: vi.fn() },
    });

    manager.createWindow();
    const restored = manager.restoreOrCreateWindow();

    expect(windows).toHaveLength(1);
    expect(restored.windowId).toBe('window-1');
    expect(windows[0].focus).toHaveBeenCalledTimes(1);
  });

  it('creates a new window after the previous managed window is closed', () => {
    const windows: FakeWindow[] = [];
    const manager = createMacWindowManager({
      createBrowserWindow: (options) => {
        const window = new FakeWindow(options);
        windows.push(window);
        return window;
      },
      preloadPath: '/tmp/preload.cjs',
      rendererIndexPath: '/tmp/index.html',
      getDevServerUrl: () => null,
      createWindowId: () => `window-${windows.length + 1}`,
      logger: { error: vi.fn() },
    });

    manager.createWindow();
    windows[0].emit('closed');
    const restored = manager.restoreOrCreateWindow();

    expect(windows).toHaveLength(2);
    expect(restored.windowId).toBe('window-2');
  });

  it('persists open window records across app quit and restores them with the same windowId', () => {
    const store = createMemoryMacWindowRecordStore();
    const firstWindows: FakeWindow[] = [];
    const firstManager = createMacWindowManager({
      createBrowserWindow: (options) => {
        const window = new FakeWindow(options);
        firstWindows.push(window);
        return window;
      },
      preloadPath: '/tmp/preload.cjs',
      rendererIndexPath: '/tmp/index.html',
      getDevServerUrl: () => null,
      createWindowId: () => `window-${firstWindows.length + 1}`,
      recordStore: store,
      logger: { error: vi.fn() },
    });
    firstManager.createWindow();
    firstManager.createWindow();
    firstManager.prepareForQuit();
    firstWindows.forEach((window) => window.emit('closed'));

    const restoredWindows: FakeWindow[] = [];
    const restoredManager = createMacWindowManager({
      createBrowserWindow: (options) => {
        const window = new FakeWindow(options);
        restoredWindows.push(window);
        return window;
      },
      preloadPath: '/tmp/preload.cjs',
      rendererIndexPath: '/tmp/index.html',
      getDevServerUrl: () => null,
      createWindowId: () => 'unexpected-window',
      recordStore: store,
      logger: { error: vi.fn() },
    });

    const restored = restoredManager.restoreWindows();

    expect(restored.map((item) => item.windowId)).toEqual(['window-1', 'window-2']);
    expect(restoredWindows[0].loadFile).toHaveBeenCalledWith('/tmp/index.html', { query: { windowId: 'window-1' } });
    expect(restoredWindows[1].loadFile).toHaveBeenCalledWith('/tmp/index.html', { query: { windowId: 'window-2' } });
  });

  it('exposes a New Window menu action bound to the window owner', () => {
    const newWindow = vi.fn();
    const template = createMacWindowMenuTemplate({ newWindow });
    const fileMenu = template.find((item) => item.label === 'File');
    const submenu = fileMenu?.submenu as Array<{ label?: string; click?: () => void }>;
    const newWindowItem = submenu.find((item) => item.label === 'New Window');

    newWindowItem?.click?.();

    expect(newWindow).toHaveBeenCalledTimes(1);
  });
});

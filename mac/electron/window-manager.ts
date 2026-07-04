import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions, Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createMainWindowOptions } from './window-options.js';

export interface MacManagedWindow {
  once(event: 'ready-to-show' | 'closed', listener: () => void): this;
  on(event: 'focus' | 'closed', listener: () => void): this;
  loadURL(url: string): Promise<unknown> | unknown;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<unknown> | unknown;
  maximize(): void;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  getBounds(): Rectangle;
  webContents: {
    on(event: 'console-message', listener: (event: unknown, level: number, message: string, line: number, sourceId: string) => void): void;
    on(event: 'render-process-gone', listener: (event: unknown, details: unknown) => void): void;
    on(event: 'unresponsive', listener: () => void): void;
  };
}

export interface MacWindowRecord {
  windowId: string;
  title: string;
  bounds?: Rectangle;
  workspaceId: string;
  lastFocusedAt: number;
}

export interface MacWindowRecordStore {
  load(): MacWindowRecord[];
  save(records: MacWindowRecord[]): void;
}

export interface MacRendererLoadTarget {
  kind: 'url' | 'file';
  url?: string;
  filePath?: string;
  query?: Record<string, string>;
}

export interface CreateMacWindowManagerOptions {
  createBrowserWindow(options: BrowserWindowConstructorOptions): MacManagedWindow;
  preloadPath: string;
  rendererIndexPath: string;
  getDevServerUrl(): string | null;
  now?: () => number;
  createWindowId?: () => string;
  recordStore?: MacWindowRecordStore;
  logger?: Pick<Console, 'error'>;
}

export interface MacWindowManager {
  createWindow(): { windowId: string; window: MacManagedWindow };
  restoreWindows(): Array<{ windowId: string; window: MacManagedWindow }>;
  restoreOrCreateWindow(): { windowId: string; window: MacManagedWindow };
  focusLastFocusedWindow(): { windowId: string; window: MacManagedWindow } | null;
  getWindowRecords(): MacWindowRecord[];
  getWindowRecord(windowId: string): MacWindowRecord | null;
  prepareForQuit(): void;
}

let nextWindowSequence = 1;

function createDefaultWindowId() {
  const random = randomUUID();
  nextWindowSequence += 1;
  return `mac-window-${random}`;
}

export function appendWindowIdToRendererUrl(devServerUrl: string, windowId: string) {
  const url = new URL(devServerUrl);
  url.searchParams.set('windowId', windowId);
  return url.toString();
}

export function buildMacRendererLoadTarget(options: {
  devServerUrl: string | null;
  rendererIndexPath: string;
  windowId: string;
}): MacRendererLoadTarget {
  if (options.devServerUrl) {
    return {
      kind: 'url',
      url: appendWindowIdToRendererUrl(options.devServerUrl, options.windowId),
    };
  }
  return {
    kind: 'file',
    filePath: options.rendererIndexPath,
    query: { windowId: options.windowId },
  };
}

export function createMacWindowMenuTemplate(actions: {
  newWindow(): void;
}): MenuItemConstructorOptions[] {
  return [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: actions.newWindow,
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      role: 'windowMenu',
    },
  ];
}

export function createMemoryMacWindowRecordStore(initial: MacWindowRecord[] = []): MacWindowRecordStore & {
  dump(): MacWindowRecord[];
} {
  let records = initial.map((record) => ({ ...record }));
  return {
    load() {
      return records.map((record) => ({ ...record }));
    },
    save(nextRecords: MacWindowRecord[]) {
      records = nextRecords.map((record) => ({ ...record }));
    },
    dump() {
      return records.map((record) => ({ ...record }));
    },
  };
}

export function createFileMacWindowRecordStore(filePath: string): MacWindowRecordStore {
  return {
    load() {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MacWindowRecord[];
      if (!Array.isArray(parsed)) {
        throw new Error('Invalid Mac window records: expected array');
      }
      return parsed.map((record) => ({
        ...record,
        bounds: record.bounds ? { ...record.bounds } : undefined,
      }));
    },
    save(records: MacWindowRecord[]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
    },
  };
}

export function createMacWindowManager(options: CreateMacWindowManagerOptions): MacWindowManager {
  const now = options.now ?? Date.now;
  const createWindowId = options.createWindowId ?? createDefaultWindowId;
  const logger = options.logger ?? console;
  const windows = new Map<string, MacManagedWindow>();
  const records = new Map<string, MacWindowRecord>();
  let preserveRecordsOnClose = false;

  function persistRecords() {
    options.recordStore?.save(Array.from(records.values()));
  }

  function updateRecord(windowId: string, updates: Partial<MacWindowRecord>) {
    const current = records.get(windowId);
    if (!current) {
      return;
    }
    records.set(windowId, {
      ...current,
      ...updates,
    });
    persistRecords();
  }

  function loadRenderer(window: MacManagedWindow, windowId: string) {
    const target = buildMacRendererLoadTarget({
      devServerUrl: options.getDevServerUrl(),
      rendererIndexPath: options.rendererIndexPath,
      windowId,
    });
    if (target.kind === 'url') {
      void window.loadURL(target.url!);
      return;
    }
    void window.loadFile(target.filePath!, { query: target.query });
  }

  function wireDiagnostics(window: MacManagedWindow) {
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error'];
      logger.error(`[RENDERER ${levels[level] || level}] ${message} (at ${sourceId}:${line})`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      logger.error('[RENDERER CRASHED]', JSON.stringify(details));
    });
    window.webContents.on('unresponsive', () => {
      logger.error('[RENDERER UNRESPONSIVE]');
    });
  }

  function createWindowWithRecord(restoredRecord?: MacWindowRecord) {
    const windowId = restoredRecord?.windowId || createWindowId();
    const window = options.createBrowserWindow({
      ...createMainWindowOptions(),
      webPreferences: {
        preload: options.preloadPath,
      },
    });
    windows.set(windowId, window);
    records.set(windowId, {
      windowId,
      title: 'ZTerm',
      ...restoredRecord,
      bounds: window.getBounds(),
      workspaceId: `workspace:${windowId}`,
      lastFocusedAt: restoredRecord?.lastFocusedAt ?? now(),
    });
    persistRecords();

    window.once('ready-to-show', () => {
      window.maximize();
      window.show();
      window.focus();
      updateRecord(windowId, {
        bounds: window.getBounds(),
        lastFocusedAt: now(),
      });
    });
    window.on('focus', () => {
      updateRecord(windowId, {
        bounds: window.getBounds(),
        lastFocusedAt: now(),
      });
    });
    window.on('closed', () => {
      windows.delete(windowId);
      if (!preserveRecordsOnClose) {
        records.delete(windowId);
        persistRecords();
      }
    });

    wireDiagnostics(window);
    loadRenderer(window, windowId);
    return { windowId, window };
  }

  function createWindow() {
    return createWindowWithRecord();
  }

  function focusLastFocusedWindow() {
    const candidates = Array.from(records.values())
      .sort((left, right) => right.lastFocusedAt - left.lastFocusedAt);
    for (const record of candidates) {
      const window = windows.get(record.windowId);
      if (!window || window.isDestroyed()) {
        windows.delete(record.windowId);
        records.delete(record.windowId);
        continue;
      }
      window.focus();
      updateRecord(record.windowId, {
        bounds: window.getBounds(),
        lastFocusedAt: now(),
      });
      return { windowId: record.windowId, window };
    }
    return null;
  }

  return {
    createWindow,
    restoreWindows() {
      const storedRecords = options.recordStore?.load() ?? [];
      if (storedRecords.length === 0) {
        return [createWindow()];
      }
      return storedRecords.map((record) => createWindowWithRecord(record));
    },
    restoreOrCreateWindow() {
      return focusLastFocusedWindow() ?? createWindow();
    },
    focusLastFocusedWindow,
    getWindowRecords() {
      return Array.from(records.values()).sort((left, right) => left.windowId.localeCompare(right.windowId));
    },
    getWindowRecord(windowId: string) {
      return records.get(windowId) ?? null;
    },
    prepareForQuit() {
      preserveRecordsOnClose = true;
      persistRecords();
    },
  };
}

export function resolveDefaultRendererIndexPath(electronDirname: string) {
  return path.join(electronDirname, '../../dist/index.html');
}

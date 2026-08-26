import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalTmuxManager } from './local-tmux.js';
import {
  createMacLocalFileSystemService,
  registerMacFileSystemIpcHandlers,
  resolveDefaultMacDownloadDir,
} from './file-system.js';
import {
  DESKTOP_GATEWAY_COMMAND_CHANNEL,
  DesktopCommandHandler,
  DesktopGatewayError,
} from '@zterm/desktop-gateway';
import {
  createMacWindowManager,
  createMacWindowMenuTemplate,
  createFileMacWindowRecordStore,
  resolveDefaultRendererIndexPath,
  type MacWindowManager,
} from './window-manager.js';
import {
  DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH,
  cleanupScreenshotHelperRuntimeState,
  persistScreenshotHelperRuntimeState,
  startScreenshotHelperServer,
  type ScreenshotHelperServerController,
} from './screenshot-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
type LocalBufferSyncRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; requestStartIndex: number; requestEndIndex: number; missingRanges?: Array<{ startIndex: number; endIndex: number }> };

const localTmuxManager = new LocalTmuxManager();
const localFileSystem = createMacLocalFileSystemService({
  defaultDownloadDir: resolveDefaultMacDownloadDir(),
});
let desktopGatewayGeneration = 0;
const desktopCommandHandler = new DesktopCommandHandler({
  getGeneration: () => desktopGatewayGeneration,
  setGeneration: (generation) => {
    desktopGatewayGeneration = generation;
  },
});
const alphaSmokeMode = process.argv.includes('--zterm-alpha-smoke');
const screenshotHelperOnlyMode = process.argv.includes('--screenshot-helper');
let screenshotHelperServer: ScreenshotHelperServerController | null = null;
let screenshotHelperWindow: BrowserWindow | null = null;
let macWindowManager: MacWindowManager | null = null;

process.on('uncaughtException', (err) => {
  console.error('[MAIN UNCAUGHT]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[MAIN UNHANDLED REJECTION]', err);
});

function getDevServerUrl() {
  const value = process.env.VITE_DEV_SERVER_URL;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isClientParams(value: unknown): value is { clientId: string } {
  return isRecord(value) && typeof value.clientId === 'string' && value.clientId.trim().length > 0;
}

function isTmuxConnectParams(value: unknown): value is {
  clientId: string;
  sessionName: string;
  cols: number;
  rows: number;
} {
  if (!isRecord(value)) return false;
  if (typeof value.clientId !== 'string' || value.clientId.trim().length === 0) return false;
  if (typeof value.sessionName !== 'string' || value.sessionName.trim().length === 0) return false;
  if (!isPositiveInt(value.cols)) return false;
  if (!isPositiveInt(value.rows)) return false;
  return true;
}

function isResizeParams(value: unknown): value is { clientId: string; cols: number; rows: number } {
  if (!isRecord(value)) return false;
  if (typeof value.clientId !== 'string' || value.clientId.trim().length === 0) return false;
  if (!isPositiveInt(value.cols)) return false;
  if (!isPositiveInt(value.rows)) return false;
  return true;
}

function isDirParams(value: unknown): value is { dirPath: string } {
  return isRecord(value) && typeof value.dirPath === 'string' && value.dirPath.trim().length > 0;
}

function isFileParams(value: unknown): value is { filePath: string } {
  return isRecord(value) && typeof value.filePath === 'string' && value.filePath.trim().length > 0;
}

function installHelperOnlyAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'ZTerm Screenshot Helper',
      submenu: [
        { label: '状态：运行中', enabled: false },
        { label: `Socket：${DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH}`, enabled: false },
        { type: 'separator' },
        {
          label: '退出 Helper',
          click: () => {
            app.quit();
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  if (process.platform === 'darwin') {
    app.dock?.setMenu(menu);
  }
}

function createScreenshotHelperWindow() {
  if (screenshotHelperWindow && !screenshotHelperWindow.isDestroyed()) {
    screenshotHelperWindow.show();
    screenshotHelperWindow.focus();
    return screenshotHelperWindow;
  }

  const helperWindow = new BrowserWindow({
    width: 420,
    height: 180,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: true,
    title: 'ZTerm Screenshot Helper',
    backgroundColor: '#10131b',
    webPreferences: {
      sandbox: false,
    },
  });

  helperWindow.on('closed', () => {
    screenshotHelperWindow = null;
  });

  const helperHtml = `
    <html>
      <body style="margin:0;background:#10131b;color:#dbeafe;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;">
        <div style="padding:20px;max-width:320px;text-align:center;line-height:1.5;">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px;">ZTerm Screenshot Helper</div>
          <div style="font-size:13px;color:#93c5fd;">
            首次截图时 macOS 可能会要求授予 Screen Recording 权限。授权完成后可保留此窗口最小化。
          </div>
        </div>
      </body>
    </html>
  `;
  void helperWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(helperHtml)}`);
  screenshotHelperWindow = helperWindow;
  return helperWindow;
}

function installMainAppMenu(manager: MacWindowManager) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createMacWindowMenuTemplate({
    newWindow: () => {
      manager.createWindow();
    },
  })));
}

app.whenReady().then(async () => {
  if (screenshotHelperOnlyMode) {
    app.setName('ZTerm Screenshot Helper');
  }
  screenshotHelperServer = await startScreenshotHelperServer();
  if (screenshotHelperOnlyMode) {
    persistScreenshotHelperRuntimeState(DEFAULT_REMOTE_SCREENSHOT_HELPER_SOCKET_PATH);
    installHelperOnlyAppMenu();
    createScreenshotHelperWindow();
    app.focus({ steal: true });
  } else {
    macWindowManager = createMacWindowManager({
      createBrowserWindow: (options) => new BrowserWindow(options),
      preloadPath: path.join(__dirname, 'preload.cjs'),
      rendererIndexPath: resolveDefaultRendererIndexPath(__dirname),
      getDevServerUrl,
      recordStore: createFileMacWindowRecordStore(path.join(app.getPath('userData'), 'mac-window-records.v1.json')),
      logger: console,
    });
    installMainAppMenu(macWindowManager);
  }
  ipcMain.handle('zterm:local-tmux:list-sessions', () => localTmuxManager.listSessions());
  ipcMain.handle('zterm:local-tmux:connect', (_event, payload: { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' }) =>
    localTmuxManager.connect(payload.clientId, payload.sessionName, payload.cols, payload.rows, payload.mode || 'active'));
  ipcMain.handle('zterm:local-tmux:disconnect', (_event, payload: { clientId: string }) =>
    localTmuxManager.disconnect(payload.clientId));
  ipcMain.handle('zterm:local-tmux:force-close-for-smoke', (_event, payload: { clientId: string }) => {
    if (!alphaSmokeMode) {
      throw new Error('Local tmux smoke force-close is unavailable outside alpha smoke mode');
    }
    return localTmuxManager.forceCloseForSmoke(payload.clientId);
  });
  ipcMain.handle('zterm:local-tmux:input', (_event, payload: { clientId: string; data: string }) =>
    localTmuxManager.sendInput(payload.clientId, payload.data));
  ipcMain.handle('zterm:local-tmux:set-activity-mode', (_event, payload: { clientId: string; mode: 'active' | 'idle' }) =>
    localTmuxManager.setActivityMode(payload.clientId, payload.mode));
  ipcMain.handle('zterm:local-tmux:resize', (_event, payload: { clientId: string; cols: number; rows: number }) =>
    localTmuxManager.resize(payload.clientId, payload.cols, payload.rows));
  ipcMain.handle('zterm:local-tmux:buffer-head-request', (_event, payload: { clientId: string }) =>
    localTmuxManager.requestBufferHead(payload.clientId));
  ipcMain.handle('zterm:local-tmux:buffer-sync-request', (_event, payload: { clientId: string; request: LocalBufferSyncRequestPayload }) =>
    localTmuxManager.requestBufferSync(payload.clientId, payload.request));
  ipcMain.handle('zterm:window:create', () => {
    if (screenshotHelperOnlyMode) {
      return { ok: false, error: 'Window creation is unavailable in screenshot-helper mode' };
    }
    const created = macWindowManager?.createWindow();
    return created
      ? { ok: true, windowId: created.windowId }
      : { ok: false, error: 'MacWindowManager is not initialized' };
  });


  desktopCommandHandler.register('desktop.listSessions', async () => ({
    sessions: await localTmuxManager.listSessions(),
  }));
  desktopCommandHandler.register('desktop.tmuxConnect', async (params) => {
    if (!isTmuxConnectParams(params)) {
      throw new DesktopGatewayError('INVALID_PARAMS', 'clientId, sessionName, cols, rows required');
    }
    await localTmuxManager.connect(params.clientId, params.sessionName, params.cols, params.rows);
    return { clientId: params.clientId };
  });
  desktopCommandHandler.register('desktop.tmuxDisconnect', async (params) => {
    if (!isClientParams(params)) throw new DesktopGatewayError('INVALID_PARAMS', 'clientId required');
    await localTmuxManager.disconnect(params.clientId);
    return { clientId: params.clientId };
  });
  desktopCommandHandler.register('desktop.tmuxResize', async (params) => {
    if (!isResizeParams(params)) {
      throw new DesktopGatewayError('INVALID_PARAMS', 'clientId, cols, rows required');
    }
    await localTmuxManager.resize(params.clientId, params.cols, params.rows);
    return { clientId: params.clientId };
  });
  desktopCommandHandler.register('desktop.listDir', async (params) => {
    if (!isDirParams(params)) throw new DesktopGatewayError('INVALID_PARAMS', 'dirPath required');
    const result = await localFileSystem.readdir(params.dirPath);
    if (!result.ok) throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', result.error ?? 'directory read failed');
    return { path: result.path, entries: result.entries };
  });
  desktopCommandHandler.register('desktop.createWindow', () => {
    if (screenshotHelperOnlyMode) {
      throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', 'Window creation is unavailable in screenshot-helper mode');
    }
    const created = macWindowManager?.createWindow();
    if (!created) throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', 'MacWindowManager is not initialized');
    return { windowId: created.windowId };
  });
  desktopCommandHandler.register('desktop.readFile', async (params) => {
    if (!isFileParams(params)) throw new DesktopGatewayError('INVALID_PARAMS', 'filePath required');
    const result = await localFileSystem.readFile(params.filePath);
    if (!result.ok) throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', result.error ?? 'file read failed');
    return { dataBase64: result.dataBase64, size: result.size };
  });
  ipcMain.handle(DESKTOP_GATEWAY_COMMAND_CHANNEL, (_event, wire) => desktopCommandHandler.execute(wire));
  registerMacFileSystemIpcHandlers(ipcMain, {
    service: localFileSystem,
    showOpenDialog: (options) => dialog.showOpenDialog(options),
  });

  if (!screenshotHelperOnlyMode) {
    macWindowManager?.restoreWindows();
  }

  app.on('activate', () => {
    if (screenshotHelperOnlyMode) {
      createScreenshotHelperWindow();
      return;
    }
    macWindowManager?.restoreOrCreateWindow();
  });
});

app.on('window-all-closed', () => {
  void localTmuxManager.dispose();
  if (process.platform !== 'darwin' && !screenshotHelperOnlyMode) {
    app.quit();
  }
});

app.on('before-quit', () => {
  macWindowManager?.prepareForQuit();
  void localTmuxManager.dispose();
  if (screenshotHelperOnlyMode) {
    cleanupScreenshotHelperRuntimeState();
  }
  if (screenshotHelperServer) {
    void screenshotHelperServer.close();
    screenshotHelperServer = null;
  }
});

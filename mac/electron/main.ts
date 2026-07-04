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

  registerMacFileSystemIpcHandlers(ipcMain, {
    service: createMacLocalFileSystemService({
      defaultDownloadDir: resolveDefaultMacDownloadDir(),
    }),
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

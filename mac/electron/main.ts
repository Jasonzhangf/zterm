import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalTmuxManager } from './local-tmux.js';
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#10131b',
    title: 'ZTerm',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['verbose','info','warning','error'];
    console.error('[RENDERER ' + (levels[level]||level) + '] ' + message + ' (at ' + sourceId + ':' + line + ')');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[RENDERER CRASHED]', JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => {
    console.error('[RENDERER UNRESPONSIVE]');
  });

  const devServerUrl = getDevServerUrl();
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  win.webContents.openDevTools({ mode: 'detach' });
  void win.loadFile(path.join(__dirname, '../../dist/index.html'));
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

  // ─── File Transfer (local filesystem) ───
  const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'zterm');

  ipcMain.handle('zterm:fs:readdir', async (_event, payload: { dirPath: string }) => {
    try {
      const resolvedPath = payload.dirPath || DEFAULT_DOWNLOAD_DIR;
      await fs.promises.mkdir(resolvedPath, { recursive: true });
      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const result: Array<{ name: string; type: string; size: number; modified: number }> = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(resolvedPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          result.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: Math.floor(stat.mtimeMs / 1000),
          });
        } catch {
          result.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: 0, modified: 0 });
        }
      }
      return { ok: true, entries: result };
    } catch (err) {
      return { ok: false, error: String(err), entries: [] as Array<{ name: string; type: string; size: number; modified: number }> };
    }
  });

  ipcMain.handle('zterm:fs:save-file', async (_event, payload: { dirPath: string; fileName: string; dataBase64: string }) => {
    try {
      const dirPath = payload.dirPath || DEFAULT_DOWNLOAD_DIR;
      await fs.promises.mkdir(dirPath, { recursive: true });
      const filePath = path.join(dirPath, payload.fileName);
      const buffer = Buffer.from(payload.dataBase64, 'base64');
      await fs.promises.writeFile(filePath, buffer);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('zterm:fs:read-file', async (_event, payload: { filePath: string }) => {
    try {
      const buffer = await fs.promises.readFile(payload.filePath);
      return { ok: true, dataBase64: buffer.toString('base64'), size: buffer.length };
    } catch (err) {
      return { ok: false, error: String(err), dataBase64: '', size: 0 };
    }
  });

  ipcMain.handle('zterm:fs:mkdir', async (_event, payload: { dirPath: string }) => {
    try {
      await fs.promises.mkdir(payload.dirPath, { recursive: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('zterm:fs:get-download-dir', () => DEFAULT_DOWNLOAD_DIR);

  if (!screenshotHelperOnlyMode) {
    createWindow();
  }

  app.on('activate', () => {
    if (screenshotHelperOnlyMode) {
      createScreenshotHelperWindow();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void localTmuxManager.dispose();
  if (process.platform !== 'darwin' && !screenshotHelperOnlyMode) {
    app.quit();
  }
});

app.on('before-quit', () => {
  void localTmuxManager.dispose();
  if (screenshotHelperOnlyMode) {
    cleanupScreenshotHelperRuntimeState();
  }
  if (screenshotHelperServer) {
    void screenshotHelperServer.close();
    screenshotHelperServer = null;
  }
});
import fs from 'node:fs';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

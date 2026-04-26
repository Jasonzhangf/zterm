import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalTmuxManager } from './local-tmux.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
type LocalBufferSyncRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; requestStartIndex: number; requestEndIndex: number; missingRanges?: Array<{ startIndex: number; endIndex: number }> };

const localTmuxManager = new LocalTmuxManager();

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

  const devServerUrl = getDevServerUrl();
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void win.loadFile(path.join(__dirname, '../../dist/index.html'));
}

app.whenReady().then(() => {
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void localTmuxManager.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void localTmuxManager.dispose();
});

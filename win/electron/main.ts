import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DESKTOP_GATEWAY_COMMAND_CHANNEL,
  DesktopCommandHandler,
  DesktopGatewayError,
} from '@zterm/desktop-gateway';
import {
  createWindowsLocalFileSystemService,
  registerWindowsFileSystemIpcHandlers,
} from './windows-file-system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let desktopGatewayGeneration = 0;
const desktopCommandHandler = new DesktopCommandHandler({
  getGeneration: () => desktopGatewayGeneration,
  setGeneration: (generation) => {
    desktopGatewayGeneration = generation;
  },
});

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    title: 'ZTerm',
    backgroundColor: '#111318',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  mainWindow = window;
  return window;
}


const localFileSystem = createWindowsLocalFileSystemService();
desktopCommandHandler.register('desktop.listDir', async (params) => {
  if (!isDirParams(params)) throw new DesktopGatewayError('INVALID_PARAMS', 'dirPath required');
  const result = await localFileSystem.readdir(params.dirPath);
  if (!result.ok) throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', result.error ?? 'directory read failed');
  return { path: result.path, entries: result.entries };
});
desktopCommandHandler.register('desktop.readFile', async (params) => {
  if (!isFileParams(params)) throw new DesktopGatewayError('INVALID_PARAMS', 'filePath required');
  const result = await localFileSystem.readFile(params.filePath);
  if (!result.ok) throw new DesktopGatewayError('PLATFORM_CAPABILITY_UNAVAILABLE', result.error ?? 'file read failed');
  return { dataBase64: result.dataBase64, size: result.size };
});
ipcMain.handle(DESKTOP_GATEWAY_COMMAND_CHANNEL, (_event, wire) => desktopCommandHandler.execute(wire));

app.whenReady().then(() => {
  registerWindowsFileSystemIpcHandlers(ipcMain, {
    showOpenDialog: (options) => dialog.showOpenDialog(options),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => app.quit());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDirParams(value: unknown): value is { dirPath: string } {
  return isRecord(value) && typeof value.dirPath === 'string' && value.dirPath.trim().length > 0;
}

function isFileParams(value: unknown): value is { filePath: string } {
  return isRecord(value) && typeof value.filePath === 'string' && value.filePath.trim().length > 0;
}

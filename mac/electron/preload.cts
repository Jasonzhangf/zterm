const { contextBridge, ipcRenderer } = require('electron');
const LOCAL_TMUX_EVENT = 'zterm:local-tmux-event';
type LocalTmuxPayload = { clientId: string; message: unknown };
type LocalTmuxConnectPayload = { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' };
type LocalTmuxRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; requestStartIndex: number; requestEndIndex: number; missingRanges?: Array<{ startIndex: number; endIndex: number }> };

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
  windowManager: {
    createWindow: () => ipcRenderer.invoke('zterm:window:create'),
  },
  fileSystem: {
    readdir: (dirPath: string) => ipcRenderer.invoke('zterm:fs:readdir', { dirPath }),
    saveFile: (dirPath: string, fileName: string, dataBase64: string) =>
      ipcRenderer.invoke('zterm:fs:save-file', { dirPath, fileName, dataBase64 }),
    readFile: (filePath: string) => ipcRenderer.invoke('zterm:fs:read-file', { filePath }),
    mkdir: (dirPath: string) => ipcRenderer.invoke('zterm:fs:mkdir', { dirPath }),
    getDownloadDir: () => ipcRenderer.invoke('zterm:fs:get-download-dir'),
    selectDirectory: () => ipcRenderer.invoke('zterm:fs:select-directory'),
  },
  localTmux: {
    listSessions: () => ipcRenderer.invoke('zterm:local-tmux:list-sessions'),
    connect: (payload: LocalTmuxConnectPayload) => ipcRenderer.invoke('zterm:local-tmux:connect', payload),
    disconnect: (clientId: string) => ipcRenderer.invoke('zterm:local-tmux:disconnect', { clientId }),
    sendInput: (clientId: string, data: string) => ipcRenderer.invoke('zterm:local-tmux:input', { clientId, data }),
    setActivityMode: (clientId: string, mode: 'active' | 'idle') => ipcRenderer.invoke('zterm:local-tmux:set-activity-mode', { clientId, mode }),
    resize: (clientId: string, cols: number, rows: number) => ipcRenderer.invoke('zterm:local-tmux:resize', { clientId, cols, rows }),
    requestBufferHead: (clientId: string) => ipcRenderer.invoke('zterm:local-tmux:buffer-head-request', { clientId }),
    requestBufferSync: (clientId: string, request: LocalTmuxRequestPayload) => ipcRenderer.invoke('zterm:local-tmux:buffer-sync-request', { clientId, request }),
    subscribe: (listener: (payload: LocalTmuxPayload) => void) => {
      const handler = (_event: unknown, payload: LocalTmuxPayload) => {
        listener(payload);
      };
      ipcRenderer.on(LOCAL_TMUX_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(LOCAL_TMUX_EVENT, handler);
      };
    },
  },
});

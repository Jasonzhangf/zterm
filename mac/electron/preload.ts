import { contextBridge, ipcRenderer } from 'electron';
import { LOCAL_TMUX_EVENT } from './local-tmux.js';

type LocalBufferSyncRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; requestStartIndex: number; requestEndIndex: number; missingRanges?: Array<{ startIndex: number; endIndex: number }> };
type LocalTerminalBufferPayload = { revision: number; startIndex: number; endIndex: number; availableStartIndex?: number; availableEndIndex?: number; cols: number; rows: number; cursorKeysApp: boolean; lines: Array<{ index: number; cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> }> };

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
  fileSystem: {
    readdir: (dirPath: string) =>
      ipcRenderer.invoke('zterm:fs:readdir', { dirPath }) as Promise<{ ok: boolean; entries: Array<{ name: string; type: string; size: number; modified: number }>; error?: string }>,
    saveFile: (dirPath: string, fileName: string, dataBase64: string) =>
      ipcRenderer.invoke('zterm:fs:save-file', { dirPath, fileName, dataBase64 }) as Promise<{ ok: boolean; path?: string; error?: string }>,
    readFile: (filePath: string) =>
      ipcRenderer.invoke('zterm:fs:read-file', { filePath }) as Promise<{ ok: boolean; dataBase64: string; size: number; error?: string }>,
    mkdir: (dirPath: string) =>
      ipcRenderer.invoke('zterm:fs:mkdir', { dirPath }) as Promise<{ ok: boolean; error?: string }>,
    getDownloadDir: () =>
      ipcRenderer.invoke('zterm:fs:get-download-dir') as Promise<string>,
  },
  localTmux: {
    listSessions: () => ipcRenderer.invoke('zterm:local-tmux:list-sessions') as Promise<string[]>,
    connect: (payload: { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' }) =>
      ipcRenderer.invoke('zterm:local-tmux:connect', payload) as Promise<void>,
    disconnect: (clientId: string) =>
      ipcRenderer.invoke('zterm:local-tmux:disconnect', { clientId }) as Promise<void>,
    sendInput: (clientId: string, data: string) =>
      ipcRenderer.invoke('zterm:local-tmux:input', { clientId, data }) as Promise<void>,
    setActivityMode: (clientId: string, mode: 'active' | 'idle') =>
      ipcRenderer.invoke('zterm:local-tmux:set-activity-mode', { clientId, mode }) as Promise<void>,
    resize: (clientId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('zterm:local-tmux:resize', { clientId, cols, rows }) as Promise<void>,
    requestBufferHead: (clientId: string) =>
      ipcRenderer.invoke('zterm:local-tmux:buffer-head-request', { clientId }) as Promise<{ sessionId: string; revision: number; latestEndIndex: number; availableStartIndex?: number; availableEndIndex?: number } | null>,
    requestBufferSync: (clientId: string, request: LocalBufferSyncRequestPayload) =>
      ipcRenderer.invoke('zterm:local-tmux:buffer-sync-request', { clientId, request }) as Promise<LocalTerminalBufferPayload | null>,
    subscribe: (
      listener: (payload: {
        clientId: string;
        message: unknown;
      }) => void,
    ) => {
      const handler = (_event: unknown, payload: { clientId: string; message: unknown }) => {
        listener(payload);
      };
      ipcRenderer.on(LOCAL_TMUX_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(LOCAL_TMUX_EVENT, handler);
      };
    },
  },
});

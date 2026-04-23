import { contextBridge, ipcRenderer } from 'electron';
import { LOCAL_TMUX_EVENT } from './local-tmux.js';

type LocalBufferSyncRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; viewportEndIndex: number; viewportRows: number; mode: 'follow' | 'reading'; prefetch?: boolean; missingRanges?: Array<{ startIndex: number; endIndex: number }> };
type LocalTerminalBufferPayload = { revision: number; startIndex: number; endIndex: number; viewportEndIndex: number; cols: number; rows: number; cursorKeysApp: boolean; lines: Array<{ index: number; cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> }> };

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
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

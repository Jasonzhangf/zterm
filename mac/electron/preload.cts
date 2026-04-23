const { contextBridge, ipcRenderer } = require('electron');
const LOCAL_TMUX_EVENT = 'zterm:local-tmux-event';
type LocalTmuxPayload = { clientId: string; message: unknown };
type LocalTmuxConnectPayload = { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' };
type LocalTmuxRequestPayload = { knownRevision: number; localStartIndex: number; localEndIndex: number; viewportEndIndex: number; viewportRows: number; mode: 'follow' | 'reading'; prefetch?: boolean; missingRanges?: Array<{ startIndex: number; endIndex: number }> };

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
  localTmux: {
    listSessions: () => ipcRenderer.invoke('zterm:local-tmux:list-sessions'),
    connect: (payload: LocalTmuxConnectPayload) => ipcRenderer.invoke('zterm:local-tmux:connect', payload),
    disconnect: (clientId: string) => ipcRenderer.invoke('zterm:local-tmux:disconnect', { clientId }),
    sendInput: (clientId: string, data: string) => ipcRenderer.invoke('zterm:local-tmux:input', { clientId, data }),
    setActivityMode: (clientId: string, mode: 'active' | 'idle') => ipcRenderer.invoke('zterm:local-tmux:set-activity-mode', { clientId, mode }),
    resize: (clientId: string, cols: number, rows: number) => ipcRenderer.invoke('zterm:local-tmux:resize', { clientId, cols, rows }),
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

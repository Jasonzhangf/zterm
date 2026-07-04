/// <reference types="vite/client" />

declare global {
  interface Window {
    ztermMac: {
      platform: 'mac';
      windowManager?: {
        createWindow: () => Promise<{ ok: boolean; windowId?: string; error?: string }>;
      };
      fileSystem?: {
        readdir: (dirPath: string) => Promise<{ ok: boolean; path: string; entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: number; modifiedMs?: number; path?: string }>; error?: string }>;
        saveFile: (dirPath: string, fileName: string, dataBase64: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        readFile: (filePath: string) => Promise<{ ok: boolean; dataBase64: string; size: number; error?: string }>;
        mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
        getDownloadDir: () => Promise<string>;
        selectDirectory: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      };
      localTmux: {
        listSessions: () => Promise<string[]>;
        connect: (payload: { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' }) => Promise<void>;
        disconnect: (clientId: string) => Promise<void>;
        sendInput: (clientId: string, data: string) => Promise<void>;
        setActivityMode: (clientId: string, mode: 'active' | 'idle') => Promise<void>;
        resize: (clientId: string, cols: number, rows: number) => Promise<void>;
        requestBufferHead: (clientId: string) => Promise<{ sessionId: string; revision: number; latestEndIndex: number; availableStartIndex?: number; availableEndIndex?: number } | null>;
        requestBufferSync: (clientId: string, request: { knownRevision: number; localStartIndex: number; localEndIndex: number; requestStartIndex: number; requestEndIndex: number; missingRanges?: Array<{ startIndex: number; endIndex: number }> }) => Promise<{ revision: number; startIndex: number; endIndex: number; availableStartIndex?: number; availableEndIndex?: number; cols: number; rows: number; cursorKeysApp: boolean; lines: Array<{ index: number; cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> }> } | null>;
        subscribe: (
          listener: (payload: {
            clientId: string;
            message: unknown;
          }) => void,
        ) => () => void;
      };
    };
  }
}

export {};

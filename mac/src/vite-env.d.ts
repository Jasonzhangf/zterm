/// <reference types="vite/client" />

declare global {
  interface Window {
    ztermMac: {
      platform: 'mac';
      localTmux: {
        listSessions: () => Promise<string[]>;
        connect: (payload: { clientId: string; sessionName: string; cols: number; rows: number; mode?: 'active' | 'idle' }) => Promise<void>;
        disconnect: (clientId: string) => Promise<void>;
        sendInput: (clientId: string, data: string) => Promise<void>;
        setActivityMode: (clientId: string, mode: 'active' | 'idle') => Promise<void>;
        resize: (clientId: string, cols: number, rows: number) => Promise<void>;
        requestBufferSync: (clientId: string, request: { knownRevision: number; localStartIndex: number; localEndIndex: number; viewportEndIndex: number; viewportRows: number; mode: 'follow' | 'reading'; prefetch?: boolean; missingRanges?: Array<{ startIndex: number; endIndex: number }> }) => Promise<{ revision: number; startIndex: number; endIndex: number; viewportEndIndex: number; cols: number; rows: number; cursorKeysApp: boolean; lines: Array<{ index: number; cells: Array<{ char: number; fg: number; bg: number; flags: number; width: number }> }> } | null>;
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

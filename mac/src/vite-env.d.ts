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

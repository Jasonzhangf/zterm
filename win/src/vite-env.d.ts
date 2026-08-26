/// <reference types="vite/client" />

import type { DesktopGatewayPreloadApi } from '@zterm/desktop-gateway';

declare global {
  interface Window {
  ztermWindows?: {
    platform: 'windows';
    versions: { electron: string; chrome: string; node: string };
    fileSystem: {
      readdir: (dirPath: string) => Promise<{ ok: boolean; path: string; entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: number; modifiedMs?: number; path?: string }>; error?: string }>;
      readFile: (filePath: string) => Promise<{ ok: boolean; dataBase64: string; size: number; error?: string }>;
      selectDirectory: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    };
    runtimeGateway: DesktopGatewayPreloadApi;
  };
  }
}

export {};

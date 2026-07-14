/// <reference types="vite/client" />

interface Window {
  ztermWindows?: {
    platform: 'windows';
    versions: { electron: string; chrome: string; node: string };
  };
}

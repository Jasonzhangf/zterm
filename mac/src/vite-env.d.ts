/// <reference types="vite/client" />

declare global {
  interface Window {
    ztermMac: {
      platform: 'mac';
    };
  }
}

export {};

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('ztermWindows', {
  platform: 'windows',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

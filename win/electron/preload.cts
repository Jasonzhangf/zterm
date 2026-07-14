import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ztermWindows', {
  platform: 'windows',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  fileSystem: {
    readdir: (dirPath: string) => ipcRenderer.invoke('zterm:windows:fs:readdir', { dirPath }),
    readFile: (filePath: string) => ipcRenderer.invoke('zterm:windows:fs:read-file', { filePath }),
    selectDirectory: () => ipcRenderer.invoke('zterm:windows:fs:select-directory'),
  },
});

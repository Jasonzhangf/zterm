import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
});

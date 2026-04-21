const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('ztermMac', {
  platform: 'mac',
});

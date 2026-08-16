import { Capacitor, registerPlugin } from '@capacitor/core';

interface ScreenOrientationPluginApi {
  setOrientation(options: { orientation: 'portrait' | 'landscape' }): Promise<{ orientation: 'portrait' | 'landscape' }>;
}

export const ScreenOrientationPlugin = registerPlugin<ScreenOrientationPluginApi>('ScreenOrientation');

export function isScreenOrientationSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

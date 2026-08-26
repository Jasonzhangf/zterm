import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zterm.ios',
  appName: 'zterm',
  webDir: '../android/dist',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;

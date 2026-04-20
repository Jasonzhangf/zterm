import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zterm.android',
  appName: 'zterm',
  webDir: 'dist',
  android: {
    path: 'native/android',
  },
  server: {
    androidScheme: 'http',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_wterm',
      iconColor: '#488AFF',
    },
  },
};

export default config;

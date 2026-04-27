import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wterm.mobile',
  appName: 'wterm-mobile',
  webDir: 'dist',
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

import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
  ...viteConfig,
  test: {
    setupFiles: ['./src/vitest.setup.ts'],
    // wrtc native media requires process isolation, not worker-thread isolation.
    // `rtc-bridge.test.ts` is the only suite that imports the real
    // @roamhq/wrtc native addon; running it in a worker thread aborts the
    // whole runner (node_webrtc::PeerConnectionFactory::GetOrCreateDefault).
    poolMatchGlobs: [['**/src/server/rtc-bridge.test.ts', 'forks']],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/protected/**',
      '**/generated/**',
      '**/playground/**',
    ],
  },
});

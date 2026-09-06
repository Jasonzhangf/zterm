import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
  ...viteConfig,
  test: {
    setupFiles: ['./src/vitest.setup.ts'],
    // wrtc native media requires process isolation, not worker-thread isolation.
    poolMatchGlobs: [['**/src/server/remote-window-stream-daemon-webrtc.test.ts', 'forks']],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/protected/**',
      '**/generated/**',
      '**/playground/**',
    ],
  },
});

import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
  ...viteConfig,
  test: {
    setupFiles: ['./src/vitest.setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/protected/**',
      '**/generated/**',
      '**/playground/**',
    ],
  },
});

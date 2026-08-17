import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
  ...viteConfig,
  test: {
    setupFiles: ['./src/vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/protected/**',
      '**/generated/**',
      '**/playground/**',
    ],
  },
});

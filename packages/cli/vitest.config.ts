import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    pool: 'forks',
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/account-state.test.ts',
      'src/slot-store.test.ts',
    ],
  },
});

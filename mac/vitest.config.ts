import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const sharedSrc = path.resolve(__dirname, '../packages/shared/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Force @zterm/shared to resolve from source so internal `export * from "./layout/profile"`
      // can be picked up by vite without needing explicit .ts extensions.
      { find: /^@zterm\/shared$/, replacement: path.join(sharedSrc, 'index.ts') },
    ],
  },
  test: {
    include: [path.join(__dirname, "src/**/*.test.{ts,tsx}")],
    environment: 'jsdom',
    setupFiles: [path.join(__dirname, "src/test/setup.ts")],
    globals: false,
    server: {
      deps: {
        inline: ['@zterm/shared', /^@zterm\/shared\//],
      },
    },
    deps: {
      optimizer: {
        web: {
          include: ['@zterm/shared'],
        },
      },
    },
  },
});

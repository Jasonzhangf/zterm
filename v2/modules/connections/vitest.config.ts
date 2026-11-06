import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const shared = (p: string) => fileURLToPath(new URL(`../../../packages/shared/src/connection/${p}`, import.meta.url));
const cliNodeModules = (p: string) => fileURLToPath(new URL(`../../../packages/cli/node_modules/${p}`, import.meta.url));

export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "@zterm/shared/connection/traversal": shared("traversal/index.ts"),
      "@zterm/shared/connection/protocol": shared("protocol.ts"),
      "@zterm/shared/connection/app-protocol": shared("app-protocol.ts"),
      ws: cliNodeModules("ws/index.js"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

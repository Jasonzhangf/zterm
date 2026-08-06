import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/shared",
  "mac",
  "win",
]);

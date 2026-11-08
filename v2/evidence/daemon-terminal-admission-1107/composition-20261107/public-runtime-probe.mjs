import { createConnectionManager } from "../../../modules/connections/src/index.ts";

if (typeof createConnectionManager !== "function") {
  throw new TypeError("createConnectionManager is not a function");
}

console.log(`createConnectionManager=${typeof createConnectionManager}`);

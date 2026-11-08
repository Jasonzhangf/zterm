import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { createV1MuxFixture } from "../../../modules/terminal/tests/v1-mux-fixture.mjs";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const DAEMON_HOST_ID = "daemon-composition-ready-frame";
const socket = `/tmp/zterm-ready-frame-${process.pid}.sock`;
const session = `composition-ready-frame-${process.pid}`;

execFileSync("tmux", [
  "-S", socket, "new-session", "-d", "-s", session, "-x", "90", "-y", "24",
]);

const fixture = createV1MuxFixture({
  tmuxSocket: socket,
  authToken: "ready-frame-token",
  daemonHostId: DAEMON_HOST_ID,
});

const result = { fixture: { session }, readyFrame: null };

try {
  const { port } = await fixture.listen();
  const url = `ws://127.0.0.1:${port}/ws?token=ready-frame-token`;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({
    type: "mux-hello",
    payload: { version: 1, clientInstanceId: "ci-ready-frame" },
  }));
  const frame = await new Promise((resolve) => {
    ws.onmessage = (event) => {
      try { resolve(JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data))); } catch { resolve(null); }
    };
    setTimeout(() => resolve(null), 3000);
  });
  result.readyFrame = frame;
} finally {
  try { fixture.close(); } catch {}
  try { execFileSync("tmux", ["-S", socket, "kill-session", "-t", session]); } catch {}
}

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.readyFrame && result.readyFrame.payload && result.readyFrame.payload.daemonHostId === DAEMON_HOST_ID ? 0 : 1;

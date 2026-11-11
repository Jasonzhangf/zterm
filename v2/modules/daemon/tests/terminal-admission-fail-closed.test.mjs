import assert from "node:assert/strict";
import { test } from "node:test";

import { createDaemon } from "../src/server.mjs";

async function listen(t, daemon) {
  await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  const address = daemon.server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("terminal routes fail closed with typed unavailable when admission is missing", async (t) => {
  const daemon = createDaemon({ v2Token: "configured-token", log: () => {} });
  const base = await listen(t, daemon);

  const stream = await fetch(
    `${base}/api/terminal/stream?target=legacy-target`,
    { headers: { authorization: "Bearer configured-token" } },
  );
  assert.equal(stream.status, 503);
  const streamBody = await stream.json();
  assert.equal(streamBody.error.code, "TERMINAL_ADMISSION_REQUIRED");

  const input = await fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: {
      authorization: "Bearer configured-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ target: "legacy-target", data: "x" }),
  });
  assert.equal(input.status, 503);
  const inputBody = await input.json();
  assert.equal(inputBody.error.code, "TERMINAL_ADMISSION_REQUIRED");
});

test("terminal routes fail closed before token configuration is considered", async (t) => {
  const daemon = createDaemon({ log: () => {} });
  const base = await listen(t, daemon);

  const stream = await fetch(`${base}/api/terminal/stream?target=legacy-target`);
  assert.equal(stream.status, 503);
  const body = await stream.json();
  assert.equal(body.error.code, "TERMINAL_ADMISSION_REQUIRED");
});

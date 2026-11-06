import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../src/observation.mjs";

test("observation keeps a source and a fresh timestamp", () => {
  const observedAt = "2026-11-02T00:00:00.000Z";
  assert.deepEqual(observation("tmux", { sessions: 1 }, observedAt), {
    source: "tmux",
    observedAt,
    value: { sessions: 1 },
  });
});

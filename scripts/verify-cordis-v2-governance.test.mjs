import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, MANIFEST_PATH } from './verify-cordis-v2-governance.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, MANIFEST_PATH), 'utf8'));

test('accepts the committed v2 phase manifest and source anchors', () => {
  const result = validateManifest(manifest, root);
  assert.deepEqual(result, { phaseCount: 9, nodeCount: 9, edgeCount: 8, activeGateCount: 3 });
});

test('rejects a review edge that bypasses a declared node', () => {
  const invalid = structuredClone(manifest);
  invalid.review.edges[0].to = 'unregistered-node';
  assert.throws(() => validateManifest(invalid, root), /unknown node/);
});

test('rejects a pending gate that declares an executable command', () => {
  const invalid = structuredClone(manifest);
  invalid.review.gates[3].command = 'node missing.mjs';
  assert.throws(() => validateManifest(invalid, root), /must not declare command/);
});

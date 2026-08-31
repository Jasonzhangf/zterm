import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const verifier = join(dirname(fileURLToPath(import.meta.url)), 'verify-update-manifest-version.mjs');

function verify(body, expectedVersionCode = '1100027890') {
  return spawnSync(process.execPath, [verifier, expectedVersionCode], {
    input: body,
    encoding: 'utf8',
  });
}

test('accepts pretty and minified manifests with the expected numeric versionCode', () => {
  const pretty = verify('{\n  "versionCode": 1100027890\n}\n');
  const minified = verify('{"versionCode":1100027890}');

  assert.equal(pretty.status, 0, pretty.stderr);
  assert.equal(minified.status, 0, minified.stderr);
});

test('rejects a different manifest versionCode', () => {
  const result = verify('{"versionCode":1100027880}');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected versionCode 1100027890.*received 1100027880/i);
});

test('rejects malformed manifest JSON', () => {
  const result = verify('{"versionCode":');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid update manifest json/i);
});

test('rejects an invalid expected versionCode argument', () => {
  const result = verify('{"versionCode":1100027890}', 'latest');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/i);
});

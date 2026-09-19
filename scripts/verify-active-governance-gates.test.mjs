import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const androidPackageJson = JSON.parse(readFileSync(resolve(root, 'android/package.json'), 'utf8'));
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

const legacyScriptNames = [
  'test:cordis-v2-governance',
  'test:cordis-v2-governance:negative',
  'test:v2:map-registries',
  'test:v2-parity-catalog',
  'test:v2-parity-catalog:negative',
];

test('legacy Cordis/v2 governance and parity gates stay archive-only', () => {
  for (const name of legacyScriptNames) {
    assert.equal(packageJson.scripts?.[name], undefined, `legacy script remains active: ${name}`);
  }

  for (const name of legacyScriptNames) {
    assert.doesNotMatch(androidPackageJson.scripts?.prebuild ?? '', new RegExp(`(?:run|exec)\\s+${name}`), `android prebuild invokes ${name}`);
    assert.doesNotMatch(ci, new RegExp(`pnpm run ${name}`), `CI invokes ${name}`);
  }

  assert.equal(packageJson.scripts?.['archive:test:cordis-v2-governance'], 'node ./scripts/verify-cordis-v2-governance.mjs');
  assert.equal(packageJson.scripts?.['archive:test:v2-parity-catalog'], 'node ./scripts/validate-zterm-v2-parity-catalog.mjs');
});

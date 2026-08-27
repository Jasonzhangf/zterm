#!/usr/bin/env node
/**
 * Negative test for four-platform-parity gate.
 * Proves the gate rejects drift:
 *   1. A platform host declared edge to runtime.contracts is removed.
 *   2. A sub-gate is removed from verification-map.
 *   3. A phase7 delivered_claim is removed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = process.cwd();

function makeWorkdir(name) {
  const dir = mkdtempSync(join(tmpdir(), `phase7-${name}-`));
  return dir;
}

function runGate(cwd) {
  const r = spawnSync('node', ['scripts/check-phase7-four-platform-parity.mjs'], {
    encoding: 'utf-8',
    cwd,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ── baseline: gate passes on real repo ────────────────────────────────

{
  const r = runGate(repoRoot);
  assert.equal(r.status, 0, `baseline gate must pass on real repo: stderr=${r.stderr}`);
  console.log('baseline: PASS');
}

// ── negative 1: remove host.mac_electron edge to runtime.desktop_gateway
//    (breaks transitive reachability to runtime.contracts) ───────────

{
  const wd = makeWorkdir('edge');
  for (const sub of [
    'docs/architecture/registries',
    'scripts',
    'packages/runtime-contracts/src',
    'mac/electron',
  ]) mkdirSync(join(wd, sub), { recursive: true });

  // Copy minimal files needed for the gate to parse
  copyFileSync(join(repoRoot, 'docs/architecture/registries/module-registry.json'), join(wd, 'docs/architecture/registries/module-registry.json'));
  copyFileSync(join(repoRoot, 'docs/architecture/registries/verification-map.json'), join(wd, 'docs/architecture/registries/verification-map.json'));
  copyFileSync(join(repoRoot, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'), join(wd, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'));
  copyFileSync(join(repoRoot, 'scripts/check-phase7-four-platform-parity.mjs'), join(wd, 'scripts/check-phase7-four-platform-parity.mjs'));
  mkdirSync(join(wd, 'packages/shared/src'), { recursive: true });

  // Mutate module-registry: remove edge host.mac_electron -> runtime.desktop_gateway
  const reg = JSON.parse(readFileSync(join(wd, 'docs/architecture/registries/module-registry.json'), 'utf-8'));
  for (const m of reg.modules) {
    if (m.module_id === 'host.mac_electron') {
      m.declared_edges = m.declared_edges.filter((e) => e.to !== 'runtime.desktop_gateway');
    }
  }
  writeFileSync(join(wd, 'docs/architecture/registries/module-registry.json'), JSON.stringify(reg, null, 2));

  const r = runGate(wd);
  assert.notEqual(r.status, 0, `mutated gate must FAIL when transitive reachability broken`);
  assert.match(r.stderr, /host.mac_electron/, `stderr must name host.mac_electron: ${r.stderr}`);
  console.log('negative 1: FAIL as expected');
  rmSync(wd, { recursive: true });
}

// ── negative 2: remove gate.desktop.packaged from verification-map ──

{
  const wd = makeWorkdir('subgate');
  for (const sub of [
    'docs/architecture/registries',
    'scripts',
    'packages/runtime-contracts/src',
    'mac/electron',
    'win/electron',
    'packages/desktop-gateway/src',
    'packages/ios-host/src',
    'packages/shared/src',
  ]) mkdirSync(join(wd, sub), { recursive: true });

  copyFileSync(join(repoRoot, 'docs/architecture/registries/module-registry.json'), join(wd, 'docs/architecture/registries/module-registry.json'));
  copyFileSync(join(repoRoot, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'), join(wd, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'));
  copyFileSync(join(repoRoot, 'scripts/check-phase7-four-platform-parity.mjs'), join(wd, 'scripts/check-phase7-four-platform-parity.mjs'));

  // vmap with desktop.packaged removed
  const vmap = JSON.parse(readFileSync(join(repoRoot, 'docs/architecture/registries/verification-map.json'), 'utf-8'));
  vmap.gates = vmap.gates.filter((g) => g.gate_id !== 'gate.desktop.packaged');
  writeFileSync(join(wd, 'docs/architecture/registries/verification-map.json'), JSON.stringify(vmap, null, 2));

  const r = runGate(wd);
  assert.notEqual(r.status, 0, `mutated gate must FAIL when sub-gate missing`);
  assert.match(r.stderr, /gate\.desktop\.packaged/, `stderr must name the missing sub-gate: ${r.stderr}`);
  console.log('negative 2: FAIL as expected');
  rmSync(wd, { recursive: true });
}

// ── negative 3: remove phase7 delivered_claim windows.live ────────────

{
  const wd = makeWorkdir('delivered');
  for (const sub of [
    'docs/architecture/registries',
    'scripts',
    'packages/runtime-contracts/src',
    'mac/electron',
    'win/electron',
    'packages/desktop-gateway/src',
    'packages/ios-host/src',
    'packages/shared/src',
  ]) mkdirSync(join(wd, sub), { recursive: true });

  copyFileSync(join(repoRoot, 'docs/architecture/registries/module-registry.json'), join(wd, 'docs/architecture/registries/module-registry.json'));
  copyFileSync(join(repoRoot, 'docs/architecture/registries/verification-map.json'), join(wd, 'docs/architecture/registries/verification-map.json'));
  copyFileSync(join(repoRoot, 'scripts/check-phase7-four-platform-parity.mjs'), join(wd, 'scripts/check-phase7-four-platform-parity.mjs'));

  const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'), 'utf-8'));
  const phase7 = manifest.phases.find((p) => p.id === 'phase-7-platform-parity');
  phase7.delivered_claims = phase7.delivered_claims.filter((c) => c !== 'zterm.v2.phase7.windows.live');
  writeFileSync(join(wd, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'), JSON.stringify(manifest, null, 2));

  const r = runGate(wd);
  assert.notEqual(r.status, 0, `mutated gate must FAIL when delivered_claim missing`);
  assert.match(r.stderr, /windows\.live/, `stderr must name the missing claim: ${r.stderr}`);
  console.log('negative 3: FAIL as expected');
  rmSync(wd, { recursive: true });
}

console.log('\nfour-platform-parity negative suite PASS');

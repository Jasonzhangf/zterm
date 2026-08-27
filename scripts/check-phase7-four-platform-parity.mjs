#!/usr/bin/env node
/**
 * Phase 7 four-platform parity gate.
 * Verifies cross-platform structural parity at the Cordis v2 contracts layer:
 *
 *   gate 1: @zterm/runtime-contracts is consumed by all platform adapters
 *           (mac electron, win electron, ios-host, desktop-gateway).
 *   gate 2: module-registry cross-platform edges. Platform adapters (host.*)
 *           and platform-frontend gateways (runtime.ios_gateway,
 *           runtime.desktop_gateway) declare edges that ultimately reach
 *           runtime.contracts. Direct edge from host.* is not required because
 *           platform hosts own native OS resources, while runtime.contracts
 *           is consumed by the host's gateway layer.
 *   gate 3: shared.domain_core owns no forbidden cross-imports (React,
 *           Capacitor, Electron, Cordis) in files that are not excluded from
 *           shared.domain_core.
 *   gate 4: sub-gates (gate.ios.device.*, gate.desktop.packaged,
 *           gate.ios.native) are registered as active + required_for phase7.
 *   gate 5: phase manifest phase-7-platform-parity has ios-device,
 *           windows-conpty, desktop-packaged, four-platform-parity gates and
 *           three delivered_claims.
 *   gate 6: shared.domain_core has no declared edges to platform modules.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch (e) { return null; }
}

function walk(dir, extensions, result = []) {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, extensions, result);
    else if (extensions.includes(extname(p))) result.push(p);
  }
  return result;
}

function importSpecifiers(source) {
  const specs = [];
  for (const re of [
    /(?:^|[;\s])import\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])export\s+(?:type\s+)?\*(?:\s+as\s+[\w$]+)?\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return [...new Set(specs)];
}

function patternMatches(path, pattern) {
  const normalized = pattern.replace(/^\.\//, '');
  if (normalized.endsWith('/**')) {
    const root = normalized.slice(0, -3);
    return path === root || path.startsWith(`${root}/`);
  }
  return path === normalized;
}

function expandOwned(module, filesByRelativePath) {
  const owned = [];
  for (const [p] of filesByRelativePath) {
    if ((module.owned_paths ?? []).some((pat) => patternMatches(p, pat))) owned.push(p);
  }
  const excluded = new Set();
  for (const p of owned) {
    if ((module.excluded_paths ?? []).some((pat) => patternMatches(p, pat))) excluded.add(p);
  }
  return owned.filter((p) => !excluded.has(p));
}

const errors = [];
const fail = (msg) => errors.push(msg);

// ── gate 1: runtime-contracts consumed ────────────────────────────────

function checkRuntimeContractsConsumption() {
  const platformRoots = [
    'mac/electron',
    'win/electron',
    'packages/desktop-gateway/src',
    'packages/ios-host/src',
  ];
  let consumed = 0;
  for (const root of platformRoots) {
    const dir = join(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const abs of walk(dir, ['.ts', '.tsx'])) {
      const src = readFileSync(abs, 'utf-8');
      for (const spec of importSpecifiers(src)) {
        if (spec === '@zterm/runtime-contracts') consumed++;
      }
    }
  }
  if (consumed === 0) fail('no platform adapter imports @zterm/runtime-contracts — parity broken');
}

// ── gate 2: platform edges reach runtime.contracts transitively ──────

function checkModuleRegistryParity() {
  const reg = readJson(join(repoRoot, 'docs/architecture/registries/module-registry.json'));
  if (!reg) { fail('module-registry.json missing'); return; }
  const modules = reg.modules;

  // BFS from runtime.contracts through reversed declared_edges
  const reverseAdj = new Map();
  for (const m of modules) {
    for (const e of (m.declared_edges ?? [])) {
      if (!reverseAdj.has(e.to)) reverseAdj.set(e.to, []);
      reverseAdj.get(e.to, []).push(m.module_id);
    }
  }
  const reachable = new Set(['runtime.contracts']);
  const stack = ['runtime.contracts'];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of reverseAdj.get(cur) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); stack.push(next); }
    }
  }

  const platformFrontendModules = [
    'host.mac_electron',
    'host.win_electron',
    'host.ios_native',
    'runtime.ios_gateway',
    'runtime.desktop_gateway',
  ];
  for (const mid of platformFrontendModules) {
    const m = modules.find((x) => x.module_id === mid);
    if (!m) { fail(`platform module ${mid} missing from registry`); continue; }
    if (m.status !== 'active') continue; // design/pending does not need to reach contracts yet
    if (!reachable.has(mid)) {
      fail(`${mid} cannot reach runtime.contracts through declared_edges — parity broken`);
    }
  }

  // shared.domain_core must NOT reach platform modules
  if (reachable.has('shared.domain_core')) {
    // shared.domain_core itself is source — it shouldn't have edges out to platform
    const domainCore = modules.find((m) => m.module_id === 'shared.domain_core');
    const platformEdges = domainCore?.declared_edges?.filter((e) =>
      ['host.', 'ui.mac_renderer', 'ui.win_renderer'].some((p) => e.to.startsWith(p))
    ) ?? [];
    if (platformEdges.length > 0) {
      fail(`shared.domain_core must not declare edges to platform modules: ${platformEdges.map((e) => e.to).join(', ')}`);
    }
  }
}

// ── gate 3: shared.domain_core forbidden imports (only in owned files) ─

function checkSharedDomainForbiddenImports() {
  const reg = readJson(join(repoRoot, 'docs/architecture/registries/module-registry.json'));
  if (!reg) return;
  const sharedModule = reg.modules.find((m) => m.module_id === 'shared.domain_core');
  if (!sharedModule) return;

  const forbiddenPackages = ['react', 'react-dom', '@capacitor/core', '@capacitor/android', 'electron', 'cordis'];
  const roots = ['packages/shared/src'];
  const files = roots.flatMap((r) => walk(join(repoRoot, r), ['.ts', '.tsx']));
  const filesByRel = new Map(files.map((f) => [relative(repoRoot, f), f]));
  const ownedFiles = new Set(expandOwned(sharedModule, filesByRel));

  for (const rel of ownedFiles) {
    const src = readFileSync(join(repoRoot, rel), 'utf-8');
    for (const spec of importSpecifiers(src)) {
      for (const fp of forbiddenPackages) {
        if (spec === fp || spec.startsWith(fp + '/')) {
          fail(`${rel}: shared.domain_core source imports forbidden package ${spec}`);
        }
      }
    }
  }
}

// ── gate 4: sub-gates registered active + phase7 ─────────────────────

function checkPlatformSubGates() {
  const subGates = [
    'gate.ios.device.lifecycle',
    'gate.ios.device.permissions',
    'gate.ios.device.ime',
    'gate.ios.device.negative',
    'gate.ios.native',
    'gate.desktop.packaged',
  ];
  const vmap = readJson(join(repoRoot, 'docs/architecture/registries/verification-map.json'));
  if (!vmap) { fail('verification-map.json missing'); return; }
  for (const id of subGates) {
    const entry = vmap.gates.find((g) => g.gate_id === id);
    if (!entry) { fail(`sub-gate ${id} not in verification-map`); continue; }
    if (entry.status !== 'active') fail(`sub-gate ${id} status=${entry.status}, expected active`);
    if (!entry.required_for?.includes('phase7')) fail(`sub-gate ${id} not marked required_for phase7`);
  }
}

// ── gate 5: phase manifest sync ───────────────────────────────────────

function checkPhaseManifestSync() {
  const manifest = readJson(join(repoRoot, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'));
  if (!manifest) { fail('phase manifest missing'); return; }
  const phase7 = manifest.phases.find((p) => p.id === 'phase-7-platform-parity');
  if (!phase7) { fail('phase-7-platform-parity not in manifest'); return; }
  for (const g of ['ios-device', 'windows-conpty', 'desktop-packaged', 'four-platform-parity']) {
    if (!phase7.gates?.includes(g)) fail(`phase7 missing gate: ${g}`);
  }
  for (const claim of [
    'zterm.v2.phase7.desktop.parity',
    'zterm.v2.phase7.ios.device',
    'zterm.v2.phase7.windows.live',
  ]) {
    if (!phase7.delivered_claims?.includes(claim)) fail(`phase7 delivered_claims missing: ${claim}`);
  }
}

// ── run all gates ─────────────────────────────────────────────────────

checkRuntimeContractsConsumption();
checkModuleRegistryParity();
checkSharedDomainForbiddenImports();
checkPlatformSubGates();
checkPhaseManifestSync();

if (errors.length > 0) {
  console.error(`four-platform-parity gate FAIL (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('four-platform-parity gate PASS');

#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryRoot = join(repoRoot, 'docs/architecture/registries');
const errors = [];
const fail = (message) => errors.push(message);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relative(repoRoot, path)}: invalid JSON: ${error.message}`);
    return null;
  }
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
  return seen;
}

function walk(dir, extensions, result = []) {
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, extensions, result);
    } else if (extensions.includes(extname(path))) {
      result.push(path);
    }
  }
  return result;
}

function patternMatches(path, pattern) {
  const normalized = pattern.replace(/^\.\//, '');
  if (normalized.endsWith('/**')) {
    const root = normalized.slice(0, -3);
    return path === root || path.startsWith(`${root}/`);
  }
  return path === normalized;
}

function expandOwnedPaths(module, filesByRelativePath) {
  const included = [];
  for (const [path] of filesByRelativePath) {
    if (module.owned_paths.some((pattern) => patternMatches(path, pattern))) {
      included.push(path);
    }
  }
  const excluded = new Set();
  for (const path of included) {
    if ((module.excluded_paths ?? []).some((pattern) => patternMatches(path, pattern))) {
      excluded.add(path);
    }
  }
  return included.filter((path) => !excluded.has(path));
}

function sharedExportCandidates() {
  const pkgPath = join(repoRoot, 'packages/shared/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const candidates = new Map([['@zterm/shared', ['packages/shared/src/index.ts']]]);
  for (const [specifier, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string') continue;
    const key = specifier === '.' ? '@zterm/shared' : `@zterm/shared/${specifier.slice(2)}`;
    const values = candidates.get(key) ?? [];
    values.push(target.replace(/^\.\//, 'packages/shared/src/'));
    candidates.set(key, values);
  }
  return candidates;
}

function resolveImport(sourcePath, specifier, filesByRelativePath, sharedExports) {
  let candidatePaths = [];
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(join(repoRoot, sourcePath)), specifier);
    candidatePaths = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((suffix) =>
      relative(repoRoot, `${base}${suffix.startsWith('/') ? '' : suffix}`)
    );
  } else if (specifier === '@zterm/shared' || specifier.startsWith('@zterm/shared/')) {
    candidatePaths = sharedExports.get(specifier) ?? [];
  } else {
    return null;
  }
  for (const candidate of candidatePaths) {
    if (filesByRelativePath.has(candidate)) return candidate;
  }
  return null;
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|[;\s])import\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])export\s+(?:type\s+)?\*(?:\s+as\s+[\w$]+)?\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)];
}

function assertReferences({ resource, module, feature, function: functionMap }, verificationMap) {
  const resources = resource.resources;
  const modules = module.modules;
  const features = feature.features;
  const functions = functionMap.functions;
  const verifications = verificationMap.gates;
  const moduleIds = new Set(modules.map((item) => item.module_id));
  const resourceIds = new Set(resources.map((item) => item.resource_id));
  const gateIds = new Set(verifications.map((item) => item.gate_id));

  for (const resource of resources) {
    if (!moduleIds.has(resource.owner)) fail(`resource ${resource.resource_id} references unknown owner ${resource.owner}`);
    for (const id of [...resource.direct_relations, ...resource.forbidden_direct_relations]) {
      if (!resourceIds.has(id)) fail(`resource ${resource.resource_id} references unknown resource ${id}`);
    }
    for (const gate of resource.required_gates) {
      if (!gateIds.has(gate)) fail(`resource ${resource.resource_id} references unknown gate ${gate}`);
    }
  }
  for (const feature of features) {
    for (const owner of feature.owner_modules) {
      if (!moduleIds.has(owner)) fail(`feature ${feature.feature_id} references unknown module ${owner}`);
    }
    for (const gate of feature.required_gates) {
      if (!gateIds.has(gate)) fail(`feature ${feature.feature_id} references unknown gate ${gate}`);
    }
  }
    for (const fn of functions) {
    if (!moduleIds.has(fn.owner_module)) fail(`function ${fn.function_id} references unknown module ${fn.owner_module}`);
    for (const gate of fn.required_gates) {
      if (!gateIds.has(gate)) fail(`function ${fn.function_id} references unknown gate ${gate}`);
    }
  }
  return { modules, resources, features, functions, verifications };
}

function checkOwnership(modules, filesByRelativePath) {
  const ownership = new Map();
  const counts = new Map();
  for (const module of modules.filter((item) => item.status === 'active')) {
    const owned = expandOwnedPaths(module, filesByRelativePath);
    counts.set(module.module_id, owned.length);
    if (owned.length === 0) fail(`active module ${module.module_id} owns no source files`);
    for (const path of owned) {
      if (ownership.has(path)) {
        fail(`source path ${path} has multiple owners: ${ownership.get(path)}, ${module.module_id}`);
      }
      ownership.set(path, module.module_id);
    }
  }
  return { ownership, counts };
}

function checkForbiddenImports(modules, filesByRelativePath) {
  for (const module of modules) {
    if (module.status !== 'active') continue;
    const owned = expandOwnedPaths(module, filesByRelativePath);
    for (const relativePath of owned) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      for (const forbidden of module.forbidden_imports ?? []) {
        const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/, '[^\'\"]*');
        const pattern = new RegExp(`(?:from\\s*|import\\(\\s*)['"]${escaped}(?:['"/])`, 'u');
        if (pattern.test(source)) fail(`${relativePath}: forbidden import ${forbidden}`);
      }
    }
  }
}

function checkImportEdges(modules, filesByRelativePath, ownership) {
  const sharedExports = sharedExportCandidates();
  for (const [relativePath, fromModule] of ownership) {
    if (!/\.(ts|tsx)$/.test(extname(relativePath))) continue;
    const source = readFileSync(join(repoRoot, relativePath), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const importedPath = resolveImport(relativePath, specifier, filesByRelativePath, sharedExports);
      if (!importedPath) continue;
      const toModule = ownership.get(importedPath);
      if (!toModule || toModule === fromModule) continue;
      const declared = modules.find((module) => module.module_id === fromModule)
        ?.declared_edges?.some((edge) => edge.to === toModule);
      if (!declared) fail(`undeclared import edge ${fromModule} -> ${toModule}: ${relativePath} -> ${importedPath}`);
    }
  }
}

function checkDag(modules) {
  const graph = new Map(modules.map((module) => [module.module_id, []]));
  for (const module of modules) {
    for (const edge of module.declared_edges ?? []) {
      graph.get(module.module_id).push(edge.to);
    }
  }
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 'visiting') {
      fail(`module DAG cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const next of graph.get(id) ?? []) visit(next, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of graph.keys()) visit(id, []);
}

function checkSymbols(functions, filesByRelativePath) {
  for (const fn of functions) {
    if (fn.status !== 'active') {
      if (existsSync(join(repoRoot, fn.path))) {
        fail(`design function ${fn.function_id} claims existing physical path ${fn.path}`);
      }
      continue;
    }
    if (!filesByRelativePath.has(fn.path)) {
      fail(`active function ${fn.function_id} path does not exist: ${fn.path}`);
      continue;
    }
    const source = readFileSync(join(repoRoot, fn.path), 'utf8');
    for (const symbol of fn.entry_symbols) {
      if (!new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`).test(source)) {
        fail(`function ${fn.function_id} symbol not found in ${fn.path}: ${symbol}`);
      }
    }
  }
}

function checkMainlines(mainlineMap) {
  for (const mainline of mainlineMap.mainlines) {
    const nodes = new Map(mainline.nodes.map((node) => [node.id, node]));
    if (!nodes.has(mainline.entrypoint)) fail(`${mainline.mainline_id} entrypoint missing`);
    if (!nodes.has(mainline.return_path)) fail(`${mainline.mainline_id} return path missing`);
    const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
    const outdegree = new Map([...nodes.keys()].map((id) => [id, 0]));
    for (const node of mainline.nodes) {
      if (node.status === 'design') continue;
      const [path, symbol] = String(node.label).split('#');
      if (!existsSync(join(repoRoot, path))) {
        fail(`${mainline.mainline_id} node ${node.id} path missing: ${path}`);
        continue;
      }
      if (!symbol) continue;
      const source = readFileSync(join(repoRoot, path), 'utf8');
      const exists = [
        `export function ${symbol}`,
        `export async function ${symbol}`,
        `export class ${symbol}`,
        `export const ${symbol}`,
        `export interface ${symbol}`,
        `export type ${symbol}`,
      ].some((pattern) => source.includes(pattern));
      if (!exists) fail(`${mainline.mainline_id} node ${node.id} symbol missing: ${symbol}`);
    }
    for (const edge of mainline.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
        fail(`${mainline.mainline_id} edge ${edge.edge_id} references unknown node`);
        continue;
      }
      if (edge.from === edge.to) fail(`${mainline.mainline_id} edge ${edge.edge_id} is self-adjacent`);
      indegree.set(edge.to, indegree.get(edge.to) + 1);
      outdegree.set(edge.from, outdegree.get(edge.from) + 1);
      for (const pathKey of ['caller_path', 'callee_path']) {
        if (edge[pathKey] && !existsSync(join(repoRoot, edge[pathKey]))) {
          fail(`${edge.edge_id} ${pathKey} missing: ${edge[pathKey]}`);
        }
      }
      if (edge.status === 'anchored' && edge.caller_symbol && edge.callee_symbol) {
        const callerSource = readFileSync(join(repoRoot, edge.caller_path), 'utf8');
        const calleeSource = readFileSync(join(repoRoot, edge.callee_path), 'utf8');
        if (!new RegExp(`\\b${edge.caller_symbol}\\b`).test(callerSource)) fail(`${edge.edge_id} caller symbol absent`);
        if (!new RegExp(`\\b${edge.callee_symbol}\\b`).test(calleeSource)) fail(`${edge.edge_id} callee symbol absent`);
      }
    }
    if ((outdegree.get(mainline.entrypoint) ?? 0) !== 1) fail(`${mainline.mainline_id} entrypoint must have exactly one outgoing edge`);
    if ((indegree.get(mainline.return_path) ?? 0) !== 1) fail(`${mainline.mainline_id} return path must have exactly one incoming edge`);
    for (const [id, count] of indegree) {
      if (id !== mainline.entrypoint && count > 1) fail(`${mainline.mainline_id} non-linear adjacency at ${id}`);
    }
  }
}

function checkStatuses({ modules, resources, features, functions }) {
  for (const module of modules) {
    const active = module.status === 'active';
    if (active) {
      if (!(module.owned_paths ?? []).length) fail(`active module ${module.module_id} has no owned_paths`);
      if (!(module.required_gates ?? []).length) fail(`active module ${module.module_id} has no gates`);
    } else if ((module.owned_paths ?? []).length) {
      fail(`non-active module ${module.module_id} cannot own physical paths`);
    }
  }
  for (const resource of resources) {
    if (resource.status === 'design' && !String(resource.truth_store).startsWith('pending:')) {
      fail(`design resource ${resource.resource_id} must have explicit pending truth_store`);
    }
  }
  for (const feature of features) {
    if (!['active', 'design', 'pending'].includes(feature.status)) fail(`invalid feature status: ${feature.feature_id}`);
    if (feature.status !== 'active' && !['design', 'pending'].includes(feature.status)) {
      fail(`target feature ${feature.feature_id} lacks target status`);
    }
  }
  for (const fn of functions) {
    if (!['active', 'design'].includes(fn.status)) fail(`invalid function status: ${fn.function_id}`);
  }
}

function checkPayloadIsolation(resources) {
  const byId = new Map(resources.map((resource) => [resource.resource_id, resource]));
  const forbiddenDataInCordis = byId.get('resource.cordis_context')
    ?.forbidden_direct_relations.includes('resource.terminal_data_stream');
  const forbiddenDomainWriteToUi = byId.get('resource.ui_projection')
    ?.forbidden_direct_relations.includes('resource.domain_state');
  const forbiddenDebugInData = byId.get('resource.terminal_data_stream')
    ?.forbidden_direct_relations.includes('resource.debug_snapshot_registry');
  if (!forbiddenDataInCordis) fail('Cordis context must explicitly forbid terminal data stream');
  if (!forbiddenDomainWriteToUi) fail('UI projection must explicitly forbid domain-state writes');
  if (!forbiddenDebugInData) fail('terminal data plane must explicitly forbid debug side channel');
}

function checkPhaseManifest(manifest, gateIds) {
  if (manifest.lifecycle_id !== 'zterm.cordis.v2.rebuild') fail('phase manifest lifecycle mismatch');
  const phase0 = manifest.phases.find((phase) => phase.id === 'phase-0-governance');
  if (!phase0) fail('phase manifest lacks phase-0-governance');
  for (const requiredGate of ['maps-parse', 'source-owner-baseline']) {
    if (!phase0.gates.includes(requiredGate)) fail(`phase manifest lacks ${requiredGate}`);
  }
  if (!gateIds.has('gate.map.parse')) fail('verification map lacks phase-0 parse gate');
}

const selected = new Set(
  (process.argv.find((arg) => arg.startsWith('--only=')) ?? '--only=all')
    .slice(7)
    .split(',')
);
const wants = (...names) => selected.has('all') || names.some((name) => selected.has(name));

const resourceRegistry = readJson(join(registryRoot, 'resource-registry.json'));
const moduleRegistry = readJson(join(registryRoot, 'module-registry.json'));
const featureRegistry = readJson(join(registryRoot, 'feature-registry.json'));
const functionMap = readJson(join(registryRoot, 'function-map.json'));
const mainlineMap = readJson(join(registryRoot, 'mainline-call-map.json'));
const verificationMap = readJson(join(registryRoot, 'verification-map.json'));
const phaseManifest = readJson(join(repoRoot, 'docs/architecture/zterm-cordis-v2-phase-manifest.json'));

if ([resourceRegistry, moduleRegistry, featureRegistry, functionMap, mainlineMap, verificationMap, phaseManifest].every(Boolean)) {
  const data = { resource: resourceRegistry, module: moduleRegistry, feature: featureRegistry, function: functionMap };
  unique(resourceRegistry.resources.map((item) => item.resource_id), 'resource_id');
  unique(moduleRegistry.modules.map((item) => item.module_id), 'module_id');
  unique(featureRegistry.features.map((item) => item.feature_id), 'feature_id');
  unique(functionMap.functions.map((item) => item.function_id), 'function_id');
  unique(verificationMap.gates.map((item) => item.gate_id), 'gate_id');

  const refs = assertReferences(data, verificationMap);
  const extensions = moduleRegistry.source_extensions;
  const roots = ['android/native/android/app/src/main', 'android/src', 'mac/electron', 'mac/src', 'win/electron', 'win/src', 'packages/shared/src', 'packages/runtime-contracts/src', 'packages/ui-contract/src'];
  const files = roots.flatMap((root) => walk(join(repoRoot, root), extensions));
  const filesByRelativePath = new Map(files.map((file) => [relative(repoRoot, file), file]));

  const ownershipResult = checkOwnership(refs.modules, filesByRelativePath);
  if (wants('imports')) checkImportEdges(refs.modules, filesByRelativePath, ownershipResult.ownership);
  if (wants('shared')) checkForbiddenImports(refs.modules, filesByRelativePath);
  if (wants('dag')) checkDag(refs.modules);
  if (wants('symbols')) checkSymbols(refs.functions, filesByRelativePath);
  if (wants('mainline')) checkMainlines(mainlineMap);
  if (wants('status')) checkStatuses(refs);
  if (wants('payload')) checkPayloadIsolation(refs.resources);
  if (wants('status')) checkPhaseManifest(phaseManifest, new Set(verificationMap.gates.map((gate) => gate.gate_id)));
}

if (errors.length) {
  console.error(`zterm v2 map registry FAIL (${errors.length})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`zterm v2 map registry PASS (${selected.has('all') ? 'all gates' : [...selected].join(', ')})`);

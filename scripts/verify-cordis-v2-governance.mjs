#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const MANIFEST_PATH = 'docs/architecture/zterm-cordis-v2-phase-manifest.json';

function fail(message) {
  throw new Error(`zterm-cordis-v2 governance: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
}

function requireUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} duplicate: ${value}`);
    seen.add(value);
  }
}

function requireContains(text, expected, label) {
  if (!text.includes(expected)) fail(`${label} is not wired to ${expected}`);
}

function readManifest(root) {
  const path = resolve(root, MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${MANIFEST_PATH}: ${error.message}`);
  }
  return manifest;
}

export function validateManifest(manifest, root) {
  requireString(manifest.lifecycle_id, 'lifecycle_id');
  requireString(manifest.production_baseline, 'production_baseline');
  requireString(manifest.entrypoint, 'entrypoint');
  requireString(manifest.return_path, 'return_path');
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) fail('phases must be non-empty');

  const phaseIds = manifest.phases.map((phase) => {
    requireString(phase.id, 'phase.id');
    requireString(phase.claim, `${phase.id}.claim`);
    if (!Array.isArray(phase.depends_on) || !Array.isArray(phase.parallel_claims) || !Array.isArray(phase.gates)) {
      fail(`${phase.id} must declare depends_on, parallel_claims, gates`);
    }
    return phase.id;
  });
  requireUnique(phaseIds, 'phase.id');
  const phaseSet = new Set(phaseIds);
  for (const phase of manifest.phases) {
    for (const dependency of phase.depends_on) if (!phaseSet.has(dependency)) fail(`${phase.id} unknown dependency: ${dependency}`);
  }
  if (!phaseSet.has(manifest.entrypoint) || !phaseSet.has(manifest.return_path)) fail('entrypoint/return_path must reference phases');

  const review = manifest.review;
  if (!review || !Array.isArray(review.nodes) || !Array.isArray(review.edges) || !Array.isArray(review.documents) || !Array.isArray(review.source_anchors) || !Array.isArray(review.gates)) {
    fail('review must declare nodes, edges, documents, source_anchors, gates');
  }
  const nodeIds = review.nodes.map((node) => {
    requireString(node.id, 'review.node.id');
    requireString(node.owner_claim, `${node.id}.owner_claim`);
    requireString(node.doc, `${node.id}.doc`);
    if (!phaseSet.has(node.id)) fail(`review node is not a phase: ${node.id}`);
    if (!existsSync(resolve(root, node.doc))) fail(`review node document missing: ${node.doc}`);
    return node.id;
  });
  requireUnique(nodeIds, 'review.node.id');
  const nodeSet = new Set(nodeIds);
  if (!nodeSet.has(review.entry_node)) fail(`unknown review.entry_node: ${review.entry_node}`);
  for (const edge of review.edges) {
    requireString(edge.id, 'review.edge.id');
    requireString(edge.from, `${edge.id}.from`);
    requireString(edge.to, `${edge.id}.to`);
    requireString(edge.semantic, `${edge.id}.semantic`);
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) fail(`${edge.id} references unknown node`);
  }
  requireUnique(review.edges.map((edge) => edge.id), 'review.edge.id');
  for (const path of review.documents) if (!existsSync(resolve(root, path))) fail(`review document missing: ${path}`);
  for (const path of review.documents.filter((document) => document.endsWith('.html'))) {
    const html = readFileSync(resolve(root, path), 'utf8');
    if (/<script\b/i.test(html)) fail(`offline review contains script: ${path}`);
    if (/https?:\/\//i.test(html) || /cdn\./i.test(html)) fail(`offline review contains external dependency: ${path}`);
  }
  for (const path of review.source_anchors) if (!existsSync(resolve(root, path))) fail(`source anchor missing: ${path}`);
  const gateIds = review.gates.map((gate) => {
    requireString(gate.id, 'review.gate.id');
    requireString(gate.owner, `${gate.id}.owner`);
    if (!['active', 'pending', 'ungated'].includes(gate.status)) fail(`${gate.id} has invalid status: ${gate.status}`);
    if (gate.status === 'active') requireString(gate.command, `${gate.id}.command`);
    if (gate.status !== 'active' && 'command' in gate) fail(`${gate.id} must not declare command before active`);
    return gate.id;
  });
  requireUnique(gateIds, 'review.gate.id');
  const activeGates = review.gates.filter((gate) => gate.status === 'active');
  if (activeGates.length === 0) fail('at least one active gate is required');
  for (const gate of activeGates) {
    const commandPath = gate.command.split(/\s+/).find((part) => part.endsWith('.mjs'));
    if (!commandPath || !existsSync(resolve(root, commandPath))) fail(`${gate.id} command path is missing: ${gate.command}`);
  }
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  requireString(rootPackage.scripts?.['test:cordis-v2-governance'], 'package.json test:cordis-v2-governance');
  const androidPackage = JSON.parse(readFileSync(resolve(root, 'android/package.json'), 'utf8'));
  requireContains(androidPackage.scripts?.prebuild ?? '', 'pnpm --dir .. run test:cordis-v2-governance', 'android prebuild');
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  requireContains(ci, 'pnpm run test:cordis-v2-governance', 'CI workflow');
  return { phaseCount: manifest.phases.length, nodeCount: review.nodes.length, edgeCount: review.edges.length, activeGateCount: activeGates.length };
}

export function run(root = resolve(dirname(new URL(import.meta.url).pathname), '..')) {
  const result = validateManifest(readManifest(root), root);
  console.log(`zterm-cordis-v2 governance: PASS phases=${result.phaseCount} nodes=${result.nodeCount} edges=${result.edgeCount} activeGates=${result.activeGateCount}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) run();

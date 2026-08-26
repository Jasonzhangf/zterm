#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogReference = process.argv[2] ?? "docs/architecture/zterm-v2-parity-catalog.json";
const allowedStatuses = new Set(["verified", "pending", "blocked"]);
const failures = [];

function fail(message) {
  failures.push(message);
}

function localPath(reference) {
  return resolve(repoRoot, String(reference).split("#", 1)[0]);
}

function assertLocalFile(reference, label) {
  const path = localPath(reference);
  if (!existsSync(path)) {
    const androidCandidate = resolve(repoRoot, "android", String(reference));
    if (!existsSync(androidCandidate)) fail(`${label} missing file: ${reference}`);
  }
  return path;
}

async function readJson(reference, label) {
  try {
    return JSON.parse(await readFile(localPath(reference), "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON (${reference}): ${error.message}`);
    return null;
  }
}

const catalog = await readJson(catalogReference, "catalog");
if (!catalog) {
  console.error(failures.join("\n"));
  process.exit(1);
}

for (const field of ["schema_version", "catalog_id", "production_baseline", "platforms", "verification_profiles", "features"]) {
  if (!(field in catalog)) fail(`catalog missing ${field}`);
}

const platformIds = catalog.platforms?.map((platform) => platform.id) ?? [];
if (new Set(platformIds).size !== platformIds.length) fail("duplicate platform id");

const features = Array.isArray(catalog.features) ? catalog.features : [];
const featureIds = features.map((feature) => feature.id);
if (new Set(featureIds).size !== featureIds.length) fail("duplicate feature id");

const androidRegistry = await readJson("android/docs/feature-registry.json", "Android feature registry");
const androidFeatureIds = new Set(androidRegistry?.features?.map((feature) => feature.feature_id) ?? []);

for (const [profileId, profile] of Object.entries(catalog.verification_profiles ?? {})) {
  if (!allowedStatuses.has(profile.source_evidence?.status)) {
    fail(`${profileId}.source_evidence has invalid status`);
  }
  assertLocalFile(profile.source_evidence?.reference, `${profileId}.source_evidence`);
  if (!Array.isArray(profile.gates) || profile.gates.length === 0) {
    fail(`${profileId} has no gates`);
  }
  for (const gate of profile.gates ?? []) {
    if (!gate.id || !["command", "script", "test"].includes(gate.kind)) {
      fail(`${profileId}.${gate.id ?? "unnamed"} has invalid gate shape`);
    }
    if (!allowedStatuses.has(gate.status)) fail(`${gate.id} has invalid status`);
    if (gate.kind !== "command") assertLocalFile(gate.reference, `${gate.id}`);
  }
  if (!profile.runtime_gap) fail(`${profileId} must declare its runtime evidence gap`);
}

for (const feature of features) {
  const label = feature.id || "<unnamed>";
  if (!feature.title || !Array.isArray(feature.platforms) || feature.platforms.length === 0) {
    fail(`${label} missing title/platforms`);
  }
  for (const platform of feature.platforms ?? []) {
    if (!platformIds.includes(platform)) fail(`${label} references unknown platform ${platform}`);
  }

  if (feature.owner?.registry) {
    const registryFeature = feature.owner.feature;
    if (feature.owner.registry === "android/docs/feature-registry.json") {
      if (!androidFeatureIds.has(registryFeature)) {
        fail(`${label} references unknown Android registry feature ${registryFeature}`);
      }
    } else {
      fail(`${label} uses unsupported owner registry ${feature.owner.registry}`);
    }
  } else if (!Array.isArray(feature.owners) || feature.owners.length === 0) {
    fail(`${label} has no owner binding`);
  } else {
    for (const owner of feature.owners) assertLocalFile(owner, `${label} owner`);
  }

  for (const entryPath of feature.entry?.paths ?? []) assertLocalFile(entryPath, `${label} entrypoint`);
  if (!feature.entry?.surface || !feature.entry?.paths?.length) fail(`${label} has incomplete entrypoint`);
  for (const field of ["payload", "lifecycle", "errors"]) {
    if (!feature.behavior?.[field]) fail(`${label} behavior.${field} is empty`);
  }

  const profile = catalog.verification_profiles?.[feature.verification?.profile];
  if (!profile) fail(`${label} references unknown verification profile`);
  if (!allowedStatuses.has(feature.verification?.status)) fail(`${label} has invalid verification status`);
}

if (failures.length > 0) {
  console.error(`zterm v2 parity catalog validation failed (${failures.length})`);
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`zterm v2 parity catalog valid: ${features.length} features, ${platformIds.length} platforms`);

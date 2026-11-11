// Read-only members binding adapter. It compares the persisted binding target
// with a caller-supplied terminal catalog and never mutates either input.

function readStoredTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const backend = typeof value.backend === 'string' ? value.backend.trim() : '';
  const stableId = typeof value.stableId === 'string' ? value.stableId.trim() : '';
  return backend && stableId ? { backend, stableId } : null;
}

function isExactCatalogEntry(candidate, target) {
  return Boolean(candidate)
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && candidate.backend === target.backend
    && candidate.stableId === target.stableId;
}

/**
 * Resolve a member binding to the exact native terminal catalog entry.
 *
 * Returns a copy only when the persisted terminalTarget matches exactly one
 * live catalog entry. No match, an ambiguous catalog, or a binding without a
 * target returns null. The adapter performs no writes, opens no transport,
 * and never infers a target from a session name or anchor.
 */
export function resolveBindingTarget({ binding, catalog } = {}) {
  const stored = readStoredTarget(binding && binding.terminalTarget);
  if (!stored) {
    return null;
  }
  if (!Array.isArray(catalog)) {
    throw new TypeError('resolveBindingTarget requires a catalog array');
  }
  const matches = catalog.filter((candidate) => isExactCatalogEntry(candidate, stored));
  if (matches.length !== 1) {
    return null;
  }
  return { backend: stored.backend, stableId: stored.stableId };
}

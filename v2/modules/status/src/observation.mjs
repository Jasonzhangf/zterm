export function observation(source, value, observedAt = new Date().toISOString()) {
  return {
    source,
    observedAt,
    value,
  };
}

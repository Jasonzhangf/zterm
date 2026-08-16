export function normalizeRemoteTmuxSessionNames(sessionNames: unknown): string[] {
  if (!Array.isArray(sessionNames)) {
    return [];
  }

  return [...new Set(
    sessionNames
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

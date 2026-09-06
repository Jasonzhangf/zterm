export const EXTERNAL_STORAGE_ROOT = '/storage/emulated/0';

export function normalizeLocalDisplayPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed === EXTERNAL_STORAGE_ROOT) {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed.startsWith(`${EXTERNAL_STORAGE_ROOT}/`)) {
    return trimmed.replace(/\/+$/, '');
  }
  if (trimmed.startsWith('/')) {
    return `${EXTERNAL_STORAGE_ROOT}/${trimmed.replace(/^\/+/, '')}`.replace(
      /\/+$/,
      '',
    );
  }
  return `${EXTERNAL_STORAGE_ROOT}/${trimmed}`.replace(/\/+$/, '');
}

export function joinLocalDisplayPath(parentPath: string, childName: string) {
  const normalizedParent = normalizeLocalDisplayPath(parentPath);
  if (normalizedParent === EXTERNAL_STORAGE_ROOT) {
    return `${EXTERNAL_STORAGE_ROOT}/${childName}`;
  }
  return `${normalizedParent}/${childName}`;
}

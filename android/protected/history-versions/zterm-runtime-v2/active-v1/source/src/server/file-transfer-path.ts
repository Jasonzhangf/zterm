import { resolve } from 'node:path';

export function resolveFileTransferListPath(
  requestedPath: string | undefined,
  readCurrentSessionPath: () => string,
) {
  const trimmedRequestedPath = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (trimmedRequestedPath) {
    return resolve(trimmedRequestedPath);
  }

  const currentSessionPath = readCurrentSessionPath().trim();
  if (!currentSessionPath) {
    throw new Error('tmux pane current path unavailable');
  }

  return resolve(currentSessionPath);
}

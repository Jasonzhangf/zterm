export type FileBrowserEntryType = 'file' | 'directory';

export interface FileBrowserEntry {
  name: string;
  type: FileBrowserEntryType;
  sizeBytes: number;
  modifiedMs: number;
  path?: string;
}

export type FileBrowserSortKey = 'name' | 'modifiedMs';
export type FileBrowserSortDirection = 'asc' | 'desc';

export interface FileBrowserSortOptions {
  key: FileBrowserSortKey;
  direction: FileBrowserSortDirection;
}

export interface FileBrowserProviderDirectoryOk {
  ok: true;
  path: string;
  entries: FileBrowserEntry[];
}

export interface FileBrowserProviderDirectoryError {
  ok: false;
  path?: string;
  error: string;
}

export type FileBrowserProviderDirectoryResult =
  | FileBrowserProviderDirectoryOk
  | FileBrowserProviderDirectoryError;

export interface FileBrowserDirectoryProjection {
  kind: 'directory';
  path: string;
  entries: FileBrowserEntry[];
}

export interface FileBrowserErrorProjection {
  kind: 'error';
  path?: string;
  error: string;
}

export type FileBrowserDirectoryReadProjection =
  | FileBrowserDirectoryProjection
  | FileBrowserErrorProjection;

export type FileBrowserPreviewDecision =
  | { kind: 'directory'; reason: string }
  | { kind: 'text'; reason: string }
  | { kind: 'confirm-large-text'; reason: string; sizeBytes: number; thresholdBytes: number }
  | { kind: 'binary-disabled'; reason: string };

export const FILE_BROWSER_LARGE_TEXT_THRESHOLD_BYTES = 512 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
]);

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.app',
  '.bin',
  '.bmp',
  '.class',
  '.dmg',
  '.exe',
  '.gif',
  '.gz',
  '.heic',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.tar',
  '.tiff',
  '.webp',
  '.zip',
]);

export function normalizeFileBrowserPath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed) {
    return '';
  }

  const absolute = trimmed.startsWith('/');
  const parts: string[] = [];
  for (const rawPart of trimmed.split('/')) {
    if (!rawPart || rawPart === '.') {
      continue;
    }
    if (rawPart === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
        continue;
      }
      if (!absolute) {
        parts.push(rawPart);
      }
      continue;
    }
    parts.push(rawPart);
  }

  if (absolute) {
    return parts.length === 0 ? '/' : `/${parts.join('/')}`;
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

export function joinFileBrowserPath(parentPath: string, childName: string): string {
  const child = childName.trim();
  if (!child || child.includes('/') || child.includes('\\')) {
    throw new Error(`Invalid file browser child name: ${childName}`);
  }
  const parent = normalizeFileBrowserPath(parentPath);
  if (!parent || parent === '.') {
    return normalizeFileBrowserPath(child);
  }
  if (parent === '/') {
    return `/${child}`;
  }
  return normalizeFileBrowserPath(`${parent}/${child}`);
}

export function resolveFileBrowserParentPath(path: string): string | null {
  const normalized = normalizeFileBrowserPath(path);
  if (!normalized || normalized === '/' || normalized === '.') {
    return null;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return normalized.startsWith('/') ? '/' : null;
  }
  const parent = parts.slice(0, -1).join('/');
  return normalized.startsWith('/') ? `/${parent}` : parent;
}

export function sortFileBrowserEntries(
  entries: FileBrowserEntry[],
  options: FileBrowserSortOptions = { key: 'name', direction: 'asc' },
): FileBrowserEntry[] {
  const direction = options.direction === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    if (options.key === 'modifiedMs') {
      const modifiedDelta = (a.modifiedMs - b.modifiedMs) * direction;
      if (modifiedDelta !== 0) {
        return modifiedDelta;
      }
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * direction;
  });
}

export function projectFileBrowserDirectoryResult(
  result: FileBrowserProviderDirectoryResult,
  sort: FileBrowserSortOptions = { key: 'name', direction: 'asc' },
): FileBrowserDirectoryReadProjection {
  if (!result.ok) {
    return {
      kind: 'error',
      path: result.path,
      error: result.error,
    };
  }
  return {
    kind: 'directory',
    path: normalizeFileBrowserPath(result.path),
    entries: sortFileBrowserEntries(result.entries, sort),
  };
}

export function getFileBrowserExtension(fileName: string): string {
  const lower = fileName.trim().toLowerCase();
  const index = lower.lastIndexOf('.');
  return index > 0 ? lower.slice(index) : '';
}

export function decideFileBrowserPreview(
  entry: FileBrowserEntry,
  options: { confirmedLargeText?: boolean; largeTextThresholdBytes?: number } = {},
): FileBrowserPreviewDecision {
  if (entry.type === 'directory') {
    return { kind: 'directory', reason: 'Directories are opened through directory listing' };
  }

  const thresholdBytes = options.largeTextThresholdBytes ?? FILE_BROWSER_LARGE_TEXT_THRESHOLD_BYTES;
  const extension = getFileBrowserExtension(entry.name);
  const lowerName = entry.name.trim().toLowerCase();
  const isKnownText = TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has(lowerName);
  const isKnownBinary = BINARY_EXTENSIONS.has(extension);

  if (isKnownBinary && !isKnownText) {
    return { kind: 'binary-disabled', reason: 'Binary preview is not implemented' };
  }

  if (!isKnownText) {
    return { kind: 'binary-disabled', reason: 'File type is not a text preview candidate' };
  }

  if (entry.sizeBytes > thresholdBytes && !options.confirmedLargeText) {
    return {
      kind: 'confirm-large-text',
      reason: 'Large text preview requires explicit confirmation',
      sizeBytes: entry.sizeBytes,
      thresholdBytes,
    };
  }

  return { kind: 'text', reason: 'Text preview candidate' };
}


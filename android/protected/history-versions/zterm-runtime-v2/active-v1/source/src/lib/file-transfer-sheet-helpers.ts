/**
 * FileTransferSheet 纯 helper 子模块（client.file_browser）。
 * 从 FileTransferSheet.tsx 拆出：格式化 / 路径 / mime / markdown 预览 / 排序 / 标签解析。
 */
import { buildBoundedLocalCopyIdentity } from './file-transfer-local-edit-copy-storage';
import { BROWSER_LOCAL_EDIT_DIR, EXTERNAL_STORAGE_ROOT, LOCAL_EDIT_COPY_NAME_MAX_CHARS } from './file-transfer-sheet-constants';
import type { FileEntry } from './types';

export type FileSortField = 'name' | 'modified';
export type FileSortDirection = 'asc' | 'desc';
export type SortableFileEntry = Pick<
  FileEntry,
  'name' | 'type' | 'modified'
>;



export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 2) + "…";
}

export function isMarkdownFileName(name: string) {
  return /\.(md|markdown|mdown|mkdn)$/i.test(name.trim());
}

export function isTextPreviewFileName(name: string) {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower === "dockerfile" ||
    lower === "makefile" ||
    lower === "rakefile" ||
    lower === ".gitignore" ||
    lower === ".env"
  ) {
    return true;
  }
  return /\.(md|markdown|mdown|mkdn|txt|log|json|jsonl|ya?ml|toml|ini|env|sh|bash|zsh|fish|ts|tsx|js|jsx|mjs|cjs|css|scss|html|xml|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|sql)$/i.test(
    trimmed,
  );
}

export function encodeBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function resolveTextMimeType(name: string) {
  if (isMarkdownFileName(name)) {
    return "text/markdown";
  }
  if (/\.jsonl?$/i.test(name)) {
    return "application/json";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|xml|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|sql|sh|bash|zsh|fish)$/i.test(name)) {
    return "text/plain";
  }
  return "text/plain";
}

export function sanitizeLocalCopyFileName(fileName: string) {
  const safeName = fileName.trim().replace(/[\/\\\0:]/g, "_") || "file";
  if (safeName.length <= LOCAL_EDIT_COPY_NAME_MAX_CHARS) {
    return safeName;
  }
  const dotIndex = safeName.lastIndexOf(".");
  const extension =
    dotIndex > 0 && safeName.length - dotIndex <= 24 ? safeName.slice(dotIndex) : "";
  const baseLimit = LOCAL_EDIT_COPY_NAME_MAX_CHARS - extension.length - 2;
  return `${safeName.slice(0, Math.max(16, baseLimit))}--${extension}`;
}

export function joinRemoteCopyIdentity(
  daemonFileScopeId: string,
  remotePath: string,
  fileName: string,
) {
  const base = remotePath.trim();
  const remoteFilePath = !base || base === "/"
    ? `/${fileName}`
    : `${base.replace(/\/+$/g, "")}/${fileName}`;
  const scope = daemonFileScopeId.trim();
  return scope ? `target:${scope}\npath:${remoteFilePath}` : remoteFilePath;
}

export function buildRemoteLocalEditCopyPath(sourceIdentity: string, fileName: string) {
  return `${BROWSER_LOCAL_EDIT_DIR}/remote/${buildBoundedLocalCopyIdentity(sourceIdentity)}/${sanitizeLocalCopyFileName(fileName)}`;
}

export function buildLocalPreviewEditCopyPath(sourcePath: string, fileName: string) {
  return `${BROWSER_LOCAL_EDIT_DIR}/local/${buildBoundedLocalCopyIdentity(sourcePath)}/${sanitizeLocalCopyFileName(fileName)}`;
}

export function buildLocalEditSnapshotPath(localCopyPath: string) {
  return `${localCopyPath}.zterm-upload-snapshot`;
}

export function decodeBase64Bytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function normalizeLocalDisplayPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed === EXTERNAL_STORAGE_ROOT) {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed.startsWith(`${EXTERNAL_STORAGE_ROOT}/`)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (trimmed.startsWith("/")) {
    return `${EXTERNAL_STORAGE_ROOT}/${trimmed.replace(/^\/+/, "")}`.replace(
      /\/+$/,
      "",
    );
  }
  return `${EXTERNAL_STORAGE_ROOT}/${trimmed}`.replace(/\/+$/, "");
}

export function joinLocalDisplayPath(parentPath: string, childName: string) {
  const normalizedParent = normalizeLocalDisplayPath(parentPath);
  if (normalizedParent === EXTERNAL_STORAGE_ROOT) {
    return `${EXTERNAL_STORAGE_ROOT}/${childName}`;
  }
  return `${normalizedParent}/${childName}`;
}

export function isNativePathNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|not found|enoent/i.test(message);
}

export function fileUriMatchesPath(uri: string | undefined, targetPath: string) {
  if (!uri) {
    return true;
  }
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" && decodeURIComponent(parsed.pathname) === targetPath;
  } catch {
    return uri === `file://${targetPath}`;
  }
}

export function getParentLocalDisplayPath(path: string) {
  const normalized = normalizeLocalDisplayPath(path);
  if (normalized === EXTERNAL_STORAGE_ROOT) {
    return EXTERNAL_STORAGE_ROOT;
  }
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent.length >= EXTERNAL_STORAGE_ROOT.length
    ? parent
    : EXTERNAL_STORAGE_ROOT;
}

export function compareFileEntries(
  a: SortableFileEntry,
  b: SortableFileEntry,
  sortField: FileSortField,
  sortDirection: FileSortDirection,
) {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  const value =
    sortField === "modified"
      ? a.modified - b.modified || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name);
  return sortDirection === "asc" ? value : -value;
}


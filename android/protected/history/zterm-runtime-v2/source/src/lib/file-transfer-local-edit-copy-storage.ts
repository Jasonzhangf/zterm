/**
 * FileTransferSheet 本地编辑副本状态持久化 owner（client.file_browser）。
 * 组件禁止直写 localStorage；本模块统一读写 per-kind/per-source 编辑副本同步状态。
 */

export const LOCAL_EDIT_COPY_STATE_PREFIX = 'zterm:file-browser-edit-copy:v1';

export type LocalEditCopyKind = 'remote' | 'local';

export type LocalEditCopyState = {
  state: 'unsynced' | 'synced';
  sourceIdentity: string;
  path: string;
  fileName: string;
  size: number;
  modified: number;
};

export function buildBoundedLocalCopyIdentity(value: string) {
  const source = value || 'cwd';
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
    hashB = Math.imul((hashB + code) >>> 0, 0x85ebca6b) >>> 0;
    hashB = (hashB ^ (hashB >>> 13)) >>> 0;
  }
  return [
    source.length.toString(36),
    hashA.toString(36).padStart(7, '0'),
    hashB.toString(36).padStart(7, '0'),
  ].join('-');
}

export function buildLocalEditCopyStateKey(
  kind: LocalEditCopyKind,
  sourceIdentity: string,
) {
  return `${LOCAL_EDIT_COPY_STATE_PREFIX}:${kind}:${buildBoundedLocalCopyIdentity(sourceIdentity)}`;
}

export function readLocalEditCopyState(
  kind: LocalEditCopyKind,
  sourceIdentity: string,
  targetPath: string,
): LocalEditCopyState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(
      buildLocalEditCopyStateKey(kind, sourceIdentity),
    );
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<LocalEditCopyState>;
    if (
      (parsed.state === 'unsynced' || parsed.state === 'synced') &&
      parsed.sourceIdentity === sourceIdentity &&
      parsed.path === targetPath &&
      typeof parsed.fileName === 'string' &&
      typeof parsed.size === 'number' &&
      typeof parsed.modified === 'number'
    ) {
      return parsed as LocalEditCopyState;
    }
  } catch {
    return null;
  }
  return null;
}

export function writeLocalEditCopyState(
  kind: LocalEditCopyKind,
  sourceIdentity: string,
  state: Omit<LocalEditCopyState, 'sourceIdentity'>,
) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(
    buildLocalEditCopyStateKey(kind, sourceIdentity),
    JSON.stringify({ ...state, sourceIdentity }),
  );
}

export const MAX_SESSION_PREVIEW_SELECTION = 6;
export const SESSION_PREVIEW_SELECTION_STORAGE_KEY = 'zterm:session-preview-selection:v1';

export interface SessionPreviewTarget {
  sessionId: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}

export interface SessionPreviewSelectionV1 {
  version: 1;
  orderedTargets: SessionPreviewTarget[];
}

interface SessionPreviewStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function normalizeTarget(value: unknown): SessionPreviewTarget | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SessionPreviewTarget>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const bridgePort = Number(candidate.bridgePort);
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';
  if (!sessionId || !bridgeHost || !Number.isInteger(bridgePort) || bridgePort <= 0 || !sessionName) {
    return null;
  }
  const daemonHostId = typeof candidate.daemonHostId === 'string'
    ? candidate.daemonHostId.trim() || undefined
    : undefined;
  return { sessionId, daemonHostId, bridgeHost, bridgePort, sessionName };
}

export function normalizeSessionPreviewSelection(value: unknown): SessionPreviewSelectionV1 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SessionPreviewSelectionV1>;
  if (candidate.version !== 1 || !Array.isArray(candidate.orderedTargets)) return null;
  const seen = new Set<string>();
  const orderedTargets: SessionPreviewTarget[] = [];
  for (const raw of candidate.orderedTargets) {
    const item = normalizeTarget(raw);
    if (!item || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    orderedTargets.push(item);
    if (orderedTargets.length === MAX_SESSION_PREVIEW_SELECTION) break;
  }
  return { version: 1, orderedTargets };
}

export function toggleSessionPreviewTarget(
  selection: SessionPreviewSelectionV1,
  rawTarget: SessionPreviewTarget,
): { ok: true; selection: SessionPreviewSelectionV1 } | {
  ok: false;
  reason: 'limit' | 'invalid';
  selection: SessionPreviewSelectionV1;
} {
  const target = normalizeTarget(rawTarget);
  if (!target) return { ok: false, reason: 'invalid', selection };
  const existingIndex = selection.orderedTargets.findIndex((item) => item.sessionId === target.sessionId);
  if (existingIndex >= 0) {
    return {
      ok: true,
      selection: {
        version: 1,
        orderedTargets: selection.orderedTargets.filter((_, index) => index !== existingIndex),
      },
    };
  }
  if (selection.orderedTargets.length >= MAX_SESSION_PREVIEW_SELECTION) {
    return { ok: false, reason: 'limit', selection };
  }
  return {
    ok: true,
    selection: { version: 1, orderedTargets: [...selection.orderedTargets, target] },
  };
}

export function replaceSessionPreviewTarget(
  selection: SessionPreviewSelectionV1,
  sourceSessionId: string,
  rawTarget: SessionPreviewTarget,
): { ok: true; selection: SessionPreviewSelectionV1 } | {
  ok: false;
  reason: 'source-missing' | 'already-selected' | 'invalid';
  selection: SessionPreviewSelectionV1;
} {
  const sourceIndex = selection.orderedTargets.findIndex((item) => item.sessionId === sourceSessionId);
  if (sourceIndex < 0) return { ok: false, reason: 'source-missing', selection };
  const target = normalizeTarget(rawTarget);
  if (!target) return { ok: false, reason: 'invalid', selection };
  const selectedIndex = selection.orderedTargets.findIndex((item) => item.sessionId === target.sessionId);
  if (selectedIndex >= 0 && selectedIndex !== sourceIndex) {
    return { ok: false, reason: 'already-selected', selection };
  }
  const orderedTargets = selection.orderedTargets.slice();
  orderedTargets[sourceIndex] = target;
  return { ok: true, selection: { version: 1, orderedTargets } };
}

export function appendSessionPreviewTarget(
  selection: SessionPreviewSelectionV1,
  rawTarget: SessionPreviewTarget,
): { ok: true; selection: SessionPreviewSelectionV1 } | {
  ok: false;
  reason: 'limit' | 'already-selected' | 'invalid';
  selection: SessionPreviewSelectionV1;
} {
  const target = normalizeTarget(rawTarget);
  if (!target) return { ok: false, reason: 'invalid', selection };
  if (selection.orderedTargets.some((item) => item.sessionId === target.sessionId)) {
    return { ok: false, reason: 'already-selected', selection };
  }
  if (selection.orderedTargets.length >= MAX_SESSION_PREVIEW_SELECTION) {
    return { ok: false, reason: 'limit', selection };
  }
  return { ok: true, selection: { version: 1, orderedTargets: [...selection.orderedTargets, target] } };
}

export function removeSessionPreviewTarget(
  selection: SessionPreviewSelectionV1,
  sourceSessionId: string,
): { ok: true; selection: SessionPreviewSelectionV1 } | {
  ok: false;
  reason: 'source-missing';
  selection: SessionPreviewSelectionV1;
} {
  const sourceIndex = selection.orderedTargets.findIndex((item) => item.sessionId === sourceSessionId);
  if (sourceIndex < 0) return { ok: false, reason: 'source-missing', selection };
  return {
    ok: true,
    selection: {
      version: 1,
      orderedTargets: selection.orderedTargets.filter((_, index) => index !== sourceIndex),
    },
  };
}

export function moveSessionPreviewTarget(
  selection: SessionPreviewSelectionV1,
  sourceSessionId: string,
  targetIndex: number,
): { ok: true; selection: SessionPreviewSelectionV1 } | {
  ok: false;
  reason: 'source-missing' | 'invalid-index';
  selection: SessionPreviewSelectionV1;
} {
  const sourceIndex = selection.orderedTargets.findIndex((item) => item.sessionId === sourceSessionId);
  if (sourceIndex < 0) return { ok: false, reason: 'source-missing', selection };
  const boundedTargetIndex = Math.trunc(targetIndex);
  if (
    !Number.isInteger(boundedTargetIndex)
    || boundedTargetIndex < 0
    || boundedTargetIndex >= selection.orderedTargets.length
  ) {
    return { ok: false, reason: 'invalid-index', selection };
  }
  if (sourceIndex === boundedTargetIndex) return { ok: true, selection };
  const orderedTargets = selection.orderedTargets.slice();
  const [target] = orderedTargets.splice(sourceIndex, 1);
  orderedTargets.splice(boundedTargetIndex, 0, target);
  return { ok: true, selection: { version: 1, orderedTargets } };
}

export function resolveSessionPreviewTargets<T extends {
  id: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}>(
  selection: SessionPreviewSelectionV1,
  openSessions: readonly T[],
): T[] {
  const byId = new Map(openSessions.map((session) => [session.id, session]));
  return selection.orderedTargets
    .map((target) => {
      const session = byId.get(target.sessionId);
      if (
        !session
        || session.bridgeHost !== target.bridgeHost
        || session.bridgePort !== target.bridgePort
        || session.sessionName !== target.sessionName
        || (target.daemonHostId && session.daemonHostId !== target.daemonHostId)
      ) {
        return null;
      }
      return session;
    })
    .filter((session): session is T => session !== null);
}

export function pruneSessionPreviewSelectionToOpenSessions<T extends {
  id: string;
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
}>(
  selection: SessionPreviewSelectionV1,
  openSessions: readonly T[],
): SessionPreviewSelectionV1 {
  const resolvedIds = new Set(
    resolveSessionPreviewTargets(selection, openSessions).map((session) => session.id),
  );
  const orderedTargets = selection.orderedTargets.filter((target) =>
    resolvedIds.has(target.sessionId),
  );
  return orderedTargets.length === selection.orderedTargets.length
    ? selection
    : { version: 1, orderedTargets };
}

export function projectSessionPreviewLiveIds(
  normalVisibleIds: readonly string[],
  selectedIds: readonly string[],
  previewOpen: boolean,
  foreground: boolean,
) {
  const projected = previewOpen && foreground
    ? [...normalVisibleIds, ...selectedIds]
    : [...normalVisibleIds];
  return [...new Set(projected.filter(Boolean))];
}

export function readSessionPreviewSelection(storage: SessionPreviewStorage):
  | { status: 'empty'; selection: SessionPreviewSelectionV1 }
  | { status: 'available'; selection: SessionPreviewSelectionV1 }
  | { status: 'invalid'; error: unknown } {
  try {
    const raw = storage.getItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY);
    if (!raw) return { status: 'empty', selection: { version: 1, orderedTargets: [] } };
    const selection = normalizeSessionPreviewSelection(JSON.parse(raw));
    if (!selection) return { status: 'invalid', error: new Error('Invalid session preview selection') };
    return { status: 'available', selection };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

export function writeSessionPreviewSelection(
  storage: Pick<SessionPreviewStorage, 'setItem'>,
  selection: SessionPreviewSelectionV1,
): { ok: true } | { ok: false; error: unknown } {
  try {
    storage.setItem(SESSION_PREVIEW_SELECTION_STORAGE_KEY, JSON.stringify(selection));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

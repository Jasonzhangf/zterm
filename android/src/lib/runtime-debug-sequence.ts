export interface RuntimeDebugLogEntryLike {
  seq?: number;
  ts?: string;
  scope?: string;
  payload?: string | null;
}

export interface ParsedRuntimeSequenceEvent {
  seq: number;
  ts: string;
  scope: string;
  kind: 'buffer-sync' | 'buffer-head' | 'buffer-request' | 'buffer-applied' | 'buffer-apply-noop' | 'other';
  sessionId: string | null;
  payload: Record<string, unknown> | null;
}

export interface RuntimeSequenceAnomaly {
  kind: 'local-truth-stalled-after-buffer-sync';
  sessionId: string | null;
  seq: number;
  scope: string;
  previousBufferSyncSeq: number;
  previousBufferSyncRevision: number;
  previousBufferSyncEndIndex: number;
  observedLocalRevision: number;
  observedLocalEndIndex: number;
}

function safeParsePayload(payload: string | null | undefined) {
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classifyScope(scope: string): ParsedRuntimeSequenceEvent['kind'] {
  if (scope.endsWith('.buffer-sync')) {
    return 'buffer-sync';
  }
  if (scope === 'session.buffer.head') {
    return 'buffer-head';
  }
  if (scope === 'session.buffer.request') {
    return 'buffer-request';
  }
  if (scope === 'session.buffer.applied') {
    return 'buffer-applied';
  }
  if (scope === 'session.buffer.apply.noop') {
    return 'buffer-apply-noop';
  }
  return 'other';
}

export function parseRuntimeSequenceEntries(entries: RuntimeDebugLogEntryLike[]) {
  return entries.map((entry, index) => {
    const scope = typeof entry.scope === 'string' ? entry.scope : 'unknown';
    const payload = safeParsePayload(typeof entry.payload === 'string' ? entry.payload : null);
    return {
      seq: Number.isFinite(entry.seq) ? Math.floor(entry.seq as number) : index + 1,
      ts: typeof entry.ts === 'string' ? entry.ts : '',
      scope,
      kind: classifyScope(scope),
      sessionId:
        payload && typeof payload.sessionId === 'string'
          ? payload.sessionId
          : null,
      payload,
    } satisfies ParsedRuntimeSequenceEvent;
  }).sort((left, right) => left.seq - right.seq);
}

export function detectRuntimeSequenceAnomalies(events: ParsedRuntimeSequenceEvent[]) {
  const anomalies: RuntimeSequenceAnomaly[] = [];
  const lastBufferSyncBySession = new Map<string, {
    seq: number;
    revision: number;
    endIndex: number;
  }>();

  for (const event of events) {
    const sessionKey = event.sessionId || '__unknown__';
    if (event.kind === 'buffer-sync') {
      const payload = event.payload?.payload;
      if (payload && typeof payload === 'object') {
        lastBufferSyncBySession.set(sessionKey, {
          seq: event.seq,
          revision: Number.isFinite((payload as { revision?: number }).revision)
            ? Math.max(0, Math.floor((payload as { revision?: number }).revision || 0))
            : 0,
          endIndex: Number.isFinite((payload as { endIndex?: number }).endIndex)
            ? Math.max(0, Math.floor((payload as { endIndex?: number }).endIndex || 0))
            : 0,
        });
      }
      continue;
    }

    if (event.kind !== 'buffer-head' && event.kind !== 'buffer-request') {
      continue;
    }

    const lastBufferSync = lastBufferSyncBySession.get(sessionKey);
    if (!lastBufferSync) {
      continue;
    }

    const payload = event.payload;
    if (!payload) {
      continue;
    }

    const observedLocalRevision = event.kind === 'buffer-head'
      ? Number.isFinite(payload.localRevision) ? Math.max(0, Math.floor(payload.localRevision as number)) : 0
      : Number.isFinite((payload.payload as { knownRevision?: number } | undefined)?.knownRevision)
        ? Math.max(0, Math.floor((payload.payload as { knownRevision?: number }).knownRevision || 0))
        : 0;

    const observedLocalEndIndex = event.kind === 'buffer-head'
      ? Number.isFinite(payload.localEndIndex) ? Math.max(0, Math.floor(payload.localEndIndex as number)) : 0
      : Number.isFinite((payload.payload as { localEndIndex?: number } | undefined)?.localEndIndex)
        ? Math.max(0, Math.floor((payload.payload as { localEndIndex?: number }).localEndIndex || 0))
        : 0;

    if (
      observedLocalRevision < lastBufferSync.revision
      || observedLocalEndIndex < lastBufferSync.endIndex
    ) {
      anomalies.push({
        kind: 'local-truth-stalled-after-buffer-sync',
        sessionId: event.sessionId,
        seq: event.seq,
        scope: event.scope,
        previousBufferSyncSeq: lastBufferSync.seq,
        previousBufferSyncRevision: lastBufferSync.revision,
        previousBufferSyncEndIndex: lastBufferSync.endIndex,
        observedLocalRevision,
        observedLocalEndIndex,
      });
    }
  }

  return anomalies;
}

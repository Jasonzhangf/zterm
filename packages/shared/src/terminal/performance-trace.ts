export type TerminalPerformanceTraceStage =
  | 'capture-start'
  | 'capture-done'
  | 'canonicalize-done'
  | 'mirror-commit'
  | 'send-start'
  | 'send-done'
  | 'client-rx'
  | 'buffer-apply-done'
  | 'render-raf'
  | 'render-commit';

export interface TerminalPerformanceTraceRecord {
  sessionId: string;
  traceId?: string;
  mirrorRevision?: number;
  subscriberId?: string;
  stage: TerminalPerformanceTraceStage;
  at: number;
  bytes?: number;
  lineCount?: number;
  transportKind?: string;
}

export interface RuntimeDebugPerformanceTraceEntry {
  sessionId: string;
  scope: string;
  payload?: string;
}

export interface TerminalPerformanceTraceSessionSummary {
  sessionId: string;
  traceId: string | null;
  mirrorRevision: number | null;
  subscriberId: string | null;
  captureToRenderMs: number | null;
  sendToRxMs: number | null;
  rxToRenderMs: number | null;
  bytes: number;
  lineCount: number;
}

export interface TerminalPerformanceTraceSummary {
  sessions: TerminalPerformanceTraceSessionSummary[];
  p95CaptureToRenderMs: number | null;
  p95SendToRxMs: number | null;
  p95RxToRenderMs: number | null;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set(['payload', 'text', 'lines', 'cells', 'content', 'data']);
const TRACE_DEBUG_SCOPE = 'terminal.performance.trace';
const MUX_CHANNEL_ID_MARKER = ':channel:';

function assertMetadataOnly(record: Record<string, unknown>) {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (key in record) {
      throw new Error('terminal performance trace must not store payload content');
    }
  }
}

export function createTerminalPerformanceTraceStore(options?: { limit?: number }) {
  const limit = Math.max(1, Math.floor(options?.limit || 500));
  const records: TerminalPerformanceTraceRecord[] = [];
  let head = 0;

  return {
    record(record: TerminalPerformanceTraceRecord) {
      assertMetadataOnly(record as unknown as Record<string, unknown>);
      const nextRecord = {
        sessionId: record.sessionId,
        traceId: record.traceId,
        mirrorRevision: Number.isFinite(record.mirrorRevision) ? Math.max(0, Math.floor(record.mirrorRevision || 0)) : undefined,
        subscriberId: record.subscriberId,
        stage: record.stage,
        at: Math.max(0, Math.floor(record.at || 0)),
        bytes: Number.isFinite(record.bytes) ? Math.max(0, Math.floor(record.bytes || 0)) : undefined,
        lineCount: Number.isFinite(record.lineCount) ? Math.max(0, Math.floor(record.lineCount || 0)) : undefined,
        transportKind: record.transportKind,
      };
      if (records.length < limit) {
        records.push(nextRecord);
        return;
      }
      records[head] = nextRecord;
      head = (head + 1) % limit;
    },
    snapshot() {
      if (records.length < limit || head === 0) {
        return records.map((record) => ({ ...record }));
      }
      return records
        .slice(head)
        .concat(records.slice(0, head))
        .map((record) => ({ ...record }));
    },
    clear() {
      records.splice(0, records.length);
      head = 0;
    },
  };
}

function normalizeTraceStage(input: unknown): TerminalPerformanceTraceStage | null {
  if (typeof input !== 'string') {
    return null;
  }
  switch (input) {
    case 'capture-start':
    case 'capture-done':
    case 'canonicalize-done':
    case 'mirror-commit':
    case 'send-start':
    case 'send-done':
    case 'client-rx':
    case 'buffer-apply-done':
    case 'render-raf':
    case 'render-commit':
      return input;
    default:
      return null;
  }
}

function numberOrUndefined(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input)
    ? Math.max(0, Math.floor(input))
    : undefined;
}

export function parseRuntimeDebugPerformanceTraceRecords(
  entries: RuntimeDebugPerformanceTraceEntry[],
): TerminalPerformanceTraceRecord[] {
  const records: TerminalPerformanceTraceRecord[] = [];
  for (const entry of entries) {
    if (entry.scope !== TRACE_DEBUG_SCOPE || !entry.payload) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(entry.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const stage = normalizeTraceStage(parsed.stage);
    if (!stage) {
      continue;
    }
    const safeRecord: TerminalPerformanceTraceRecord = {
      sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
        ? parsed.sessionId.trim()
        : entry.sessionId,
      traceId: typeof parsed.traceId === 'string' && parsed.traceId.trim()
        ? parsed.traceId.trim()
        : undefined,
      mirrorRevision: numberOrUndefined(parsed.mirrorRevision),
      subscriberId: typeof parsed.subscriberId === 'string' && parsed.subscriberId.trim()
        ? parsed.subscriberId.trim()
        : undefined,
      stage,
      at: numberOrUndefined(parsed.at) ?? Date.now(),
      bytes: numberOrUndefined(parsed.bytes),
      lineCount: numberOrUndefined(parsed.lineCount),
      transportKind: typeof parsed.transportKind === 'string' && parsed.transportKind.trim()
        ? parsed.transportKind.trim()
        : undefined,
    };
    records.push(safeRecord);
  }
  return records;
}

function percentile95(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function normalizeMuxChannelTraceIdentity(input: string | null | undefined) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) {
    return '';
  }
  const markerIndex = value.lastIndexOf(MUX_CHANNEL_ID_MARKER);
  if (markerIndex < 0) {
    return value;
  }
  return value.slice(markerIndex + MUX_CHANNEL_ID_MARKER.length).trim() || value;
}

function buildTraceSampleKey(record: TerminalPerformanceTraceRecord) {
  const canonicalSessionId = normalizeMuxChannelTraceIdentity(record.sessionId);
  const canonicalTraceId = normalizeMuxChannelTraceIdentity(record.traceId);
  const canonicalSubscriberId = normalizeMuxChannelTraceIdentity(record.subscriberId || record.sessionId);
  return [
    canonicalSessionId,
    canonicalTraceId || '__legacy_trace__',
    Number.isFinite(record.mirrorRevision) ? String(record.mirrorRevision) : '__legacy_revision__',
    canonicalSubscriberId || '__legacy_subscriber__',
  ].join('\u0000');
}

export function summarizeTerminalPerformanceTrace(
  records: TerminalPerformanceTraceRecord[],
): TerminalPerformanceTraceSummary {
  const bySample = new Map<string, TerminalPerformanceTraceRecord[]>();
  for (const record of records) {
    const sampleKey = buildTraceSampleKey(record);
    const current = bySample.get(sampleKey) || [];
    current.push(record);
    bySample.set(sampleKey, current);
  }

  const sessions = Array.from(bySample.values()).map((sessionRecords) => {
    const first = sessionRecords[0];
    const byStage = new Map<TerminalPerformanceTraceStage, TerminalPerformanceTraceRecord>();
    for (const record of sessionRecords) {
      byStage.set(record.stage, record);
    }
    const captureStart = byStage.get('capture-start')?.at;
    const sendDone = byStage.get('send-done')?.at;
    const clientRx = byStage.get('client-rx')?.at;
    const renderCommit = byStage.get('render-commit')?.at;
    return {
      sessionId: first?.sessionId || '',
      traceId: first?.traceId || null,
      mirrorRevision: Number.isFinite(first?.mirrorRevision) ? Math.max(0, Math.floor(first?.mirrorRevision || 0)) : null,
      subscriberId: first?.subscriberId || null,
      captureToRenderMs: Number.isFinite(captureStart) && Number.isFinite(renderCommit)
        ? Math.max(0, (renderCommit || 0) - (captureStart || 0))
        : null,
      sendToRxMs: Number.isFinite(sendDone) && Number.isFinite(clientRx)
        ? Math.max(0, (clientRx || 0) - (sendDone || 0))
        : null,
      rxToRenderMs: Number.isFinite(clientRx) && Number.isFinite(renderCommit)
        ? Math.max(0, (renderCommit || 0) - (clientRx || 0))
        : null,
      bytes: sessionRecords.reduce((sum, record) => sum + Math.max(0, record.bytes || 0), 0),
      lineCount: sessionRecords.reduce((max, record) => Math.max(max, record.lineCount || 0), 0),
    };
  });

  return {
    sessions,
    p95CaptureToRenderMs: percentile95(
      sessions
        .map((session) => session.captureToRenderMs)
        .filter((value): value is number => Number.isFinite(value)),
    ),
    p95SendToRxMs: percentile95(
      sessions
        .map((session) => session.sendToRxMs)
        .filter((value): value is number => Number.isFinite(value)),
    ),
    p95RxToRenderMs: percentile95(
      sessions
        .map((session) => session.rxToRenderMs)
        .filter((value): value is number => Number.isFinite(value)),
    ),
  };
}

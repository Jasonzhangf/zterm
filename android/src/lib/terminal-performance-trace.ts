export type TerminalPerformanceTraceStage =
  | 'capture-start'
  | 'capture-done'
  | 'canonicalize-done'
  | 'send-start'
  | 'send-done'
  | 'client-rx'
  | 'buffer-apply-done'
  | 'render-commit';

export interface TerminalPerformanceTraceRecord {
  sessionId: string;
  stage: TerminalPerformanceTraceStage;
  at: number;
  bytes?: number;
  lineCount?: number;
  transportKind?: string;
}

export interface TerminalPerformanceTraceSessionSummary {
  sessionId: string;
  captureToRenderMs: number | null;
  sendToRxMs: number | null;
  rxToRenderMs: number | null;
  bytes: number;
  lineCount: number;
}

export interface TerminalPerformanceTraceSummary {
  sessions: TerminalPerformanceTraceSessionSummary[];
  p95CaptureToRenderMs: number | null;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set(['payload', 'text', 'lines', 'cells', 'content', 'data']);

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

  return {
    record(record: TerminalPerformanceTraceRecord) {
      assertMetadataOnly(record as unknown as Record<string, unknown>);
      records.push({
        sessionId: record.sessionId,
        stage: record.stage,
        at: Math.max(0, Math.floor(record.at || 0)),
        bytes: Number.isFinite(record.bytes) ? Math.max(0, Math.floor(record.bytes || 0)) : undefined,
        lineCount: Number.isFinite(record.lineCount) ? Math.max(0, Math.floor(record.lineCount || 0)) : undefined,
        transportKind: record.transportKind,
      });
      while (records.length > limit) {
        records.shift();
      }
    },
    snapshot() {
      return records.map((record) => ({ ...record }));
    },
    clear() {
      records.splice(0, records.length);
    },
  };
}

function percentile95(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

export function summarizeTerminalPerformanceTrace(
  records: TerminalPerformanceTraceRecord[],
): TerminalPerformanceTraceSummary {
  const bySession = new Map<string, TerminalPerformanceTraceRecord[]>();
  for (const record of records) {
    const current = bySession.get(record.sessionId) || [];
    current.push(record);
    bySession.set(record.sessionId, current);
  }

  const sessions = Array.from(bySession.entries()).map(([sessionId, sessionRecords]) => {
    const byStage = new Map<TerminalPerformanceTraceStage, TerminalPerformanceTraceRecord>();
    for (const record of sessionRecords) {
      byStage.set(record.stage, record);
    }
    const captureStart = byStage.get('capture-start')?.at;
    const sendDone = byStage.get('send-done')?.at;
    const clientRx = byStage.get('client-rx')?.at;
    const renderCommit = byStage.get('render-commit')?.at;
    return {
      sessionId,
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
  };
}

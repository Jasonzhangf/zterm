import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries, type RuntimeDebugLogEntryLike } from './runtime-debug-sequence';

export interface ApkSmokeDebugSnapshotRecord {
  sessionId?: string;
  tmuxSessionName?: string;
  updatedAt?: string;
  snapshot?: unknown;
}

export interface ApkSmokeRuntimeSnapshot {
  clientDebugSnapshots?: ApkSmokeDebugSnapshotRecord[];
  clientSessions?: Array<Record<string, unknown>>;
  transportSubscribers?: Array<Record<string, unknown>>;
}

export interface ApkSmokeRuntimeLogs {
  entries?: RuntimeDebugLogEntryLike[];
}

export interface ApkSmokeTerminalRuntimeVerdict {
  ok: boolean;
  activeSessionId: string | null;
  failedChecks: string[];
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
}

export function isApkSmokeClientInputSendScope(scope: string) {
  return scope === 'session.input.send'
    || scope === 'session.input.reliable-send';
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveLatestSnapshotRecord(snapshot: ApkSmokeRuntimeSnapshot) {
  const records = Array.isArray(snapshot.clientDebugSnapshots) ? snapshot.clientDebugSnapshots : [];
  return [...records].sort((left, right) => {
    const leftAt = asString(left.updatedAt) || '';
    const rightAt = asString(right.updatedAt) || '';
    return rightAt.localeCompare(leftAt);
  })[0] || null;
}

function resolveActiveSessionId(record: ApkSmokeDebugSnapshotRecord | null) {
  const snapshotPayload = asRecord(record?.snapshot);
  const sources = asRecord(snapshotPayload?.sources);
  const appShell = asRecord(sources?.['app-shell']);
  const terminalPage = asRecord(sources?.['terminal-page']);
  const candidates = [
    terminalPage?.activeSessionId,
    appShell?.terminalActiveSessionId,
    appShell?.activeRuntimeSessionId,
    record?.sessionId,
  ];
  for (const candidate of candidates) {
    const normalized = asString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function resolveTerminalPageActive(record: ApkSmokeDebugSnapshotRecord | null) {
  const snapshotPayload = asRecord(record?.snapshot);
  const sources = asRecord(snapshotPayload?.sources);
  const appShell = asRecord(sources?.['app-shell']);
  const terminalPage = asRecord(sources?.['terminal-page']);
  return {
    appShell,
    terminalPage,
    ok: asString(appShell?.page) === 'terminal' && Boolean(asString(terminalPage?.activeSessionId)),
  };
}

export function evaluateApkSmokeTerminalRuntime(
  snapshot: ApkSmokeRuntimeSnapshot,
  logs: ApkSmokeRuntimeLogs,
): ApkSmokeTerminalRuntimeVerdict {
  const latestSnapshotRecord = resolveLatestSnapshotRecord(snapshot);
  const activeSessionId = resolveActiveSessionId(latestSnapshotRecord);
  const terminalPageState = resolveTerminalPageActive(latestSnapshotRecord);
  const parsedEvents = parseRuntimeSequenceEntries(Array.isArray(logs.entries) ? logs.entries : []);
  const sessionEvents = activeSessionId
    ? parsedEvents.filter((event) => event.sessionId === activeSessionId)
    : [];
  const anomalies = activeSessionId
    ? detectRuntimeSequenceAnomalies(parsedEvents).filter((item) => item.sessionId === activeSessionId)
    : [];

  const snapshotPayload = asRecord(latestSnapshotRecord?.snapshot);
  const sources = asRecord(snapshotPayload?.sources);
  const appShell = asRecord(sources?.['app-shell']);
  const terminalPage = asRecord(sources?.['terminal-page']);

  const clientSessions = Array.isArray(snapshot.clientSessions) ? snapshot.clientSessions : [];
  const activeDaemonSession = activeSessionId
    ? clientSessions.find((session) => asString(session.id) === activeSessionId) || null
    : null;

  const bufferHeadObserved = sessionEvents.some((event) => event.scope === 'session.buffer.head');
  const bufferSyncObserved = sessionEvents.some((event) => event.scope.endsWith('.buffer-sync'));
  const bufferAppliedOrRenderedObserved = sessionEvents.some((event) => (
    event.scope === 'session.buffer.applied'
    || event.scope === 'session.render-gate.flush.inspect'
  ));

  const checks = {
    clientSnapshotPresent: Boolean(latestSnapshotRecord && snapshotPayload),
    terminalPageActive: terminalPageState.ok,
    activeSessionResolved: Boolean(activeSessionId),
    activeSessionKnownToDaemon: Boolean(activeDaemonSession),
    bufferHeadObserved,
    bufferSyncObserved,
    bufferAppliedOrRenderedObserved,
    localTruthHealthy: activeSessionId !== null && anomalies.length === 0 && bufferSyncObserved,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  return {
    ok: failedChecks.length === 0,
    activeSessionId,
    failedChecks,
    checks,
    details: {
      latestSnapshotUpdatedAt: latestSnapshotRecord?.updatedAt || null,
      appShellPage: asString(appShell?.page) || null,
      terminalPageSessionState: asString(terminalPage?.activeSessionState) || null,
      clientSessionCount: clientSessions.length,
      eventCount: sessionEvents.length,
      anomalyCount: anomalies.length,
      latestScopes: sessionEvents.slice(-6).map((event) => event.scope),
      activeDaemonSession,
    },
  };
}

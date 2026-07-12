import type { RuntimeDebugLogEntry, ServerMessage } from '../lib/types';
import type { RuntimeDebugStore } from './runtime-debug-store';
import type { TerminalSession } from './terminal-runtime-types';

export interface TerminalDebugRuntimeDeps {
  daemonRuntimeDebugEnabled: boolean;
  maxClientDebugBatchLogEntries: number;
  maxClientDebugLogPayloadChars: number;
  clientRuntimeDebugStore: RuntimeDebugStore;
  daemonRuntimeDebugStore: RuntimeDebugStore;
  sessions: Map<string, TerminalSession>;
}

export interface TerminalDebugRuntime {
  logTimePrefix: (date?: Date) => string;
  daemonRuntimeDebug: (scope: string, payload?: unknown) => void;
  setDaemonRuntimeDebugEnabled: (enabled: boolean) => void;
  summarizePayload: (message: ServerMessage) => Record<string, unknown> | null;
  handleClientDebugLog: (session: TerminalSession, payload: { entries: RuntimeDebugLogEntry[] }) => void;
  handleClientDebugSnapshot: (session: TerminalSession, payload: { snapshot?: unknown }) => void;
}

export function createTerminalDebugRuntime(
  deps: TerminalDebugRuntimeDeps,
): TerminalDebugRuntime {
  let daemonRuntimeDebugEnabled = deps.daemonRuntimeDebugEnabled;
  let daemonRuntimeDebugSeq = 0;

  function formatLocalLogTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    const timezoneOffsetMinutes = -date.getTimezoneOffset();
    const sign = timezoneOffsetMinutes >= 0 ? '+' : '-';
    const timezoneHours = String(Math.floor(Math.abs(timezoneOffsetMinutes) / 60)).padStart(2, '0');
    const timezoneMinutes = String(Math.abs(timezoneOffsetMinutes) % 60).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis} ${sign}${timezoneHours}:${timezoneMinutes}`;
  }

  function logTimePrefix(date = new Date()) {
    return formatLocalLogTimestamp(date);
  }

  function setDaemonRuntimeDebugEnabled(enabled: boolean) {
    daemonRuntimeDebugEnabled = enabled;
  }

  function sanitizeDaemonDebugPayload(payload: unknown) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    const source = payload as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const key of [
      'transportId',
      'sessionId',
      'sessionName',
      'reason',
      'bytes',
      'durationMs',
      'queueDepth',
      'type',
      'payloadSummary',
    ]) {
      if (source[key] !== undefined) {
        sanitized[key] = source[key];
      }
    }
    if (source.payloadSummary && typeof source.payloadSummary === 'object' && !Array.isArray(source.payloadSummary)) {
      sanitized.payloadSummary = source.payloadSummary;
    }
    return sanitized;
  }

  function stringifyDaemonDebugPayload(payload: Record<string, unknown>) {
    const text = JSON.stringify(payload);
    return truncateDaemonLogPayload(text, deps.maxClientDebugLogPayloadChars);
  }

  function daemonRuntimeDebug(scope: string, payload?: unknown) {
    if (!daemonRuntimeDebugEnabled) {
      return;
    }

    const timestamp = logTimePrefix();
    const sanitizedPayload = sanitizeDaemonDebugPayload(payload);
    const sessionId = typeof sanitizedPayload.sessionId === 'string' && sanitizedPayload.sessionId.trim()
      ? sanitizedPayload.sessionId.trim()
      : 'daemon';
    const tmuxSessionName = typeof sanitizedPayload.sessionName === 'string' && sanitizedPayload.sessionName.trim()
      ? sanitizedPayload.sessionName.trim()
      : 'daemon';
    const payloadText = Object.keys(sanitizedPayload).length > 0
      ? stringifyDaemonDebugPayload(sanitizedPayload)
      : '';

    deps.daemonRuntimeDebugStore.appendBatch(
      {
        sessionId,
        tmuxSessionName,
      },
      [{
        seq: ++daemonRuntimeDebugSeq,
        ts: timestamp,
        scope,
        payload: payloadText,
      }],
    );

    if (payloadText) {
      console.debug(`[daemon-runtime:${scope}] ${timestamp}`, payloadText);
      return;
    }
    console.debug(`[daemon-runtime:${scope}] ${timestamp}`);
  }

  function truncateDaemonLogPayload(value: string, maxChars: number) {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxChars - 12))}…[truncated]`;
  }

  function normalizeClientDebugEntries(entries: RuntimeDebugLogEntry[]) {
    return entries
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.scope === 'string')
      .slice(0, deps.maxClientDebugBatchLogEntries)
      .map((entry) => ({
        seq: typeof entry.seq === 'number' && Number.isFinite(entry.seq) ? entry.seq : 0,
        ts: typeof entry.ts === 'string' ? entry.ts : logTimePrefix(),
        scope: truncateDaemonLogPayload(entry.scope, 120),
        payload:
          typeof entry.payload === 'string' && entry.payload.length > 0
            ? truncateDaemonLogPayload(entry.payload, deps.maxClientDebugLogPayloadChars)
            : '',
      }));
  }

  function handleClientDebugLog(session: TerminalSession, payload: { entries: RuntimeDebugLogEntry[] }) {
    const entries = normalizeClientDebugEntries(Array.isArray(payload.entries) ? payload.entries : []);
    if (entries.length === 0) {
      return;
    }

    deps.clientRuntimeDebugStore.appendBatch(
      {
        sessionId: session.id,
        tmuxSessionName: session.sessionName || 'unknown',
        requestOrigin: session.transport?.requestOrigin,
      },
      entries,
    );

    console.log(
      `[${logTimePrefix()}] [client-debug] session=${session.id} tmux=${session.sessionName || 'unknown'} entries=${entries.length}`,
    );
    for (const entry of entries) {
      console.log(
        `[${logTimePrefix()}] [client-debug:${entry.scope}] seq=${entry.seq} ts=${entry.ts} session=${session.id} ${entry.payload}`,
      );
    }
  }

  function handleClientDebugSnapshot(session: TerminalSession, payload: { snapshot?: unknown }) {
    deps.clientRuntimeDebugStore.setSnapshot(
      {
        sessionId: session.id,
        tmuxSessionName: session.sessionName || 'unknown',
        requestOrigin: session.transport?.requestOrigin,
      },
      payload.snapshot ?? null,
    );

    console.log(
      `[${logTimePrefix()}] [client-debug-snapshot] session=${session.id} tmux=${session.sessionName || 'unknown'}`,
    );
  }

  function summarizePayload(message: ServerMessage) {
    if (message.type !== 'buffer-sync') {
      return null;
    }

    const payload = message.payload;
    const firstLine = payload.lines[0];
    const lastLine = payload.lines[payload.lines.length - 1];
    return {
      revision: payload.revision,
      startIndex: payload.startIndex,
      endIndex: payload.endIndex,
      rows: payload.rows,
      cols: payload.cols,
      lineCount: payload.lines.length,
      firstLineIndex: firstLine ? ('i' in firstLine ? firstLine.i : firstLine.index) : null,
      lastLineIndex: lastLine ? ('i' in lastLine ? lastLine.i : lastLine.index) : null,
    };
  }

  return {
    logTimePrefix,
    daemonRuntimeDebug,
    setDaemonRuntimeDebugEnabled,
    summarizePayload,
    handleClientDebugLog,
    handleClientDebugSnapshot,
  };
}

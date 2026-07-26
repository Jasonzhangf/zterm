/**
 * Session reconnect store (T2c + T9).
 *
 * Owns reconnect phase, manual close markers, and stale head-probe markers that
 * previously lived as separate refs. Illegal combinations such as
 * "connecting with a live timer" are unrepresentable:
 * - idle: no timer, not connecting
 * - scheduled: one timer handle, optional nextDelay override already consumed
 * - connecting: handshake/open in flight, no timer
 */

export type SessionReconnectTimerHandle = number;

export type SessionReconnectRuntime =
  | {
      phase: 'idle';
      attempt: number;
      nextDelayMs: number | null;
    }
  | {
      phase: 'scheduled';
      attempt: number;
      nextDelayMs: number | null;
      timer: SessionReconnectTimerHandle;
    }
  | {
      phase: 'connecting';
      attempt: number;
      nextDelayMs: number | null;
    };

export interface SessionReconnectStore {
  createRuntime: () => SessionReconnectRuntime;
  read: (sessionId: string) => SessionReconnectRuntime | null;
  write: (sessionId: string, runtime: SessionReconnectRuntime) => void;
  ensure: (sessionId: string) => SessionReconnectRuntime;
  isInFlight: (sessionId: string) => boolean;
  clearTimer: (sessionId: string) => SessionReconnectRuntime | null;
  markConnecting: (sessionId: string) => SessionReconnectRuntime | null;
  markIdle: (sessionId: string) => SessionReconnectRuntime | null;
  schedule: (
    sessionId: string,
    options: {
      attempt?: number;
      nextDelayMs?: number | null;
      timer: SessionReconnectTimerHandle;
    },
  ) => SessionReconnectRuntime;
  deleteRuntime: (sessionId: string) => void;
  clearAllReconnectRuntimes: () => void;
  markManualClosed: (sessionId: string) => void;
  clearManualClosed: (sessionId: string) => void;
  isManualClosed: (sessionId: string) => boolean;
  readStaleTransportProbeAt: (sessionId: string) => number;
  markStaleTransportProbe: (sessionId: string, startedAt: number) => void;
  markStaleTransportProbeIfAbsent: (sessionId: string, startedAt: number) => boolean;
  clearStaleTransportProbe: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  clearAll: () => void;
  values: () => IterableIterator<SessionReconnectRuntime>;
}

export function createSessionReconnectRuntime(): SessionReconnectRuntime {
  return {
    phase: 'idle',
    attempt: 0,
    nextDelayMs: null,
  };
}

export function isSessionReconnectInFlight(runtime: SessionReconnectRuntime | null | undefined) {
  return Boolean(runtime && (runtime.phase === 'scheduled' || runtime.phase === 'connecting'));
}

function clearRuntimeTimer(runtime: SessionReconnectRuntime | null | undefined) {
  if (runtime?.phase === 'scheduled') {
    globalThis.clearTimeout(runtime.timer);
  }
}

export function createSessionReconnectStore(): SessionReconnectStore {
  const runtimes = new Map<string, SessionReconnectRuntime>();
  const manualClosedSessions = new Set<string>();
  const staleTransportProbeAt = new Map<string, number>();

  const write = (sessionId: string, runtime: SessionReconnectRuntime) => {
    const existing = runtimes.get(sessionId);
    if (existing && existing !== runtime) {
      clearRuntimeTimer(existing);
    }
    runtimes.set(sessionId, runtime);
  };

  const deleteRuntime = (sessionId: string) => {
    clearRuntimeTimer(runtimes.get(sessionId));
    runtimes.delete(sessionId);
  };

  const clearAllReconnectRuntimes = () => {
    for (const runtime of runtimes.values()) {
      clearRuntimeTimer(runtime);
    }
    runtimes.clear();
  };

  return {
    createRuntime: createSessionReconnectRuntime,
    read: (sessionId) => runtimes.get(sessionId) || null,
    write,
    ensure: (sessionId) => {
      const existing = runtimes.get(sessionId);
      if (existing) {
        return existing;
      }
      const created = createSessionReconnectRuntime();
      runtimes.set(sessionId, created);
      return created;
    },
    isInFlight: (sessionId) => isSessionReconnectInFlight(runtimes.get(sessionId)),
    clearTimer: (sessionId) => {
      const existing = runtimes.get(sessionId) || null;
      if (!existing) {
        return null;
      }
      clearRuntimeTimer(existing);
      if (existing.phase === 'scheduled') {
        const next: SessionReconnectRuntime = {
          phase: 'idle',
          attempt: existing.attempt,
          nextDelayMs: existing.nextDelayMs,
        };
        write(sessionId, next);
        return next;
      }
      return existing;
    },
    markConnecting: (sessionId) => {
      const existing = runtimes.get(sessionId) || null;
      if (!existing) {
        return null;
      }
      clearRuntimeTimer(existing);
      const next: SessionReconnectRuntime = {
        phase: 'connecting',
        attempt: existing.attempt,
        nextDelayMs: null,
      };
      write(sessionId, next);
      return next;
    },
    markIdle: (sessionId) => {
      const existing = runtimes.get(sessionId) || null;
      if (!existing) {
        return null;
      }
      clearRuntimeTimer(existing);
      const next: SessionReconnectRuntime = {
        phase: 'idle',
        attempt: existing.attempt,
        nextDelayMs: existing.nextDelayMs,
      };
      write(sessionId, next);
      return next;
    },
    schedule: (sessionId, options) => {
      const existing = runtimes.get(sessionId) || createSessionReconnectRuntime();
      const next: SessionReconnectRuntime = {
        phase: 'scheduled',
        attempt: typeof options.attempt === 'number' ? options.attempt : existing.attempt,
        nextDelayMs: options.nextDelayMs === undefined ? existing.nextDelayMs : options.nextDelayMs,
        timer: options.timer,
      };
      write(sessionId, next);
      return next;
    },
    deleteRuntime,
    clearAllReconnectRuntimes,
    markManualClosed: (sessionId) => {
      manualClosedSessions.add(sessionId);
    },
    clearManualClosed: (sessionId) => {
      manualClosedSessions.delete(sessionId);
    },
    isManualClosed: (sessionId) => manualClosedSessions.has(sessionId),
    readStaleTransportProbeAt: (sessionId) => staleTransportProbeAt.get(sessionId) || 0,
    markStaleTransportProbe: (sessionId, startedAt) => {
      staleTransportProbeAt.set(sessionId, startedAt);
    },
    markStaleTransportProbeIfAbsent: (sessionId, startedAt) => {
      if (staleTransportProbeAt.has(sessionId)) {
        return false;
      }
      staleTransportProbeAt.set(sessionId, startedAt);
      return true;
    },
    clearStaleTransportProbe: (sessionId) => {
      staleTransportProbeAt.delete(sessionId);
    },
    deleteSession: (sessionId) => {
      deleteRuntime(sessionId);
      manualClosedSessions.delete(sessionId);
      staleTransportProbeAt.delete(sessionId);
    },
    clearAll: () => {
      clearAllReconnectRuntimes();
      manualClosedSessions.clear();
      staleTransportProbeAt.clear();
    },
    values: () => runtimes.values(),
  };
}

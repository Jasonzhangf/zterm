import type { SessionDebugOverlayMetrics, SessionState } from './types';

export interface SessionWireStatsSnapshot {
  txBytes: number;
  rxBytes: number;
  renderCommits: number;
  refreshRequests: number;
}

interface SessionWireStatsPreviousSnapshot {
  sample: SessionWireStatsSnapshot;
  at: number;
}

export interface SessionDebugMetricsRefreshInput {
  sessionId: string;
  sessionState: SessionState;
  active: boolean;
  pullStatePurpose: 'tail-refresh' | 'reading-repair' | null;
  bufferPullActive: boolean;
}

const DEFAULT_WIRE_STATS: SessionWireStatsSnapshot = {
  txBytes: 0,
  rxBytes: 0,
  renderCommits: 0,
  refreshRequests: 0,
};

function cloneWireStats(stats: SessionWireStatsSnapshot): SessionWireStatsSnapshot {
  return {
    txBytes: stats.txBytes,
    rxBytes: stats.rxBytes,
    renderCommits: stats.renderCommits,
    refreshRequests: stats.refreshRequests,
  };
}

function resolveDebugStatus(
  sessionState: SessionState,
  pullStatePurpose: SessionDebugMetricsRefreshInput['pullStatePurpose'],
): SessionDebugOverlayMetrics['status'] {
  return sessionState === 'error' ? 'error'
    : sessionState === 'closed' ? 'closed'
    : sessionState === 'reconnecting' ? 'reconnecting'
    : sessionState === 'connecting' ? 'connecting'
    : pullStatePurpose === 'reading-repair' ? 'loading'
    : pullStatePurpose ? 'refreshing'
    : 'waiting';
}

function sessionDebugMetricsEqual(
  left: Record<string, SessionDebugOverlayMetrics | undefined>,
  right: Record<string, SessionDebugOverlayMetrics | undefined>,
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftItem = left[key];
    const rightItem = right[key];
    if (!leftItem && !rightItem) {
      continue;
    }
    if (!leftItem || !rightItem) {
      return false;
    }
    if (
      leftItem.uplinkBps !== rightItem.uplinkBps
      || leftItem.downlinkBps !== rightItem.downlinkBps
      || leftItem.renderHz !== rightItem.renderHz
      || leftItem.pullHz !== rightItem.pullHz
      || leftItem.bufferPullActive !== rightItem.bufferPullActive
      || leftItem.status !== rightItem.status
      || leftItem.active !== rightItem.active
    ) {
      return false;
    }
  }
  return true;
}

export function createSessionDebugMetricsStore() {
  const currentWireStats = new Map<string, SessionWireStatsSnapshot>();
  const previousWireStats = new Map<string, SessionWireStatsPreviousSnapshot>();
  let metricsBySessionId: Record<string, SessionDebugOverlayMetrics | undefined> = {};

  const ensureWireStats = (sessionId: string) => {
    const current = currentWireStats.get(sessionId);
    if (current) {
      return current;
    }
    const initial = cloneWireStats(DEFAULT_WIRE_STATS);
    currentWireStats.set(sessionId, initial);
    return initial;
  };

  return {
    estimateWireBytes(data: string | ArrayBuffer) {
      if (typeof data === 'string') {
        return new TextEncoder().encode(data).byteLength;
      }
      return data.byteLength;
    },
    recordTxBytes(sessionId: string, data: string | ArrayBuffer) {
      ensureWireStats(sessionId).txBytes += this.estimateWireBytes(data);
    },
    recordRxBytes(sessionId: string, data: string | ArrayBuffer) {
      ensureWireStats(sessionId).rxBytes += this.estimateWireBytes(data);
    },
    recordRenderCommit(sessionId: string) {
      ensureWireStats(sessionId).renderCommits += 1;
    },
    recordRefreshRequest(sessionId: string) {
      ensureWireStats(sessionId).refreshRequests += 1;
    },
    clearSession(sessionId: string) {
      currentWireStats.delete(sessionId);
      previousWireStats.delete(sessionId);
      if (sessionId in metricsBySessionId) {
        const next = { ...metricsBySessionId };
        delete next[sessionId];
        metricsBySessionId = next;
      }
    },
    refresh(inputs: SessionDebugMetricsRefreshInput[], now = Date.now()) {
      const nextMetrics: Record<string, SessionDebugOverlayMetrics | undefined> = {};

      for (const input of inputs) {
        const current = currentWireStats.get(input.sessionId) || cloneWireStats(DEFAULT_WIRE_STATS);
        const previous = previousWireStats.get(input.sessionId);
        const deltaMs = previous ? Math.max(250, now - previous.at) : 1000;
        const deltaSeconds = deltaMs / 1000;
        const txBytesDelta = current.txBytes - (previous?.sample.txBytes || 0);
        const rxBytesDelta = current.rxBytes - (previous?.sample.rxBytes || 0);
        const renderDelta = current.renderCommits - (previous?.sample.renderCommits || 0);
        const pullDelta = current.refreshRequests - (previous?.sample.refreshRequests || 0);

        nextMetrics[input.sessionId] = {
          uplinkBps: Math.max(0, Math.round(txBytesDelta / deltaSeconds)),
          downlinkBps: Math.max(0, Math.round(rxBytesDelta / deltaSeconds)),
          renderHz: Math.max(0, Number((renderDelta / deltaSeconds).toFixed(1))),
          pullHz: Math.max(0, Number((pullDelta / deltaSeconds).toFixed(1))),
          bufferPullActive: input.bufferPullActive,
          status: resolveDebugStatus(input.sessionState, input.pullStatePurpose),
          active: input.active,
          updatedAt: now,
        };

        previousWireStats.set(input.sessionId, {
          sample: cloneWireStats(current),
          at: now,
        });
      }

      if (!sessionDebugMetricsEqual(metricsBySessionId, nextMetrics)) {
        metricsBySessionId = nextMetrics;
      }

      return metricsBySessionId;
    },
    getMetrics(sessionId: string, sessionState: SessionState | null, active: boolean, now = Date.now()) {
      const metrics = metricsBySessionId[sessionId] || null;
      if (!metrics) {
        if (!sessionState) {
          return null;
        }
        return {
          uplinkBps: 0,
          downlinkBps: 0,
          renderHz: 0,
          pullHz: 0,
          bufferPullActive: false,
          status: resolveDebugStatus(sessionState, null),
          active,
          updatedAt: now,
        } satisfies SessionDebugOverlayMetrics;
      }
      if (metrics.active === active) {
        return metrics;
      }
      return {
        ...metrics,
        active,
      };
    },
  };
}

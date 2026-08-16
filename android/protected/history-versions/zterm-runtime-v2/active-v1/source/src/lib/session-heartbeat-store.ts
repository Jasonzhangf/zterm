/**
 * Session heartbeat store (T2a refs 收敛).
 *
 * Owns the four heartbeat maps that previously lived as separate useRef bags in
 * session-context-provider-runtime:
 * - ping interval timer handles (keyed by heartbeat key: sessionId or `target:<targetKey>`)
 * - last pong arrival timestamps
 * - last server activity timestamps
 * - last terminal render activity timestamps (keyed by sessionId, never deleted --
 *   matches the pre-store semantics where session close only cleared timer/pong/server
 *   activity; wiping terminal activity on reconnect would change active-tick scheduling)
 *
 * Timers are created by callers; the store only holds handles. `clearPingInterval`
 * and `deleteSession` call `clearInterval` on the held handle before dropping it,
 * mirroring the original `clearSessionHeartbeat` semantics.
 *
 * No React dependency (same pattern as session-transport-runtime.ts).
 */

export type HeartbeatTimerHandle = ReturnType<typeof setInterval>;

export interface SessionHeartbeatStore {
  /** Hold a caller-created ping interval handle for a heartbeat key. */
  setPingInterval: (heartbeatKey: string, timer: HeartbeatTimerHandle) => void;
  /** Read the held ping interval handle, or null when none is registered. */
  readPingInterval: (heartbeatKey: string) => HeartbeatTimerHandle | null;
  /** clearInterval the held handle (if any) and drop it. */
  clearPingInterval: (heartbeatKey: string) => void;
  /** clearInterval every held handle and drop them all (provider dispose path). */
  clearAllPingIntervals: () => void;
  /** Keys with a live ping interval handle (test/diagnostic projection). */
  pingIntervalKeys: () => string[];
  /** Record a pong arrival. `at` defaults to Date.now(). */
  recordPong: (heartbeatKey: string, at?: number) => void;
  /** Last pong arrival timestamp, 0 when never recorded. */
  readLastPongAt: (heartbeatKey: string) => number;
  /** Record any server activity. `at` defaults to Date.now(). */
  recordServerActivity: (heartbeatKey: string, at?: number) => void;
  /** Last server activity timestamp, 0 when never recorded. */
  readLastServerActivityAt: (heartbeatKey: string) => number;
  /** Record terminal render activity for a session. `at` defaults to Date.now(). */
  recordTerminalActivity: (sessionId: string, at?: number) => void;
  /** Last terminal render activity timestamp, 0 when never recorded. */
  readLastTerminalActivityAt: (sessionId: string) => number;
  /**
   * Session/heartbeat-key teardown: clearInterval + drop the timer handle, then
   * drop pong and server-activity entries. Intentionally leaves terminal activity
   * untouched (pre-store `clearSessionHeartbeat` semantics).
   */
  deleteSession: (heartbeatKey: string) => void;
}

export function createSessionHeartbeatStore(): SessionHeartbeatStore {
  const pingIntervals = new Map<string, HeartbeatTimerHandle>();
  const lastPongAt = new Map<string, number>();
  const lastServerActivityAt = new Map<string, number>();
  const lastTerminalActivityAt = new Map<string, number>();

  const clearPingInterval = (heartbeatKey: string) => {
    const timer = pingIntervals.get(heartbeatKey);
    if (timer) {
      clearInterval(timer);
      pingIntervals.delete(heartbeatKey);
    }
  };

  return {
    setPingInterval: (heartbeatKey, timer) => {
      pingIntervals.set(heartbeatKey, timer);
    },
    readPingInterval: (heartbeatKey) => pingIntervals.get(heartbeatKey) ?? null,
    clearPingInterval,
    clearAllPingIntervals: () => {
      for (const timer of pingIntervals.values()) {
        clearInterval(timer);
      }
      pingIntervals.clear();
    },
    pingIntervalKeys: () => Array.from(pingIntervals.keys()),
    recordPong: (heartbeatKey, at) => {
      lastPongAt.set(heartbeatKey, at ?? Date.now());
    },
    readLastPongAt: (heartbeatKey) => lastPongAt.get(heartbeatKey) || 0,
    recordServerActivity: (heartbeatKey, at) => {
      lastServerActivityAt.set(heartbeatKey, at ?? Date.now());
    },
    readLastServerActivityAt: (heartbeatKey) => lastServerActivityAt.get(heartbeatKey) || 0,
    recordTerminalActivity: (sessionId, at) => {
      lastTerminalActivityAt.set(sessionId, at ?? Date.now());
    },
    readLastTerminalActivityAt: (sessionId) => lastTerminalActivityAt.get(sessionId) || 0,
    deleteSession: (heartbeatKey) => {
      clearPingInterval(heartbeatKey);
      lastPongAt.delete(heartbeatKey);
      lastServerActivityAt.delete(heartbeatKey);
    },
  };
}

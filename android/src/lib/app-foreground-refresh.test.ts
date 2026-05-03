// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createForegroundRefreshRuntime,
  markForegroundRuntimeHidden,
  performForegroundRefresh,
  summarizeResumeSessions,
} from './app-foreground-refresh';

describe('app foreground refresh orchestrator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('summarizes sessions for runtime debug without mutation', () => {
    expect(summarizeResumeSessions([{ id: 's1', state: 'connected' }])).toEqual([{ id: 's1', state: 'connected' }]);
  });

  it('marks runtime hidden', () => {
    const runtime = createForegroundRefreshRuntime();
    expect(runtime.wasHidden).toBe(false);
    markForegroundRuntimeHidden(runtime, 'hidden');
    expect(runtime.wasHidden).toBe(true);
  });

  it('explicitly resumes active transport on foreground restore and reconnects only when resume returns false', () => {
    const runtime = createForegroundRefreshRuntime();
    const resumeActiveSessionTransport = vi.fn(() => false);
    const reconnectSession = vi.fn();
    const log = vi.fn();

    const fired = performForegroundRefresh({
      reason: 'resume',
      sessions: [{ id: 's1', state: 'connected' }],
      activeSessionId: 's1',
      resumeActiveSessionTransport,
      reconnectSession,
      runtime,
      log,
    });

    expect(fired).toBe(true);
    expect(resumeActiveSessionTransport).toHaveBeenCalledWith('s1');
    expect(reconnectSession).toHaveBeenCalledWith('s1');
    expect(log).toHaveBeenCalledWith({
      reason: 'resume',
      activeSessionId: 's1',
      sessionState: 'connected',
      action: 'reconnect-active-session',
    });
  });

  it('debounces duplicate foreground restore bursts', () => {
    const runtime = createForegroundRefreshRuntime();
    const resumeActiveSessionTransport = vi.fn(() => true);
    const reconnectSession = vi.fn();

    expect(performForegroundRefresh({
      reason: 'visibilitychange',
      sessions: [{ id: 's1', state: 'connected' }],
      activeSessionId: 's1',
      resumeActiveSessionTransport,
      reconnectSession,
      runtime,
    })).toBe(true);

    expect(performForegroundRefresh({
      reason: 'resume',
      sessions: [{ id: 's1', state: 'connected' }],
      activeSessionId: 's1',
      resumeActiveSessionTransport,
      reconnectSession,
      runtime,
    })).toBe(false);

    expect(resumeActiveSessionTransport).toHaveBeenCalledTimes(1);
    expect(reconnectSession).not.toHaveBeenCalled();
  });
});

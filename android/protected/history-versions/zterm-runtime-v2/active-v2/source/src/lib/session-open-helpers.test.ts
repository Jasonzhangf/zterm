/**
 * Submodule tests: session-open-helpers (client.session_runtime).
 */
import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSessionName,
  resolveReusableOpenSessionForTarget,
  resolveSessionGroupForTarget,
  sessionMatchesOpenTarget,
} from './session-open-helpers';

function session(id: string, overrides: Record<string, unknown> = {}): any {
  return { id, bridgeHost: 'h', bridgePort: 3333, sessionName: 'sh', state: 'connected', createdAt: 1, ...overrides };
}

describe('session-open-helpers', () => {
  it('builds generated session names with a timestamp', () => {
    expect(buildGeneratedSessionName()).toMatch(/^zterm-/);
  });

  it('matches sessions to open targets by daemon or endpoint identity', () => {
    expect(sessionMatchesOpenTarget(session('s1', { daemonHostId: 'd1' }), { daemonHostId: 'd1', bridgeHost: 'h', bridgePort: 3333 } as never, 'sh')).toBe(true);
    expect(sessionMatchesOpenTarget(session('s1', { state: 'closed' }), { daemonHostId: 'd1', bridgeHost: 'h', bridgePort: 3333 } as never, 'sh')).toBe(false);
    expect(sessionMatchesOpenTarget(session('s1', { terminalBackend: 'tmux' }), { bridgeHost: 'h', bridgePort: 3333, terminalBackend: 'herdr' } as never, 'sh')).toBe(false);
  });

  it('resolves reusable sessions preferring priority ids then connection recency', () => {
    const sessions = [session('a', { state: 'connecting' }), session('b', { state: 'connected', createdAt: 5 })];
    const reusable = resolveReusableOpenSessionForTarget(sessions, { bridgeHost: 'h', bridgePort: 3333 } as never, 'sh', ['a']);
    expect(reusable?.id).toBe('a');
    const next = resolveReusableOpenSessionForTarget(sessions, { bridgeHost: 'h', bridgePort: 3333 } as never, 'sh', []);
    expect(next?.id).toBe('b');
  });

  it('resolves the session group for a target by backend and owner', () => {
    const groups = [
      { id: 'g1', name: 'G1', bridgeHost: 'h', bridgePort: 3333, terminalBackend: 'tmux' as const, sessionNames: ['sh'], lastOpenedAt: 1 },
      { id: 'g2', name: 'G2', bridgeHost: 'h', bridgePort: 3333, terminalBackend: 'herdr' as const, sessionNames: ['sh'], lastOpenedAt: 1 },
    ];
    const matched = resolveSessionGroupForTarget(groups, { bridgeHost: 'h', bridgePort: 3333, terminalBackend: 'herdr' } as never);
    expect(matched?.id).toBe('g2');
  });
});

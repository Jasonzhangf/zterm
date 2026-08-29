/**
 * Submodule tests: terminal-page-helpers (client.app_shell).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveSessionInputEpoch,
  resolveTerminalSessionGroupActiveSessionProjection,
  resolveTerminalSessionGroupSlotIds,
  terminalPageHeaderSessionUiKey,
  toTerminalTabChromeItem,
} from './terminal-page-helpers';

describe('terminal-page-helpers', () => {
  it('derives stable header ui keys', () => {
    const session = { id: 's1', bridgeHost: 'h', bridgePort: 3333, sessionName: 'sh' } as never;
    const key = terminalPageHeaderSessionUiKey(session as never);
    expect(key).toContain('s1');
    expect(terminalPageHeaderSessionUiKey(null)).toBe('');
  });

  it('resolves session input epochs', () => {
    expect(resolveSessionInputEpoch({ s1: 5 }, 's1')).toBe(5);
    expect(resolveSessionInputEpoch({ s1: 5 }, 's2')).toBe(0);
    expect(resolveSessionInputEpoch(undefined, null)).toBe(-1);
  });

  it('projects active session into the group slots', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never;
    const slots = resolveTerminalSessionGroupSlotIds({ slots: { top: 'a', center: 'b', bottom: 'c' }, sessions: sessions as never, centerSessionId: 'b' });
    expect(slots).toEqual({ top: 'a', center: 'b', bottom: 'c' });
    const projection = resolveTerminalSessionGroupActiveSessionProjection({ slots, sessions: sessions as never, activeSessionId: 'b' });
    expect(projection?.focusSlot).toBe('center');
  });

  it('builds tab chrome items from sessions', () => {
    const item = toTerminalTabChromeItem({ id: 's1', bridgeHost: 'h', bridgePort: 3333, sessionName: 'sh' } as never);
    expect(item.id).toBe('s1');
  });
});

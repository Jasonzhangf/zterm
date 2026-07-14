import { describe, expect, it, vi } from 'vitest';
import { createWindowsTerminalRegistry } from './windows-terminal-registry';
import type { WindowsTerminalSession } from './windows-terminal-session';
import { createWindowsTargetTab } from './windows-workspace';

function fakeSession(): WindowsTerminalSession {
  return {
    getSnapshot: vi.fn() as WindowsTerminalSession['getSnapshot'],
    subscribe: vi.fn(() => () => undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendInput: vi.fn(),
    requestVisibleRange: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('windows terminal runtime registry', () => {
  it('keeps one stable runtime per tab across projection switches', () => {
    const created: WindowsTerminalSession[] = [];
    const registry = createWindowsTerminalRegistry(() => {
      const session = fakeSession();
      created.push(session);
      return session;
    });
    const alpha = createWindowsTargetTab({ bridgeHost: 'host', bridgePort: 3333, sessionName: 'alpha' });
    const beta = createWindowsTargetTab({ bridgeHost: 'host', bridgePort: 3333, sessionName: 'beta' });

    expect(registry.ensure(alpha)).toBe(registry.ensure(alpha));
    registry.ensure(beta);
    expect(created).toHaveLength(2);
    expect(created[0]!.connect).toHaveBeenCalledTimes(1);
    expect(created[1]!.connect).toHaveBeenCalledTimes(1);

    registry.retain(new Set([beta.id]));
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(created[1]!.dispose).not.toHaveBeenCalled();
    registry.dispose();
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);
  });
});

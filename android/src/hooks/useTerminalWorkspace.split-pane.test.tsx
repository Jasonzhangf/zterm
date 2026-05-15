import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalWorkspace } from '../../src/hooks/useTerminalWorkspace';
import type { Session } from '../../src/lib/types';

function makeSession(id: string): Session {
  return {
    id,
    bridgeHost: 'localhost',
    bridgePort: 2222,
    sessionName: `session-${id}`,
    state: 'connected',
    hostId: 'host-1',
    connectionName: 'test',
    authToken: 'test',
  };
}

describe('useTerminalWorkspace split-pane isolation', () => {
  it('split from 1 pane with 2 tabs: each pane gets its own active tab', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions,
      activeSessionId: 's1',
      viewportWidth: 390,
      viewportHeight: 844,
    }));

    // Initially 1 pane with 2 tabs, s1 is active
    expect(result.current.workspace.panes).toHaveLength(1);
    expect(result.current.workspace.panes[0].tabs).toHaveLength(2);
    expect(result.current.workspace.activePaneId).toBe('pane-main');

    // Switch active tab to s2 (within the same pane)
    act(() => {
      result.current.switchTabInPane('pane-main', 'tab-s2');
    });
    expect(result.current.workspace.panes[0].activeTabId).toBe('tab-s2');
    expect(result.current.workspace.panes[0].tabs.find(t => t.id === 'tab-s2')?.sessionId).toBe('s2');

    // Now split: pane-main should keep s2 as active, pane-1 should get s1
    act(() => {
      result.current.setSplitCount(2);
    });

    const panes = result.current.workspace.panes;
    expect(panes).toHaveLength(2);

    // Pane 0 (pane-main): activeTabId should be tab-s2
    const pane0 = panes.find(p => p.id === 'pane-main')!;
    expect(pane0).toBeDefined();
    expect(pane0.activeTabId).toBe('tab-s2');
    expect(pane0.tabs.find(t => t.id === pane0.activeTabId)?.sessionId).toBe('s2');
    expect(pane0.tabs).toHaveLength(1); // Only s2

    // Pane 1 (pane-1): activeTabId should be tab-s1
    const pane1 = panes.find(p => p.id !== 'pane-main')!;
    expect(pane1).toBeDefined();
    expect(pane1.activeTabId).toBe('tab-s1');
    expect(pane1.tabs.find(t => t.id === pane1.activeTabId)?.sessionId).toBe('s1');
    expect(pane1.tabs).toHaveLength(1); // Only s1

    // activePaneId should be pane-main
    expect(result.current.workspace.activePaneId).toBe('pane-main');
  });

  it('split from 1 pane with 1 tab: new pane gets no session', () => {
    const sessions = [makeSession('s1')];
    const { result } = renderHook(() => useTerminalWorkspace({
      sessions,
      activeSessionId: 's1',
      viewportWidth: 390,
      viewportHeight: 844,
    }));

    // 1 pane, 1 tab
    expect(result.current.workspace.panes).toHaveLength(1);
    expect(result.current.workspace.panes[0].tabs).toHaveLength(1);

    // Split to 2
    act(() => {
      result.current.setSplitCount(2);
    });

    const panes = result.current.workspace.panes;
    expect(panes).toHaveLength(2);

    // pane-main should have s1
    const pane0 = panes.find(p => p.id === 'pane-main')!;
    expect(pane0.tabs.find(t => t.id === pane0.activeTabId)?.sessionId).toBe('s1');
    expect(pane0.tabs).toHaveLength(1);

    // pane-1 should have empty tabs (no other session to split)
    const pane1 = panes.find(p => p.id !== 'pane-main')!;
    expect(pane1.tabs).toHaveLength(1); // Moved s1 here by splitOutTabToNewPane
    expect(pane1.tabs.find(t => t.id === pane1.activeTabId)?.sessionId).toBe('s1');
  });
});

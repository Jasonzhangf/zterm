import { describe, expect, it } from 'vitest';
import {
  addPaneToWorkspace,
  createDefaultWorkspaceState,
  moveTabBetweenPanes,
  removePaneFromWorkspace,
  resizePaneRatio,
  setActivePane,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
} from './workspace-model';

type TestTab = { id: string; label: string } & WorkspaceTab;

function buildTab(id: string, label: string): TestTab {
  return { id, label };
}

function buildPane(id: string, ...tabs: TestTab[]): WorkspacePane<TestTab> {
  return {
    id,
    size: 1,
    tabs,
    activeTabId: tabs[0]?.id || '',
  };
}

function buildState(...panes: WorkspacePane<TestTab>[]): WorkspaceState<TestTab> {
  return {
    panes,
    activePaneId: panes[0]?.id || '',
  };
}

describe('workspace-model pane actions', () => {
  it('setActivePane is a no-op when paneId already active', () => {
    const state = buildState(
      buildPane('p1', buildTab('t1', 'A')),
      buildPane('p2', buildTab('t2', 'B')),
    );
    const next = setActivePane(state, 'p1');
    expect(next).toBe(state);
  });

  it('setActivePane rejects unknown paneId', () => {
    const state = buildState(buildPane('p1', buildTab('t1', 'A')));
    const next = setActivePane(state, 'p-missing');
    expect(next).toBe(state);
  });

  it('setActivePane switches activePaneId', () => {
    const state = buildState(
      buildPane('p1', buildTab('t1', 'A')),
      buildPane('p2', buildTab('t2', 'B')),
    );
    const next = setActivePane(state, 'p2');
    expect(next.activePaneId).toBe('p2');
  });

  it('resizePaneRatio keeps total size bounded between 0.1 and 0.9', () => {
    const state = buildState(
      buildPane('p1', buildTab('t1', 'A')),
      buildPane('p2', buildTab('t2', 'B')),
    );
    const next = resizePaneRatio(state, 'p1', 'p2', 0.99);
    const p1 = next.panes.find((p) => p.id === 'p1')!;
    const p2 = next.panes.find((p) => p.id === 'p2')!;
    expect(p1.size).toBeLessThanOrEqual(0.9);
    expect(p2.size).toBeGreaterThanOrEqual(0.1);
  });

  it('resizePaneRatio rejects self-pair', () => {
    const state = buildState(buildPane('p1', buildTab('t1', 'A')));
    const next = resizePaneRatio(state, 'p1', 'p1', 0.5);
    expect(next).toBe(state);
  });

  it('addPaneToWorkspace respects MAX_WORKSPACE_PANES cap of 4', () => {
    let state = createDefaultWorkspaceState<TestTab>(buildTab('t1', 'A'));
    for (let i = 0; i < 5; i++) {
      const newPane = buildPane(`p${i + 2}`, buildTab(`t${i + 2}`, `T${i + 2}`));
      state = addPaneToWorkspace(state, newPane);
    }
    expect(state.panes.length).toBeLessThanOrEqual(4);
  });

  it('removePaneFromWorkspace refuses to drop the last pane', () => {
    const state = createDefaultWorkspaceState<TestTab>(buildTab('t1', 'A'));
    const next = removePaneFromWorkspace(state, state.panes[0].id);
    expect(next.panes.length).toBe(1);
  });

  it('moveTabBetweenPanes moves the tab and promotes target pane', () => {
    const state = buildState(
      buildPane('p1', buildTab('t1', 'A'), buildTab('t2', 'B')),
      buildPane('p2', buildTab('t3', 'C')),
    );
    const next = moveTabBetweenPanes(state, 'p1', 't2', 'p2');
    const p1 = next.panes.find((p) => p.id === 'p1')!;
    const p2 = next.panes.find((p) => p.id === 'p2')!;
    expect(p1.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(p2.tabs.map((t) => t.id)).toEqual(['t3', 't2']);
    expect(p2.activeTabId).toBe('t2');
    expect(next.activePaneId).toBe('p2');
  });
});

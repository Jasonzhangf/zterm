import { describe, expect, it } from 'vitest';
import {
  distributeEvenPaneSizes,
  normalizePaneSizes,
  type WorkspacePane,
} from './workspace-model';

type TestTab = { id: string };

function pane(id: string, size: number): WorkspacePane<TestTab> {
  return {
    id,
    size,
    tabs: [{ id: `tab-${id}` }],
    activeTabId: `tab-${id}`,
  };
}

describe('workspace-model', () => {
  it('normalizes pane sizes by preserving ratios', () => {
    const result = normalizePaneSizes([
      pane('p1', 1),
      pane('p2', 2),
      pane('p3', 1),
    ]);
    expect(result.map((item) => item.size)).toEqual([0.25, 0.5, 0.25]);
  });

  it('redistributes pane sizes evenly after pane-count changes', () => {
    const result = distributeEvenPaneSizes([
      pane('p1', 0.125),
      pane('p2', 0.125),
      pane('p3', 0.25),
      pane('p4', 0.5),
    ]);
    expect(result.map((item) => item.size)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

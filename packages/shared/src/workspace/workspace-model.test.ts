import { describe, expect, it } from 'vitest';
import {
  distributeEvenPaneSizes,
  normalizePaneSizes,
  resolveStaticPaneLayout,
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

  it('keeps static landscape split capacity when only IME-like height shrinks', () => {
    const initial = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 900,
      minAspect: 0.22,
      hardCap: 4,
      paneCount: 4,
    });
    const shrunk = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 620,
      minAspect: 0.22,
      hardCap: 4,
      paneCount: 4,
      previousLayout: initial,
    });

    expect(initial.maxSplitCount).toBe(4);
    expect(shrunk.maxSplitCount).toBe(4);
    expect(shrunk.baselineHeightPx).toBe(900);
    expect(shrunk.orientation).toBe('landscape');
  });

  it('recomputes baseline height only when orientation truth changes', () => {
    const landscape = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 900,
      minAspect: 0.22,
      hardCap: 4,
      paneCount: 4,
    });
    const portrait = resolveStaticPaneLayout({
      viewportWidth: 700,
      viewportHeight: 1200,
      minAspect: 0.22,
      hardCap: 4,
      paneCount: 1,
      previousLayout: landscape,
    });

    expect(portrait.orientation).toBe('portrait');
    expect(portrait.baselineHeightPx).toBe(1200);
  });
});

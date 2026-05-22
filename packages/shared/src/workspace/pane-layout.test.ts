import { describe, expect, it } from 'vitest';
import { resolveStaticPaneLayout } from './workspace-model';

describe('pane-layout static split truth', () => {
  it('keeps two-pane landscape capacity stable across IME-like height changes', () => {
    const initial = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 900,
      hardCap: 4,
      minAspect: 0.5,
      paneCount: 2,
    });
    const imeLift = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 620,
      hardCap: 4,
      minAspect: 0.5,
      paneCount: 2,
      previousLayout: initial,
    });

    expect(initial.maxSplitCount).toBe(2);
    expect(imeLift.maxSplitCount).toBe(2);
    expect(imeLift.paneRatios).toEqual([0.5, 0.5]);
  });

  it('resets baseline only when orientation changes', () => {
    const landscape = resolveStaticPaneLayout({
      viewportWidth: 1200,
      viewportHeight: 900,
      hardCap: 4,
      minAspect: 0.5,
      paneCount: 2,
    });
    const portrait = resolveStaticPaneLayout({
      viewportWidth: 700,
      viewportHeight: 1200,
      hardCap: 4,
      minAspect: 0.5,
      paneCount: 1,
      previousLayout: landscape,
    });

    expect(landscape.orientation).toBe('landscape');
    expect(portrait.orientation).toBe('portrait');
    expect(portrait.baselineHeightPx).toBe(1200);
  });

  it('keeps pane ratios aligned with explicit pane count truth within the aspect cap', () => {
    const threePane = resolveStaticPaneLayout({
      viewportWidth: 1800,
      viewportHeight: 900,
      hardCap: 4,
      minAspect: 0.5,
      paneCount: 3,
    });

    expect(threePane.paneRatios).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

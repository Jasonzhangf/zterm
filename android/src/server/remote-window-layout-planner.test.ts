import { describe, expect, it } from 'vitest';
import {
  planRemoteWindowFocusPlusRailLayout,
  type RemoteWindowLayoutPlannerEntry,
} from './remote-window-layout-planner';

function entry(id: string, w: number, h: number): RemoteWindowLayoutPlannerEntry {
  return {
    windowId: id,
    sourceRectTopLeftPx: { x: 0, y: 0, width: w, height: h },
  };
}

describe('planRemoteWindowFocusPlusRailLayout', () => {
  it('places focus in the main area and siblings in the rail (portrait)', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'focus',
      entries: [entry('focus', 800, 600), entry('s1', 400, 300), entry('s2', 500, 400)],
      layoutGeneration: 1,
      orientation: 'portrait',
    });
    const focus = layout.windows.find((w) => w.windowId === 'focus');
    const s1 = layout.windows.find((w) => w.windowId === 's1');
    const s2 = layout.windows.find((w) => w.windowId === 's2');
    expect(focus).toBeDefined();
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();

    // Rail is top 30% of 1080 = 324
    expect(s1!.canvasRectPx.y + s1!.canvasRectPx.height).toBeLessThanOrEqual(324);
    expect(s2!.canvasRectPx.y + s2!.canvasRectPx.height).toBeLessThanOrEqual(324);
    // Focus starts below rail
    expect(focus!.canvasRectPx.y).toBeGreaterThanOrEqual(324);
    // Focus has higher z-index than siblings
    expect(focus!.zIndex).toBeGreaterThan(s1!.zIndex);
    expect(focus!.zIndex).toBeGreaterThan(s2!.zIndex);
  });

  it('places rail on the left in landscape orientation', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'focus',
      entries: [entry('focus', 800, 600), entry('s1', 400, 300)],
      layoutGeneration: 2,
      orientation: 'landscape',
    });
    const focus = layout.windows.find((w) => w.windowId === 'focus')!;
    const s1 = layout.windows.find((w) => w.windowId === 's1')!;
    // Rail is left 30% of 1920 = 576
    expect(s1.canvasRectPx.x + s1.canvasRectPx.width).toBeLessThanOrEqual(576);
    expect(focus.canvasRectPx.x).toBeGreaterThanOrEqual(576);
  });

  it('caps rail at maxRailWindows (default 3)', () => {
    const entries = [
      entry('focus', 800, 600),
      entry('s1', 100, 100),
      entry('s2', 100, 100),
      entry('s3', 100, 100),
      entry('s4', 100, 100),
      entry('s5', 100, 100),
    ];
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'focus',
      entries,
      layoutGeneration: 3,
    });
    expect(layout.windows.length).toBe(4); // 3 rail + 1 focus
  });

  it('deduplicates window ids keeping first occurrence', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'focus',
      entries: [entry('focus', 800, 600), entry('s1', 100, 100), entry('s1', 200, 200)],
      layoutGeneration: 4,
    });
    expect(layout.windows.filter((w) => w.windowId === 's1')).toHaveLength(1);
  });

  it('falls back to first entry as focus when focusTargetId not found', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'nonexistent',
      entries: [entry('a', 800, 600), entry('b', 400, 300)],
      layoutGeneration: 5,
    });
    expect(layout.focusTargetId).toBe('a');
  });

  it('throws for invalid generation', () => {
    expect(() => planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'f',
      entries: [entry('f', 100, 100)],
      layoutGeneration: 0,
    })).toThrow('layout generation must be a positive safe integer');
  });

  it('throws for empty entries', () => {
    expect(() => planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'f',
      entries: [],
      layoutGeneration: 1,
    })).toThrow('at least one window entry is required');
  });

  it('single entry produces focus-only layout without rail', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'only',
      entries: [entry('only', 800, 600)],
      layoutGeneration: 6,
    });
    expect(layout.windows).toHaveLength(1);
    expect(layout.windows[0].windowId).toBe('only');
    // Focus takes the full area below the (empty) rail
    expect(layout.windows[0].canvasRectPx.y).toBeGreaterThanOrEqual(Math.round(1080 * 0.3));
  });

  it('maintains aspect ratio within allocated bounds', () => {
    const layout = planRemoteWindowFocusPlusRailLayout({
      focusTargetId: 'wide',
      entries: [entry('wide', 1600, 400)],
      layoutGeneration: 7,
      orientation: 'landscape',
    });
    const w = layout.windows[0];
    const ratio = w.canvasRectPx.width / w.canvasRectPx.height;
    expect(ratio).toBeCloseTo(4.0, 0);
  });
});

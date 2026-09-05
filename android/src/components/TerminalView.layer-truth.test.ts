/**
 * Layer-separation truth gate (red test):
 * TerminalView (renderer) must NOT hold gesture state machines, pinch shims,
 * or persistence. useMirrorFixedZoomPan (DOM renderer visual gesture layer,
 * client.dom_renderer) is the
 * single owner of wheel/pan/pinch gesture state and the horizontal offset truth.
 *
 * Gate doc: docs/audits/2026-08-13-terminal-render-layer-decoupling.md §8.3
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readSource(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const RENDERER_FORBIDDEN = [
  'localStorage',
  'twoFingerWheelRef',
  'handleTwoFingerWheelTouch',
  'handleMirrorFixedTouch',
  'applyPinchScale',
  'computeNextPinchScale',
  'pinchRef',
  'mirrorFixedScaleRef',
  'mirrorFixedHorizontalOffsetRef',
  'commitMirrorFixedHorizontalOffset',
  'readStoredHorizontalOffset',
  'writeStoredHorizontalOffset',
  'HORIZONTAL_PAN_LOCK_PX',
  'MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY',
];

const SHELL_FORBIDDEN = [
  'renderBottomIndex',
  'viewportRows',
  'setViewportRows',
  'rowHeightPx',
  'followScrollStateRef',
];

describe('TerminalView renderer / UI shell layer separation', () => {
  it('keeps gesture state machines and persistence out of the renderer (TerminalView.tsx)', () => {
    const source = readSource('src/components/TerminalView.tsx');
    const leaks = RENDERER_FORBIDDEN.filter((symbol) => source.includes(symbol));
    expect(leaks, 
      `renderer leaked UI-shell gesture/persistence symbols:\n${leaks.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps renderer truth out of the visual gesture hook (useMirrorFixedZoomPan.ts)', () => {
    const source = readSource('src/components/useMirrorFixedZoomPan.ts');
    const leaks = SHELL_FORBIDDEN.filter((symbol) => source.includes(symbol));
    expect(leaks,
      `UI shell leaked renderer truth symbols:\n${leaks.join('\n')}`,
    ).toEqual([]);
    // The hook owns the gesture/scale state and native-scroll handoff. The
    // canvas zoom itself is projected declaratively by TerminalView's
    // `.term-render-scale-layer`; row mapping and visible-row demand stay in
    // TerminalView.
    expect(source).toContain('scaleLayerRef');
    expect(source).toContain('visualScale');
    expect(source).toContain('restoreScrollTop');
  });

  it('makes the visual gesture hook the single gesture owner (wheel + offset truth)', () => {
    const source = readSource('src/components/useMirrorFixedZoomPan.ts');
    expect(source).toContain('decideTwoFingerWheel');
    expect(source).toContain('onWheelStep');
    expect(source).toContain('horizontalOffsetPx');
    expect(source).toContain('maxHorizontalOffsetPx');
    expect(source).toContain('readStoredHorizontalOffset');
    expect(source).toContain('writeStoredHorizontalOffset');
  });

  it('owns mirror-fixed pan persistence in the storage lib (terminal-mirror-fixed-pan-storage.ts)', () => {
    const source = readSource('src/lib/terminal-mirror-fixed-pan-storage.ts');
    expect(source).toContain('MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY');
    expect(source).toContain('readStoredHorizontalOffset');
    expect(source).toContain('writeStoredHorizontalOffset');
  });

  it('keeps the SGR wheel adapter in the renderer projection boundary only (no state machine)', () => {
    const source = readSource('src/components/TerminalView.tsx');
    expect(source).toContain('encodeTerminalSgrMouseWheel');
    expect(source).toContain('onWheelStep');
    // 状态机不得留在 renderer：只能有坐标映射 adapter，不能有累积 delta 判定
    expect(source).not.toContain('accumulatedDeltaPx');
    expect(source).not.toContain('decideTwoFingerWheel');
  });

  it('keeps renderer-window state owned by useTerminalRendererWindow', () => {
    const viewSource = readSource('src/components/TerminalView.tsx');
    const windowSource = readSource('src/lib/use-terminal-renderer-window.ts');

    expect(viewSource).not.toMatch(
      /useState\s*\(\s*(?:options\.)?initialRenderBottomIndex/,
    );
    expect(viewSource).not.toMatch(/useState\s*\(\s*false\s*\).*readingMode/);
    expect(viewSource).not.toContain('createTerminalFollowScrollState');
    expect(viewSource).not.toContain('followScrollStateRef');
    expect(viewSource).not.toContain('setRenderBottomIndex');
    expect(viewSource).not.toContain('setFollowModeState');
    expect(viewSource).not.toContain('applyFollowScrollTransition');
    expect(windowSource).toContain('followScrollStateRef');
    expect(windowSource).toContain('renderBottomIndex');
    expect(windowSource).toContain('readingMode');
    expect(windowSource).toContain('applyTransition');
    expect(windowSource).toContain('resetToFollow');
    expect(windowSource).toContain('setRenderBottom');
  });
});

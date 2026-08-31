import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(androidRoot, relativePath), 'utf8');
}

describe('remote window touch action sop truth', () => {
  it('keeps the canonical gesture and thumbnail contract documented and gated', () => {
    const sop = read('docs/testing/remote-window-touch-action-sop.md');
    const featureGates = read('docs/feature-gates.md');
    const functionMap = read('docs/function-map.md');
    const resourceMap = read('docs/resource-map.md');
    const decision = read('docs/decisions/2026-08-30-remote-window-quality-gesture-control-amendment.md');

    expect(sop).toContain('Feature: `desktop.remote_window_stream`');
    expect(sop).toContain('Tap emits one remote left click at release at both 1x and zoomed scale.');
    expect(sop).toContain('pixel scroll at both 1x and zoomed scale; pointer-up emits no swipe replay.');
    expect(sop).toContain('A five-second gesture remains valid. Reliable pointer-up and cancel-release');
    expect(sop).toContain('Anti-parallel distance change is local pinch zoom.');
    expect(sop).toContain('The remote window never shrinks below fit and no');

    expect(featureGates).toContain('The fullscreen video surface must never advertise a minimap/viewport overlay or allow shrinking below fit once the remote target is fullscreen.');
    expect(featureGates).toContain('single-finger movement is realtime remote scroll at both 1x and zoomed scale');
    expect(functionMap).toContain('remote-window-gesture-arena');
    expect(resourceMap).toContain('fullscreen zoom/pan state');
    expect(resourceMap).toContain('screenshot intent');
    expect(resourceMap).toContain('realtime bounded pixel scroll at both 1x and zoomed scale');
    expect(decision).not.toContain('top-right minimap projects the current viewport');
    expect(decision).toContain('Zoomed pointer-down does not pre-commit local pan.');
    expect(decision).toContain('pointer-up and pointer-cancel both');
    expect(featureGates).not.toContain('zoomed fullscreen one-finger drag remains local pan');
    expect(resourceMap).not.toContain('actual user operations still obey the one-second stale/drop rule');
  });
});

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
    expect(sop).toContain('Tap emits one remote left click at release at 1x; zoomed tap is suppressed.');
    expect(sop).toContain('pixel scroll at 1x. At zoomed fullscreen scale one finger is a complete');
    expect(sop).toContain('At zoomed floating scale,');
    expect(sop).toContain('A five-second gesture remains valid. Reliable pointer-up and cancel-release');
    expect(sop).toContain('Anti-parallel distance change is local pinch zoom.');
    expect(sop).toContain('The remote window never shrinks below fit and no');

    expect(featureGates).toContain('The fullscreen video surface must never advertise a minimap/viewport overlay or allow shrinking below fit once the remote target is fullscreen.');
    expect(featureGates).toContain('single-finger movement is realtime remote scroll at 1x, zoomed fullscreen one finger is a complete no-op');
    expect(featureGates).toContain('two-finger same-direction motion is remote scroll at both 1x and zoomed scale');
    expect(functionMap).toContain('remote-window-gesture-arena');
    expect(resourceMap).toContain('fullscreen zoom/pan state');
    expect(resourceMap).toContain('screenshot intent');
    expect(resourceMap).toContain('At zoomed fullscreen scale, one finger is a complete no-op');
    expect(decision).not.toContain('top-right minimap projects the current viewport');
    expect(decision).toContain('Zoomed pointer-down starts local single-finger pan in floating and a suppressed');
    expect(decision).toContain('pointer-up and pointer-cancel both');
    expect(sop).toContain('Two-finger same-direction motion is realtime remote scroll at 1x and');
    expect(sop).toContain('Zoomed floating pointer-down starts local single-finger pan; zoomed');
    expect(featureGates).not.toContain('zoomed fullscreen one-finger drag remains local pan');
    expect(resourceMap).not.toContain('actual user operations still obey the one-second stale/drop rule');
  });
});

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
    const decision = read('docs/decisions/2026-07-19-remote-window-stream-truth.md');

    expect(sop).toContain('Feature: `desktop.remote_window_stream`');
    expect(sop).toContain('Tap/click emits one `click` action at release.');
    expect(sop).toContain('Pinch zoom is fullscreen-only, may only enlarge above fit, and must not create a minimap.');
    expect(sop).toContain('Each non-active child shows a screenshot thumbnail.');
    expect(sop).toContain('Stale queued real input older than 1 second must be dropped.');

    expect(featureGates).toContain('The fullscreen video surface must never advertise a minimap/viewport overlay or allow shrinking below fit once the remote target is fullscreen.');
    expect(functionMap).toContain('screenshot thumbnail');
    expect(functionMap).toContain('fullscreen aspect-fit drawing with default remote target resize fill request on fullscreen entry');
    expect(resourceMap).toContain('fullscreen zoom/pan state');
    expect(resourceMap).toContain('screenshot intent');
    expect(decision).not.toContain('top-right minimap projects the current viewport');
    expect(decision).toContain('there is no minimap/viewport overlay');
  });
});

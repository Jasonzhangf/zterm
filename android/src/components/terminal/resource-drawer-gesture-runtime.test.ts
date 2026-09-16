// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createResourceDrawerGestureRuntime,
  resolveResourceDrawerGestureEndAction,
  resolveResourceDrawerGestureContext,
  RESOURCE_DRAWER_GESTURE_SCOPE_IDS,
} from './resource-drawer-gesture-runtime';

describe('resource drawer gesture runtime', () => {
  afterEach(() => document.body.replaceChildren());

  it('accepts drag only from the shell handle and consumes content gestures', () => {
    document.body.innerHTML = '<section data-resource-drawer-page="drawer.shell" data-resource-drawer-scope="drawer-shell"><span data-resource-drawer-handle="true"></span><div data-resource-drawer-page="drawer.files" data-resource-drawer-scope="drawer-content-page"></div></section>';
    const handle = document.querySelector('[data-resource-drawer-handle]');
    const content = document.querySelector('[data-resource-drawer-page="drawer.files"]');
    const runtime = createResourceDrawerGestureRuntime();
    expect(runtime.start('handle', resolveResourceDrawerGestureContext(handle), 100)).toEqual({ kind: 'accepted' });
    expect(runtime.end('handle', 180)).toBe('close');
    expect(runtime.start('content', resolveResourceDrawerGestureContext(content), 100)).toEqual({ kind: 'consumed' });
    expect(runtime.end('content', 20)).toBe('none');
    expect(resolveResourceDrawerGestureEndAction(-65)).toBe('expand');
    expect(RESOURCE_DRAWER_GESTURE_SCOPE_IDS.drawerShell).toBe('drawer-shell');
  });
});

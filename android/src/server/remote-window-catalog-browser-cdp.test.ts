import { afterEach, describe, expect, it, vi } from 'vitest';
import { setChromeWindowUserAgent } from './remote-window-catalog';
import type { RemoteWindowStreamTargetManifest } from '@zterm/shared/protocol';

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'app-window:123:7',
  videoTarget: {
    kind: 'app-window', appBundleId: 'com.google.Chrome', ownerName: 'Google Chrome', pid: 123,
    windowId: '7', title: 'Docs', windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
  },
  inputTarget: { kind: 'app-window' }, streamMode: 'interactive', focusPolicy: 'bring-to-focus', inputRoute: 'os-event',
  capture: { source: 'ScreenCaptureKit', coordinateSpace: 'macos-top-left-px', scale: 1, createdAt: 'now' },
};

afterEach(() => { vi.restoreAllMocks(); });

describe('Chrome CDP browser control', () => {
  it('fails explicitly when the selected Chrome title is not uniquely mapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 'a', type: 'page', title: 'Other', webSocketDebuggerUrl: 'ws://a' },
      { id: 'b', type: 'page', title: 'Other', webSocketDebuggerUrl: 'ws://b' },
    ]), { status: 200 })));
    await expect(setChromeWindowUserAgent(target, 'mobile')).rejects.toThrow('did not match');
  });

  it('rejects non-Chrome app windows before contacting CDP', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(setChromeWindowUserAgent({ ...target, videoTarget: { ...target.videoTarget, appBundleId: 'com.example.Other' } }, 'desktop'))
      .rejects.toThrow('not a supported Chrome window');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

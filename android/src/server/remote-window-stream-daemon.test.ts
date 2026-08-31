import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamStartRequestV2Payload } from '@zterm/shared/protocol';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

vi.mock('@roamhq/wrtc', () => ({ default: { RTCPeerConnection: class {}, RTCSessionDescription: class {}, RTCIceCandidate: class {}, nonstandard: {} } }));

const target = () => ({ streamTargetId: 'app-window:app:window', videoTarget: { kind: 'app-window' as const, appBundleId: 'com.example.app', pid: 42, windowId: 'window', title: 'Example', windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 }, cropRectTopLeftPx: { x: 0, y: 0, width: 800, height: 600 } }, inputTarget: { kind: 'app-window' as const }, streamMode: 'interactive' as const, focusPolicy: 'no-focus-steal' as const, inputRoute: 'os-event' as const, capture: { source: 'ScreenCaptureKit' as const, coordinateSpace: 'macos-top-left-px' as const, scale: 1, createdAt: new Date().toISOString() } });
const profile = () => makeRemoteWindowVideoProfileFixture('smooth');
const start = (streamId: string): RemoteWindowStreamStartRequestV2Payload => ({ requestId: `${streamId}-request`, streamId, mediaPlan: 'single-focus', mediaPlanVersion: 2, target: target(), videoProfile: profile() });

describe('remote window stream daemon v2 contract', () => {
  it('uses the v2 typed start contract', () => {
    expect(start('typed-v2').mediaPlanVersion).toBe(2);
  });
});

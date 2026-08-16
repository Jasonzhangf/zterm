import { describe, expect, it } from 'vitest';
import {
  acceptRemoteWindowFocusReady,
  beginRemoteWindowDualStreamSwitch,
  commitRemoteWindowFocusProjection,
  resetRemoteWindowDualStreamSwitch,
  showRemoteWindowOverviewCrop,
  type RemoteWindowDualStreamState,
} from './remote-window-dual-stream-runtime';

describe('remote-window dual stream switch', () => {
  it('shows the overview crop before committing a matching focus first frame', () => {
    const initial: RemoteWindowDualStreamState = {
      phase: 'idle',
      revision: 0,
      activeTargetId: 'window-a',
      pendingTargetId: null,
      focusStreamId: 'focus-stream',
      overviewCropTargetId: null,
      error: null,
    };

    const requested = beginRemoteWindowDualStreamSwitch(initial, 'window-b');
    expect(requested.phase).toBe('switch-requested');
    expect(requested.revision).toBe(1);

    const cropped = showRemoteWindowOverviewCrop(requested, 'window-b');
    expect(cropped.phase).toBe('overview-crop-visible');
    expect(cropped.overviewCropTargetId).toBe('window-b');

    const ready = acceptRemoteWindowFocusReady(cropped, {
      revision: 1,
      targetId: 'window-b',
      streamId: 'focus-stream',
    });
    expect(ready.phase).toBe('focus-ready');
    expect(commitRemoteWindowFocusProjection(ready).phase).toBe('focus-committed');
  });

  it('rejects a stale focus result and leaves the overview projection active', () => {
    const requested = beginRemoteWindowDualStreamSwitch({
      phase: 'overview-crop-visible',
      revision: 2,
      activeTargetId: 'window-a',
      pendingTargetId: 'window-b',
      focusStreamId: 'focus-stream',
      overviewCropTargetId: 'window-b',
      error: null,
    }, 'window-c');

    const cropped = showRemoteWindowOverviewCrop(requested, 'window-c');
    const stale = acceptRemoteWindowFocusReady(cropped, {
      revision: 2,
      targetId: 'window-b',
      streamId: 'focus-stream',
    });
    expect(stale.phase).toBe('overview-crop-visible');
    expect(stale.activeTargetId).toBe('window-a');
    expect(stale.error?.code).toBe('stale-focus-result');
  });

  it('keeps wire target identity separate from the overview crop window identity', () => {
    const requested = beginRemoteWindowDualStreamSwitch({
      phase: 'focus-committed',
      revision: 0,
      activeTargetId: 'app-window:1:10',
      pendingTargetId: null,
      focusStreamId: 'focus-stream',
      overviewCropTargetId: null,
      error: null,
    }, 'app-window:1:11');

    const cropped = showRemoteWindowOverviewCrop(
      requested,
      'app-window:1:11',
      '11',
    );

    expect(cropped.pendingTargetId).toBe('app-window:1:11');
    expect(cropped.overviewCropTargetId).toBe('11');
  });

  it('resets an in-flight switch back to focus-committed (timeout fallback)', () => {
    const stuck: RemoteWindowDualStreamState = {
      phase: 'overview-crop-visible',
      revision: 3,
      activeTargetId: 'window-a',
      pendingTargetId: 'window-b',
      focusStreamId: 'focus-stream',
      overviewCropTargetId: 'window-b',
      error: null,
    };

    const reset = resetRemoteWindowDualStreamSwitch(stuck);

    expect(reset.phase).toBe('focus-committed');
    expect(reset.activeTargetId).toBe('window-a');
    expect(reset.pendingTargetId).toBeNull();
    expect(reset.overviewCropTargetId).toBeNull();
  });

  it('keeps an idle switch untouched by reset (nothing in flight)', () => {
    const idle: RemoteWindowDualStreamState = {
      phase: 'idle',
      revision: 0,
      activeTargetId: null,
      pendingTargetId: null,
      focusStreamId: null,
      overviewCropTargetId: null,
      error: null,
    };

    expect(resetRemoteWindowDualStreamSwitch(idle).phase).toBe('idle');
  });
});

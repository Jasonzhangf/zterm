// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildScreenCaptureKitStartupTimeoutMessage } from './remote-window-support';

describe('buildScreenCaptureKitStartupTimeoutMessage', () => {
  it('names the started-but-zero-frame case instead of a generic timeout', () => {
    // Live evidence: on the Air the child printed only
    // "zterm remote window capture started (SCStream): 1 windows" and then no
    // frame arrived. The generic message made that look like an absent stream.
    const message = buildScreenCaptureKitStartupTimeoutMessage(
      'zterm remote window capture started (SCStream): 1 windows\n',
      20_000,
    );
    expect(message).toContain('did not produce a frame before timeout after 20000ms while the SCStream was running');
    expect(message).toContain('started (SCStream): 1 windows');
  });

  it('keeps the plain form when the child never started a stream', () => {
    expect(buildScreenCaptureKitStartupTimeoutMessage('', 20_000))
      .toBe('ScreenCaptureKit capture did not produce a frame before timeout after 20000ms');
    expect(buildScreenCaptureKitStartupTimeoutMessage('Unable to find window\n', 20_000))
      .toContain('after 20000ms: Unable to find window');
  });
});

import { describe, expect, it } from 'vitest';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';

describe('resolveRemoteScreenshotErrorMessage', () => {
  it('maps helper unavailable to explicit helper runtime error', () => {
    const message = resolveRemoteScreenshotErrorMessage(new Error('remote screenshot helper not running'), 15000);

    expect(message).toBe('remote screenshot helper 未运行，请先启动 Mac 端截图 helper');
  });

  it('maps helper capture display failure to helper-side screenshot error', () => {
    const message = resolveRemoteScreenshotErrorMessage(
      new Error('Command failed: screencapture -x /tmp/a.png\ncould not create image from display\n'),
      15000,
    );

    expect(message).toBe('截图 helper 当前无法从显示器创建图像');
  });

  it('keeps timeout errors explicit', () => {
    const message = resolveRemoteScreenshotErrorMessage({ killed: true }, 15000);
    expect(message).toBe('remote screenshot timed out after 15000ms');
  });
});

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

  it('maps helper screen capture permission failure to explicit system settings guidance', () => {
    const message = resolveRemoteScreenshotErrorMessage(
      new Error('screen capture permission denied: Command failed: screencapture -x /tmp/a.png\ncould not create image from display\n'),
      15000,
    );

    expect(message).toBe('截图 helper 缺少系统截图权限，请在 Mac 系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制 中允许 ZTerm');
  });

  it('keeps timeout errors explicit', () => {
    const message = resolveRemoteScreenshotErrorMessage({ killed: true }, 15000);
    expect(message).toBe('remote screenshot timed out after 15000ms');
  });
});

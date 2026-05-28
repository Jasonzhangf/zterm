import { describe, expect, it } from 'vitest';
import { resolveRemoteScreenshotErrorMessage } from './remote-screenshot';

describe('resolveRemoteScreenshotErrorMessage', () => {
  it('maps capture unavailable to explicit daemon runtime error', () => {
    const message = resolveRemoteScreenshotErrorMessage(new Error('daemon screenshot capture unavailable'), 15000);

    expect(message).toBe('zterm-daemon 截图能力不可用，请重新运行 zterm-daemon install-service 并完成截图权限授权');
  });

  it('maps daemon capture display failure to daemon-side screenshot error', () => {
    const message = resolveRemoteScreenshotErrorMessage(
      new Error('Command failed: screencapture -x /tmp/a.png\ncould not create image from display\n'),
      15000,
    );

    expect(message).toBe('zterm-daemon 当前无法从显示器创建截图');
  });

  it('maps daemon screen capture permission failure to explicit system settings guidance', () => {
    const message = resolveRemoteScreenshotErrorMessage(
      new Error('screen capture permission denied: Command failed: screencapture -x /tmp/a.png\ncould not create image from display\n'),
      15000,
    );

    expect(message).toBe('zterm-daemon 缺少系统截图权限，请在 Mac 系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制 中允许 zterm-daemon，然后重新运行 zterm-daemon install-service');
  });

  it('keeps timeout errors explicit', () => {
    const message = resolveRemoteScreenshotErrorMessage({ killed: true }, 15000);
    expect(message).toBe('remote screenshot timed out after 15000ms');
  });
});

const DAEMON_CAPTURE_UNAVAILABLE_PATTERN = /daemon screenshot capture unavailable/i;
const NO_DISPLAY_PATTERN = /could not create image from display/i;
const PERMISSION_PATTERN = /(not permitted|operation not permitted|screen recording|screen capture permission (restricted|denied|not-determined))/i;

export function resolveRemoteScreenshotErrorMessage(error: unknown, timeoutMs: number) {
  if (error && typeof error === 'object' && 'killed' in error && (error as { killed?: boolean }).killed) {
    return `remote screenshot timed out after ${timeoutMs}ms`;
  }

  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error || 'remote screenshot failed');

  if (DAEMON_CAPTURE_UNAVAILABLE_PATTERN.test(rawMessage)) {
    return 'zterm-daemon 截图能力不可用，请重新运行 zterm-daemon install-service 并完成截图权限授权';
  }

  if (PERMISSION_PATTERN.test(rawMessage)) {
    return 'zterm-daemon 缺少系统截图权限，请在 Mac 系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制 中允许 zterm-daemon，然后重新运行 zterm-daemon install-service';
  }

  if (NO_DISPLAY_PATTERN.test(rawMessage)) {
    return 'zterm-daemon 当前无法从显示器创建截图';
  }

  return rawMessage || 'remote screenshot failed';
}

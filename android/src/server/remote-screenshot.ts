const HELPER_UNAVAILABLE_PATTERN = /remote screenshot helper not running/i;
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

  if (HELPER_UNAVAILABLE_PATTERN.test(rawMessage)) {
    return 'remote screenshot helper 未运行，请先启动 Mac 端截图 helper';
  }

  if (PERMISSION_PATTERN.test(rawMessage)) {
    return '截图 helper 缺少系统截图权限，请在 Mac 系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制 中允许 ZTerm';
  }

  if (NO_DISPLAY_PATTERN.test(rawMessage)) {
    return '截图 helper 当前无法从显示器创建图像';
  }

  return rawMessage || 'remote screenshot failed';
}

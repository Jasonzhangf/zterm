/**
 * AttachmentDrawer 纯 helper 子模块（client.file_browser）。
 * 从 AttachmentDrawer.tsx 拆出：blob->base64 / pan clamp / 相对时间 / 文件大小格式化。
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function clampPanForScale(pan: { x: number; y: number }, scale: number): { x: number; y: number } {
  if (scale <= MIN_ZOOM) return { x: 0, y: 0 };
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 360;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 640;
  const maxX = Math.max(0, (0.9 * viewportW * (scale - 1)) / 2);
  const maxY = Math.max(0, (0.85 * viewportH * (scale - 1)) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

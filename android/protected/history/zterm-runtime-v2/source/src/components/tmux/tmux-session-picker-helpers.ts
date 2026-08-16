/**
 * TmuxSessionPickerSheet 纯 helper 子模块（client.connection_home）。
 * 从 TmuxSessionPickerSheet.tsx 拆出：刷新时间格式化 / relay target 判定 / 二维码解码。
 */
import jsQR from 'jsqr';
import type { BridgeTarget } from '../../lib/session-picker';

export function formatRefreshAge(ts?: number | null) {
  if (!ts) {
    return '未刷新';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function formatRefreshClock(ts?: number | null) {
  if (!ts) {
    return '--:--:--';
  }
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function getTargetRelayHostId(target: Pick<BridgeTarget, 'relayHostId' | 'daemonHostId'>) {
  return target.relayHostId?.trim() || target.daemonHostId?.trim() || '';
}

export function hasRelayRtcEndpointCandidate(target: Pick<BridgeTarget, 'relayEndpointCandidates'>) {
  return (target.relayEndpointCandidates || []).some((candidate) => (
    candidate.kind === 'relay-rtc'
    && candidate.relayHostId?.trim()
  ));
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('读取二维码图片失败'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('二维码图片无法解码'));
    image.src = src;
  });
}

export async function decodeQrImageFile(file: File) {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    throw new Error('二维码图片尺寸无效');
  }
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('当前 WebView 不支持二维码图片解析');
  }
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const qr = jsQR(imageData.data, imageData.width, imageData.height);
  if (!qr?.data) {
    throw new Error('没有在图片中识别到 zterm 配置二维码');
  }
  return qr.data;
}



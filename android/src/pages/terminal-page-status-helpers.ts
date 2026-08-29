/**
 * TerminalPage 连接状态纯 helper（client.app_shell）。
 * 从 TerminalPage.tsx 拆出的子模块；唯一消费方：TerminalPage + TerminalConnectionStatusStrip。
 */
import { isPrivateLanIpv4Host, parseEndpointHost } from '../lib/network-target';
import { resolveDebugStatus } from './terminal-page-debug-helpers';
import type { Session, SessionDebugOverlayMetrics } from '../lib/types';

export function hasLiveSessionTraffic(
  metrics: SessionDebugOverlayMetrics | null | undefined,
) {
  if (!metrics?.active) {
    return false;
  }
  return (metrics.uplinkBps || 0) > 0 || (metrics.downlinkBps || 0) > 0;
}

export function resolveConnectionActivityLabel(
  session: Session,
  status: SessionDebugOverlayMetrics['status'],
) {
  if (
    session.lastError === 'waiting for confirmed control directory'
    || session.lastError === 'control directory confirmation timeout'
  ) {
    return '正在同步控制通道';
  }
  if (status === 'reconnecting') {
    return '正在重连';
  }
  if (status === 'connecting') {
    return '正在连接';
  }
  return null;
}

export function resolveEffectiveConnectionStatus(
  session: Session,
  metrics: SessionDebugOverlayMetrics | null | undefined,
) {
  const status = resolveDebugStatus(session, metrics || undefined);
  if ((status === 'reconnecting' || status === 'connecting') && hasLiveSessionTraffic(metrics)) {
    return 'waiting';
  }
  return status;
}
export function formatConnectionRouteLabel(session: Session) {
  switch (session.resolvedPath) {
    case 'rtc-direct':
      return 'UDP';
    case 'tailscale':
      return 'Tailscale';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4': {
      const endpointHost = parseEndpointHost(
        session.resolvedEndpoint || session.bridgeHost,
      );
      return isPrivateLanIpv4Host(endpointHost) ? '局域网' : 'IPv4';
    }
    case 'rtc-relay':
      return session.resolvedRelayTransport === 'turn' ? 'Relay/TURN' : 'Relay';
    default:
      return session.state === 'connected' ? '连接中' : '未连接';
  }
}

export function formatTerminalBackendSuffix(backend?: Session['terminalBackend']) {
  return backend === 'herdr' ? ' (herdr)' : '';
}

export interface TerminalQuickBarCapabilityProjection {
  fileTransferSupported: boolean;
  imagePasteSupported: boolean;
  remoteScreenshotSupported: boolean;
}

export function resolveTerminalQuickBarCapabilityProjection(
  _backend: Session['terminalBackend'] | undefined,
  _remoteWindowInputActive: boolean,
): TerminalQuickBarCapabilityProjection {
  return {
    fileTransferSupported: true,
    imagePasteSupported: true,
    remoteScreenshotSupported: true,
  };
}

export const TERMINAL_PORTRAIT_STATUS_STRIP_TOP_OFFSET_PX = 8;
export const TERMINAL_PORTRAIT_STAGE_TOP_OFFSET_PX = 50;

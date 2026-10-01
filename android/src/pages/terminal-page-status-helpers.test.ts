import { describe, expect, it } from 'vitest';
import {
  formatConnectionRouteLabel,
  resolveConnectionActivityLabel,
  resolveEffectiveConnectionStatus,
  resolveTerminalQuickBarCapabilityProjection,
} from './terminal-page-status-helpers';

type TestSession = Parameters<typeof formatConnectionRouteLabel>[0];

function makeStatusSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    id: 'session-status-fallback',
    hostId: 'host-status-fallback',
    connectionName: 'zterm',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    state: 'connected',
    sessionName: 'zterm-2',
    title: 'zterm-2',
    hasUnread: false,
    createdAt: 0,
    ws: null,
    terminalBackend: 'tmux',
    ...overrides,
  };
}

function makeConnectingMetrics() {
  return {
    uplinkBps: 0,
    downlinkBps: 1,
    renderHz: 0,
    pullHz: 0,
    transportBufferedBytes: 0,
    transportBackpressured: false,
    lastRenderCommitAt: 0,
    bufferPullActive: true,
    status: 'connecting' as const,
    active: true,
    updatedAt: 0,
  };
}

describe('formatConnectionRouteLabel', () => {
  it('labels a connected fallback route as connected, not connecting', () => {
    expect(formatConnectionRouteLabel(makeStatusSession())).toBe('已连接');
  });

  it('labels a non-connected fallback route as disconnected', () => {
    expect(formatConnectionRouteLabel(makeStatusSession({ state: 'connecting' }))).toBe('未连接');
  });
});

describe('resolveEffectiveConnectionStatus', () => {
  it('keeps connected session truth authoritative even when metrics are stale', () => {
    const status = resolveEffectiveConnectionStatus(
      makeStatusSession(),
      makeConnectingMetrics(),
    );

    expect(status).toBe('connected');
    expect(resolveConnectionActivityLabel(makeStatusSession(), status)).toBeNull();
  });

  it('does not show control-directory activity when session truth is connected', () => {
    const session = makeStatusSession({
      lastError: 'waiting for confirmed control directory',
    });
    const status = resolveEffectiveConnectionStatus(session, makeConnectingMetrics());

    expect(status).toBe('connected');
    expect(resolveConnectionActivityLabel(session, status)).toBeNull();
  });

  it('never promotes byte-rate traffic to connected while the session is still connecting', () => {
    const session = makeStatusSession({ state: 'connecting' });
    const status = resolveEffectiveConnectionStatus(
      session,
      makeConnectingMetrics(),
    );

    expect(status).toBe('connecting');
    expect(resolveConnectionActivityLabel(session, status)).toBe('正在连接');
  });

  it('never promotes pong-only downlink traffic to connected while reconnecting', () => {
    const session = makeStatusSession({ state: 'reconnecting' });
    const status = resolveEffectiveConnectionStatus(
      session,
      { ...makeConnectingMetrics(), status: 'reconnecting' as const },
    );

    expect(status).toBe('reconnecting');
    expect(resolveConnectionActivityLabel(session, status)).toBe('正在重连');
  });

  it('never promotes a waiting session from raw byte rates', () => {
    const session = makeStatusSession({ state: 'connecting' });
    const status = resolveEffectiveConnectionStatus(
      session,
      { ...makeConnectingMetrics(), status: 'waiting' as const },
    );

    expect(status).toBe('waiting');
    expect(resolveConnectionActivityLabel(session, status)).toBeNull();
  });
});

describe('resolveTerminalQuickBarCapabilityProjection', () => {
  it('keeps tmux file, image paste, and remote screenshot capabilities enabled', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('tmux', false)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });

  it('keeps file, image, and remote screenshot actions enabled for every session', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', false)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });

  it('does not gate image actions on backend or remote-window input', () => {
    expect(resolveTerminalQuickBarCapabilityProjection('herdr', true)).toEqual({
      fileTransferSupported: true,
      imagePasteSupported: true,
      remoteScreenshotSupported: true,
    });
  });
});

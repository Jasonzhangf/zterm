// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NETWORK_BANNER_ACTIONABLE_RECONNECT_ATTEMPT,
  NETWORK_BANNER_GRACE_MS,
  TerminalNetworkBanner,
  resolveConnectionIssueActionable,
  resolveConnectionIssueActionableKey,
} from './TerminalPage';

describe('TerminalNetworkBanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('projects reconnect status as a top-level overlay without changing page layout flow', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible
        networkOnline
        activeSessionState="reconnecting"
        activeSessionLastError="network generation target transport terminal state 3"
      />,
    );

    const banner = screen.getByTestId('terminal-network-banner');
    expect(banner.textContent).toContain('连接已断开，正在重连');
    expect(banner.textContent).toContain('标准自动恢复流程仍未恢复');
    expect(banner.textContent).not.toContain('terminal state 3');
    expect(banner.style.position).toBe('fixed');
    expect(banner.style.margin).toBe('');
    expect(banner.style.pointerEvents).toBe('none');
    expect(Number.parseInt(banner.style.zIndex || '0', 10)).toBeGreaterThan(90);
  });

  it('projects standard recovery progress before it becomes an error notification', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible={false}
        networkOnline
        activeSessionState="reconnecting"
        activeSessionLastError="rtc data channel closed"
        connectionProgressLabel="正在重连"
      />,
    );

    const banner = screen.getByTestId('terminal-network-banner');
    expect(banner.textContent).toContain('正在重连');
    expect(banner.textContent).toContain('正在按自动连接流程恢复');
    expect(banner.textContent).not.toContain('rtc data channel closed');
    expect(banner.style.position).toBe('fixed');
    expect(banner.style.pointerEvents).toBe('none');
  });

  it('does not expose raw transport errors for terminal error notifications', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible
        networkOnline
        activeSessionState="error"
        activeSessionLastError="rtc data channel closed"
      />,
    );

    const banner = screen.getByTestId('terminal-network-banner');
    expect(banner.textContent).toContain('连接失败');
    expect(banner.textContent).toContain('标准自动恢复流程未能恢复连接');
    expect(banner.textContent).not.toContain('rtc data channel closed');
  });

  it('keeps standard automatic recovery attempts non-actionable', () => {
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 0,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 1,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 2,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 3,
    })).toBe(false);
  });

  it('makes the notification actionable only after the standard recovery flow is exhausted', () => {
    expect(NETWORK_BANNER_ACTIONABLE_RECONNECT_ATTEMPT).toBe(4);
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: NETWORK_BANNER_ACTIONABLE_RECONNECT_ATTEMPT,
    })).toBe(true);
    expect(resolveConnectionIssueActionable({
      networkOnline: true,
      sessionState: 'error',
      reconnectAttempt: 0,
    })).toBe(true);
    expect(resolveConnectionIssueActionableKey({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 4,
    })).toBe('reconnect-exhausted');
    expect(resolveConnectionIssueActionableKey({
      networkOnline: true,
      sessionState: 'reconnecting',
      reconnectAttempt: 5,
    })).toBe('reconnect-exhausted');
  });

  it('keeps reconnect UI hidden for the first 10 seconds of reconnect grace', () => {
    expect(NETWORK_BANNER_GRACE_MS).toBe(10_000);

    render(
      <TerminalNetworkBanner
        connectionIssueVisible={false}
        networkOnline
        activeSessionState="reconnecting"
        activeSessionLastError="probe timeout"
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
  });
});

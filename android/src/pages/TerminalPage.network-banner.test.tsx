// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NETWORK_BANNER_GRACE_MS,
  TerminalNetworkBanner,
  resolveConnectionIssueActionable,
  resolveConnectionIssueActionableKey,
} from './TerminalPage';

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));

describe('TerminalNetworkBanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not turn reconnecting into an error banner even if visibility is stale', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible
        activeSessionState="reconnecting"
        activeSessionLastError="network generation target transport terminal state 3"
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
  });

  it('keeps standard recovery progress out of the fixed error overlay', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible={false}
        activeSessionState="reconnecting"
        activeSessionLastError="rtc data channel closed"
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
  });

  it('does not expose raw transport errors for terminal error notifications', () => {
    render(
      <TerminalNetworkBanner
        connectionIssueVisible
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
      sessionState: 'reconnecting',
      reconnectAttempt: 0,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      sessionState: 'reconnecting',
      reconnectAttempt: 1,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      sessionState: 'reconnecting',
      reconnectAttempt: 2,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      sessionState: 'reconnecting',
      reconnectAttempt: 3,
    })).toBe(false);
  });

  it('does not expose a second platform-network control input', () => {
    expect(resolveConnectionIssueActionableKey({
      sessionState: 'connected',
      reconnectAttempt: 0,
    })).toBeNull();
    expect(resolveConnectionIssueActionableKey({
      sessionState: 'reconnecting',
      reconnectAttempt: 1,
    })).toBeNull();

    render(
      <TerminalNetworkBanner
        connectionIssueVisible
        activeSessionState="connected"
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
  });

  it('forbids platform network hints from becoming terminal connection truth', () => {
    const pageSource = readFileSync(join(process.cwd(), 'src', 'pages', 'TerminalPage.tsx'), 'utf8');
    const bannerSource = readFileSync(join(process.cwd(), 'src', 'pages', 'terminal-page-shell-ui.tsx'), 'utf8');

    expect(pageSource).not.toContain('navigator.onLine');
    expect(pageSource).not.toContain('networkOnline');
    expect(bannerSource).not.toContain('networkOnline');
    expect(bannerSource).not.toContain('网络已断开');
  });

  it('does not use reconnect attempt count as user-visible failure truth', () => {
    expect(resolveConnectionIssueActionable({
      sessionState: 'reconnecting',
      reconnectAttempt: 4,
    })).toBe(false);
    expect(resolveConnectionIssueActionable({
      sessionState: 'error',
      reconnectAttempt: 0,
    })).toBe(true);
    expect(resolveConnectionIssueActionableKey({
      sessionState: 'reconnecting',
      reconnectAttempt: 4,
    })).toBeNull();
    expect(resolveConnectionIssueActionableKey({
      sessionState: 'reconnecting',
      reconnectAttempt: 5,
    })).toBeNull();
  });

  it('keeps reconnect UI hidden for the first 10 seconds of reconnect grace', () => {
    expect(NETWORK_BANNER_GRACE_MS).toBe(10_000);

    render(
      <TerminalNetworkBanner
        connectionIssueVisible={false}
        activeSessionState="reconnecting"
        activeSessionLastError="probe timeout"
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
  });
});

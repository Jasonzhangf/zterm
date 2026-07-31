// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORK_BANNER_GRACE_MS, TerminalNetworkBanner } from './TerminalPage';

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
        activeSessionLastError="probe timeout"
      />,
    );

    const banner = screen.getByTestId('terminal-network-banner');
    expect(banner.textContent).toContain('连接已断开，正在重连');
    expect(banner.textContent).toContain('probe timeout');
    expect(banner.style.position).toBe('fixed');
    expect(banner.style.margin).toBe('');
    expect(banner.style.pointerEvents).toBe('none');
    expect(Number.parseInt(banner.style.zIndex || '0', 10)).toBeGreaterThan(90);
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

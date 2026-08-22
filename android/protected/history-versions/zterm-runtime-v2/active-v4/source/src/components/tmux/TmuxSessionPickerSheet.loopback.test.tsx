// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { TmuxSessionPickerSheet } from './TmuxSessionPickerSheet';
import { resetTmuxSessionTransportPoolForTests } from '../../lib/tmux-sessions';

const loopbackRefreshRelayDevices = vi.hoisted(() => vi.fn());
const runRealHerdrLoopback = process.env.ZTERM_REAL_HERDR_LOOPBACK === '1'
  && Boolean(process.env.ZTERM_HERDR_LOOPBACK_TOKEN);

vi.mock('qrcode', () => ({
  default: { toString: vi.fn().mockResolvedValue('<svg data-qr="ok"></svg>') },
}));

vi.mock('../../hooks/useTraversalRelayDaemonDevices', () => ({
  useTraversalRelayDaemonDevices: () => ({ refresh: loopbackRefreshRelayDevices, devices: [] }),
}));

Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  value: NodeWebSocket,
});

const describeRealHerdrLoopback = runRealHerdrLoopback ? describe : describe.skip;

describeRealHerdrLoopback('TmuxSessionPickerSheet installed daemon loopback', () => {
  afterEach(() => {
    cleanup();
    resetTmuxSessionTransportPoolForTests();
  });

  it('renders a live official Herdr session from the installed local daemon', async () => {
    const view = render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={{
          signalUrl: '',
          turnServerUrl: '',
          turnUsername: '',
          turnCredential: '',
          transportMode: 'auto',
        }}
        initialTarget={{
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          authToken: process.env.ZTERM_HERDR_LOOPBACK_TOKEN,
        }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Herdr' }));

    view.rerender(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={{
          signalUrl: '',
          turnServerUrl: '',
          turnUsername: '',
          turnCredential: '',
          transportMode: 'auto',
        }}
        initialTarget={{
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          authToken: 'wterm-4123456',
        }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('hd-codex')).toBeTruthy();
    }, { timeout: 15_000 });
  });
});

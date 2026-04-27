// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { ConnectionPropertiesPage } from './ConnectionPropertiesPage';

const tmuxSessionMocks = vi.hoisted(() => ({
  fetchTmuxSessions: vi.fn(),
}));

vi.mock('../lib/tmux-sessions', () => ({
  fetchTmuxSessions: tmuxSessionMocks.fetchTmuxSessions,
}));

const bridgeSettings: BridgeSettings = {
  targetHost: '100.64.0.1',
  targetPort: 3333,
  targetAuthToken: 'saved-token',
  signalUrl: 'https://signal.example.com',
  turnServerUrl: 'turn:relay.example.com',
  turnUsername: 'turn-user',
  turnCredential: 'turn-pass',
  transportMode: 'auto',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  shortcutSmartSort: true,
  defaultServerId: 'server-1',
  servers: [
    {
      id: 'server-1',
      name: 'MacStudio',
      targetHost: '100.64.0.10',
      targetPort: 3333,
      authToken: 'token-a',
    },
  ],
};

describe('ConnectionPropertiesPage', () => {
  beforeEach(() => {
    tmuxSessionMocks.fetchTmuxSessions.mockReset();
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('covers the normal create flow: apply remembered server, discover tmux session, and save the connection', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' My Mac ' } });
    fireEvent.click(screen.getByText('MacStudio'));

    expect(screen.getByDisplayValue('100.64.0.10')).toBeTruthy();
    expect(screen.getByDisplayValue('3333')).toBeTruthy();
    expect(screen.getByDisplayValue('token-a')).toBeTruthy();

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.64.0.10',
          bridgePort: 3333,
          authToken: 'token-a',
          signalUrl: 'https://signal.example.com',
          transportMode: 'auto',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    expect(screen.getByDisplayValue('main')).toBeTruthy();

    fireEvent.click(screen.getByText('RTC First'));
    fireEvent.change(screen.getByPlaceholderText('your-host.ts.net 或 100.x.y.z'), { target: { value: 'mac.tailnet.ts.net' } });
    fireEvent.change(screen.getByPlaceholderText('例如：tmux attach -t main'), { target: { value: 'htop' } });
    fireEvent.click(screen.getByText('Pin this connection to the top'));
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Mac',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
        sessionName: 'main',
        transportMode: 'webrtc',
        tailscaleHost: 'mac.tailnet.ts.net',
        autoCommand: 'htop',
        pinned: true,
      }),
    );
  });

  it('normalizes raw host:port input before discovery and save', async () => {
    const onSave = vi.fn();
    tmuxSessionMocks.fetchTmuxSessions.mockResolvedValueOnce(['main']);

    render(
      <ConnectionPropertiesPage
        bridgeSettings={bridgeSettings}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：MacStudio'), { target: { value: ' Tailnet ' } });
    fireEvent.change(screen.getByPlaceholderText('100.127.23.27[:40807] 或 macstudio.tailnet'), {
      target: { value: '100.127.23.27:40807' },
    });
    fireEvent.change(screen.getByPlaceholderText('daemon 的共享 token'), { target: { value: 'token-a' } });

    expect(screen.getByDisplayValue('100.127.23.27')).toBeTruthy();
    expect(screen.getByDisplayValue('40807')).toBeTruthy();

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionMocks.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.127.23.27',
          bridgePort: 40807,
          authToken: 'token-a',
        }),
        bridgeSettings,
      );
    });

    await screen.findByText('main');
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Tailnet',
        bridgeHost: '100.127.23.27',
        bridgePort: 40807,
        authToken: 'token-a',
        sessionName: 'main',
      }),
    );
  });
});

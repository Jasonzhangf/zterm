// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConnectionConfigShareLink } from '@zterm/shared';
import { TmuxSessionPickerSheet } from './TmuxSessionPickerSheet';

const tmuxSessionsMock = vi.hoisted(() => ({
  fetchTmuxSessions: vi.fn(),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(),
  renameTmuxSession: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: {
    toString: vi.fn().mockResolvedValue('<svg data-qr="ok"></svg>'),
  },
}));

const refreshRelayDevices = vi.fn();
const relayDevices = [
  {
    deviceId: 'daemon-device-a',
    deviceName: 'MacStudio Relay',
    platform: 'darwin',
    appVersion: '0.1.0',
    updatedAt: '2026-06-28T00:00:00.000Z',
    client: {
      connected: true,
      lastSeenAt: '2026-06-28T00:00:00.000Z',
    },
    daemon: {
      connected: true,
      lastSeenAt: '2026-06-28T00:00:00.000Z',
      hostId: 'daemon-host-a',
      version: '0.1.0',
      endpoints: [
        {
          id: 'direct:tailscale:daemon-host-a',
          kind: 'tailscale',
          host: 'mac.tailnet.ts.net',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
        {
          id: 'relay-rtc:daemon-host-a',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-a',
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          name: 'main',
          cwd: '/Users/jason/project',
          title: 'main',
          updatedAt: '2026-06-28T00:00:00.000Z',
        },
      ],
    },
  },
];

vi.mock('../../hooks/useTraversalRelayDaemonDevices', () => ({
  useTraversalRelayDaemonDevices: () => ({
    refresh: refreshRelayDevices,
    devices: relayDevices,
  }),
}));

vi.mock('../../lib/tmux-sessions', () => tmuxSessionsMock);

const bridgeSettings = {
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto' as const,
  traversalRelay: {
    relayBaseUrl: 'http://relay.test/relay/',
    accessToken: 'access-1',
    userId: 'user-1',
    username: 'jason',
    deviceId: 'android-1',
    deviceName: 'Android',
    platform: 'android',
    wsDevicesUrl: 'ws://relay.test/relay/ws/devices',
    wsHostUrl: 'ws://relay.test/relay/ws/host',
    wsClientUrl: 'ws://relay.test/relay/ws/client',
    turnUrl: 'turn:relay.test:3478',
    turnUsername: 'turn-user',
    turnCredential: 'turn-pass',
    updatedAt: 1,
  },
};

describe('TmuxSessionPickerSheet relay directory projection', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    tmuxSessionsMock.fetchTmuxSessions.mockReset();
    tmuxSessionsMock.createTmuxSession.mockReset();
    tmuxSessionsMock.killTmuxSession.mockReset();
    tmuxSessionsMock.renameTmuxSession.mockReset();
  });

  it('auto-refreshes edit-group sessions for the concrete selected server target', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['win-main', 'win-work']);
    const onRemoteSessionsRefreshed = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="edit-group"
        open
        servers={[]}
        bridgeSettings={{ ...bridgeSettings, traversalRelay: undefined }}
        initialTarget={{
          bridgeHost: '100.75.122.121',
          bridgePort: 3333,
          daemonHostId: 'windows-daemon',
          authToken: 'token-win',
        }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
        onRemoteSessionsRefreshed={onRemoteSessionsRefreshed}
      />,
    );

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.75.122.121',
          bridgePort: 3333,
          daemonHostId: 'windows-daemon',
          authToken: 'token-win',
        }),
        expect.objectContaining({ transportMode: 'auto' }),
      );
    });
    await waitFor(() => expect(screen.getByText('win-main')).toBeTruthy());
    expect(screen.getByText('win-work')).toBeTruthy();
    expect(onRemoteSessionsRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.75.122.121',
        bridgePort: 3333,
        daemonHostId: 'windows-daemon',
      }),
      ['win-main', 'win-work'],
    );
  });

  it('refreshes the Herdr catalog for a Herdr target', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['hd-codex']);
    const onOpenTmuxSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={{ ...bridgeSettings, traversalRelay: undefined }}
        initialTarget={{ bridgeHost: '100.64.0.10', bridgePort: 3333, authToken: 'token-a', terminalBackend: 'herdr' }}
        onClose={vi.fn()}
        onOpenTmuxSession={onOpenTmuxSession}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ terminalBackend: undefined }),
        expect.objectContaining({ transportMode: 'auto' }),
      );
    });
    expect(await screen.findByText('hd-codex')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenTmuxSession).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBackend: 'herdr' }),
      'hd-codex',
    );
  });

  it('starts in Herdr mode when the drawer passes a Herdr target', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['hd-codex']);

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={{ ...bridgeSettings, traversalRelay: undefined }}
        initialTarget={{ bridgeHost: '100.64.0.10', bridgePort: 3333, authToken: 'token-a', terminalBackend: 'herdr' }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ terminalBackend: undefined }),
        expect.objectContaining({ transportMode: 'auto' }),
      );
    });
    expect(await screen.findByText('hd-codex')).toBeTruthy();
  });

  it('refreshes a direct Tailscale target even when Relay account devices are present', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['zterm', 'server']);
    const onRemoteSessionsRefreshed = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        initialTarget={{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          authToken: 'token-direct',
        }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
        onRemoteSessionsRefreshed={onRemoteSessionsRefreshed}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          authToken: 'token-direct',
          relayHostId: '',
        }),
        expect.objectContaining({ traversalRelay: expect.objectContaining({ accessToken: 'access-1' }) }),
      );
    });
    expect(await screen.findByText('zterm')).toBeTruthy();
    expect(onRemoteSessionsRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeHost: '100.66.1.82', relayHostId: '' }),
      ['server', 'zterm'],
    );
  });

  it('renames a remote tmux session through the app-owned dialog', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValue(['zterm']);
    tmuxSessionsMock.renameTmuxSession.mockResolvedValueOnce(['renamed']);

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        initialTarget={{ bridgeHost: '100.66.1.82', bridgePort: 3333, authToken: 'token-direct' }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));
    await screen.findByText('zterm');
    fireEvent.click(screen.getByRole('button', { name: '重命名 session zterm' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新的 session 名称' }), {
      target: { value: 'renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));

    await waitFor(() => {
      expect(tmuxSessionsMock.renameTmuxSession).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeHost: '100.66.1.82', bridgePort: 3333 }),
        bridgeSettings,
        'zterm',
        'renamed',
      );
    });
  });

  it('keeps the rename dialog open and renders the failure inline when remote rename fails', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValue(['zterm']);
    tmuxSessionsMock.renameTmuxSession.mockRejectedValueOnce(new Error('rename failed'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        initialTarget={{ bridgeHost: '100.66.1.82', bridgePort: 3333, authToken: 'token-direct' }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));
    await screen.findByText('zterm');
    fireEvent.click(screen.getByRole('button', { name: '重命名 session zterm' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新的 session 名称' }), {
      target: { value: 'renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));

    await waitFor(() => expect(screen.getByTestId('rename-dialog-error').textContent).toContain('rename failed'));
    expect(screen.getByRole('textbox', { name: '新的 session 名称' })).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('delegates remote kill to the app-owned disconnect-before-kill flow', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValue(['zterm']);
    const onKillTmuxSession = vi.fn().mockResolvedValue(undefined);

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        initialTarget={{ bridgeHost: '100.66.1.82', bridgePort: 3333, authToken: 'token-direct' }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onSelectCleanSession={vi.fn()}
        onKillTmuxSession={onKillTmuxSession}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));
    await screen.findByText('zterm');
    fireEvent.click(screen.getByRole('button', { name: '关闭 session zterm' }));
    expect(screen.getByTestId('zterm-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('zterm-dialog-confirm'));

    await waitFor(() => {
      expect(onKillTmuxSession).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          authToken: 'token-direct',
        }),
        'zterm',
      );
    });
    expect(tmuxSessionsMock.killTmuxSession).not.toHaveBeenCalled();
  });

  it('renames an open tab through the app-owned dialog', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValue(['zterm']);
    const onRenameOpenTab = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        openTabs={[{
          id: 'tab-1',
          sessionName: 'zterm',
          customName: 'Local tab',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
        }]}
        initialTarget={{ bridgeHost: '100.66.1.82', bridgePort: 3333, authToken: 'token-direct' }}
        onClose={vi.fn()}
        onRenameOpenTab={onRenameOpenTab}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));
    await screen.findByText('Local tab');
    fireEvent.click(screen.getByRole('button', { name: '重命名标签页 Local tab' }));
    fireEvent.change(screen.getByRole('textbox', { name: '新的标签页名称' }), {
      target: { value: 'Renamed tab' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));

    expect(onRenameOpenTab).toHaveBeenCalledWith('tab-1', 'Renamed tab');
  });

  it('refreshes an explicit Relay-only target through rtc candidates without requiring bridgeHost', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['relay-main']);

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        initialTarget={{
          bridgeHost: '',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-a',
          relayHostId: 'daemon-host-a',
          relayDeviceId: 'daemon-device-a',
          transportMode: 'webrtc',
          relayEndpointCandidates: [{
            id: 'relay-rtc:daemon-host-a',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host-a',
            authRequired: true,
            lastSeenAt: '2026-06-28T00:00:00.000Z',
          }],
        }}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: '',
          daemonHostId: 'daemon-host-a',
          relayHostId: 'daemon-host-a',
          transportMode: 'webrtc',
          relayEndpointCandidates: [expect.objectContaining({ kind: 'relay-rtc' })],
        }),
        expect.objectContaining({ traversalRelay: expect.objectContaining({ accessToken: 'access-1' }) }),
      );
    });
    expect(await screen.findByText('relay-main')).toBeTruthy();
  });

  it('opens a Relay daemon tmux session after live refresh without requiring a local bridge preset', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['main']);
    const onOpenTmuxSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={onOpenTmuxSession}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('MacStudio Relay'));

    expect((await screen.findByTestId('tmux-session-name')).textContent).toBe('main');
    fireEvent.click(screen.getByText('Open'));

    expect(onOpenTmuxSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: 'mac.tailnet.ts.net',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-a',
        relayEndpointCandidates: expect.arrayContaining([
          expect.objectContaining({ id: 'direct:tailscale:daemon-host-a' }),
          expect.objectContaining({ id: 'relay-rtc:daemon-host-a' }),
        ]),
      }),
      'main',
    );
  });

  it('opens a backend choice before creating a new session and routes Herdr explicitly', async () => {
    tmuxSessionsMock.createTmuxSession.mockResolvedValueOnce([]);
    const onOpenTmuxSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={{ ...bridgeSettings, traversalRelay: undefined }}
        initialTarget={{ bridgeHost: '100.64.0.10', bridgePort: 3333, authToken: 'token-a' }}
        onClose={vi.fn()}
        onOpenTmuxSession={onOpenTmuxSession}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('new-session'), { target: { value: 'herdr-demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByRole('dialog', { name: '选择新 session backend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /tmux — existing tmux backend/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Herdr — official single-session backend/ }));

    await waitFor(() => {
      expect(tmuxSessionsMock.createTmuxSession).toHaveBeenCalledWith(
        expect.objectContaining({ terminalBackend: 'herdr' }),
        expect.objectContaining({ traversalRelay: undefined }),
        'herdr-demo',
      );
      expect(onOpenTmuxSession).toHaveBeenCalledWith(
        expect.objectContaining({ terminalBackend: undefined }),
        'herdr-demo',
      );
    });
  });

  it('refreshes live sessions after selecting a Relay daemon instead of treating directory sessions as final truth', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValueOnce(['relay-live', 'zterm-live']);
    const onRemoteSessionsRefreshed = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
        onRemoteSessionsRefreshed={onRemoteSessionsRefreshed}
      />,
    );

    fireEvent.click(screen.getByText('MacStudio Relay'));

    await waitFor(() => {
      expect(tmuxSessionsMock.fetchTmuxSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeHost: 'mac.tailnet.ts.net',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-a',
          relayHostId: 'daemon-host-a',
          relayEndpointCandidates: expect.arrayContaining([
            expect.objectContaining({ kind: 'relay-rtc', relayHostId: 'daemon-host-a' }),
          ]),
        }),
        expect.objectContaining({ traversalRelay: expect.objectContaining({ accessToken: 'access-1' }) }),
      );
    });
    expect(await screen.findByText('relay-live')).toBeTruthy();
    expect(screen.getByText('zterm-live')).toBeTruthy();
    expect(screen.queryByText('main')).toBeNull();
    expect(onRemoteSessionsRefreshed).toHaveBeenLastCalledWith(
      expect.objectContaining({ relayHostId: 'daemon-host-a' }),
      ['relay-live', 'zterm-live'],
    );
  });

  it('does not render directory sessions while the Relay daemon live refresh is pending', async () => {
    let resolveFetch!: (sessions: string[]) => void;
    tmuxSessionsMock.fetchTmuxSessions.mockReturnValueOnce(new Promise<string[]>((resolve) => {
      resolveFetch = resolve;
    }));

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('MacStudio Relay'));

    expect(screen.queryByText('main')).toBeNull();
    resolveFetch(['relay-live']);
    expect(await screen.findByText('relay-live')).toBeTruthy();
  });

  it('shows an explicit add-server action in new-connection mode', () => {
    const onSelectCleanSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="new-connection"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={onSelectCleanSession}
      />,
    );

    fireEvent.click(screen.getByTestId('tmux-session-picker-add-server'));

    expect(onSelectCleanSession).toHaveBeenCalledTimes(1);
    expect(onSelectCleanSession.mock.calls[0][0]).toEqual(expect.objectContaining({
      bridgeHost: '',
      bridgePort: 3333,
    }));
  });

  it('keeps the overlay mounted briefly after open=false so the exit transition can play', async () => {
    tmuxSessionsMock.fetchTmuxSessions.mockResolvedValue(['win-main']);

    const baseProps = {
      mode: 'quick-tab' as const,
      servers: [],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto' as const,
        traversalRelay: undefined,
      },
      initialTarget: { bridgeHost: '100.64.0.10', bridgePort: 3333, authToken: 'token-a' },
      onClose: vi.fn(),
      onOpenTmuxSession: vi.fn(),
      onOpenMultipleTmuxSessions: vi.fn(),
      onKillTmuxSession: vi.fn(),
      onSelectCleanSession: vi.fn(),
    };

    const { rerender } = render(<TmuxSessionPickerSheet {...baseProps} open />);
    await screen.findByText('Quick New Tab');

    rerender(<TmuxSessionPickerSheet {...baseProps} open={false} />);

    const overlay = document.querySelector('[data-tmux-picker-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('data-state')).toBe('closing');

    await waitFor(() => {
      expect(document.querySelector('[data-tmux-picker-overlay]')).toBeNull();
    }, { timeout: 400 });
  });

  it('imports a pasted connection share link in the real new-connection sheet', () => {
    const onImportConnectionLink = vi.fn(() => ({ ok: true as const, name: 'Imported Mac' }));

    render(
      <TmuxSessionPickerSheet
        mode="new-connection"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
        onImportConnectionLink={onImportConnectionLink}
      />,
    );

    fireEvent.change(screen.getByLabelText('Connection share link'), {
      target: { value: 'zterm://connection/import?payload=abc' },
    });
    fireEvent.click(screen.getByText('导入链接'));

    expect(onImportConnectionLink).toHaveBeenCalledWith('zterm://connection/import?payload=abc');
    expect(screen.getByText('已导入：Imported Mac')).toBeTruthy();
  });

  it('renders all saved connections QR/link by default in the real new-connection sheet', async () => {
    render(
      <TmuxSessionPickerSheet
        mode="new-connection"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        shareableHosts={[
          {
            id: 'host-share',
            createdAt: 1,
            name: 'Existing Mac',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            sessionName: 'main',
            authType: 'password',
            authToken: 'token-a',
            tags: [],
            pinned: false,
          },
          {
            id: 'host-share-2',
            createdAt: 2,
            name: 'Linux Box',
            bridgeHost: '100.64.0.20',
            bridgePort: 3334,
            sessionName: 'work',
            authType: 'password',
            authToken: 'token-b',
            tags: [],
            pinned: false,
          },
        ]}
        quickActions={[
          { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
        ]}
        shortcutActions={[
          { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
        ]}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onKillTmuxSession={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    expect(screen.getByText('扫描二维码图片')).toBeTruthy();
    expect(screen.getByLabelText('Scan connection QR image')).toBeTruthy();

    const link = screen.getByTestId('tmux-session-picker-share-link') as HTMLTextAreaElement;
    const parsed = parseConnectionConfigShareLink(link.value);
    expect(screen.getByText('分享全部连接：2 个')).toBeTruthy();
    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      hosts: [
        expect.objectContaining({
          name: 'Existing Mac',
          bridgeHost: '100.64.0.10',
        }),
        expect.objectContaining({
          name: 'Linux Box',
          bridgeHost: '100.64.0.20',
        }),
      ],
      host: expect.objectContaining({
        name: 'Existing Mac',
        bridgeHost: '100.64.0.10',
      }),
      quickActions: [
        { id: 'qa-1', label: 'ls', sequence: 'ls -la\r', order: 0 },
      ],
      shortcutActions: [
        { id: 'sc-1', label: 'Ctrl+C', sequence: '\x03', order: 0, row: 'bottom-scroll' },
      ],
    }));
    fireEvent.click(screen.getByText('Linux Box'));
    const singleParsed = parseConnectionConfigShareLink(link.value);
    expect(screen.getByText('分享单个连接：Linux Box')).toBeTruthy();
    expect(singleParsed).toEqual(expect.objectContaining({
      ok: true,
      hosts: [
        expect.objectContaining({
          name: 'Linux Box',
          bridgeHost: '100.64.0.20',
        }),
      ],
    }));
    await waitFor(() => {
      expect(screen.getByTestId('tmux-session-picker-share-qr').innerHTML).toContain('<svg');
    });
  });
});

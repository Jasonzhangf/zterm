// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Session } from '../lib/types';
import type { TerminalQuickBarProps } from '../components/terminal/TerminalQuickBar';
import { resolveSessionGroupBoundaryProjection } from '../lib/session-group-viewport';
import {
  TerminalPage as TerminalPageBase,
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
  resolveTerminalSessionGroupViewportProjection,
} from './TerminalPage';
import { renderTerminalShellUi } from '../lib/plugin-host/terminal-shell-ui-plugin';
import {
  TerminalSessionDrawer,
  type TerminalSessionDrawerProps,
} from '../components/terminal/TerminalSessionDrawer';

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  }),
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../plugins/ImeAnchorPlugin', () => ({
  ImeAnchor: {
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: () => null,
}));

vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({
  RemoteScreenshotSheet: () => null,
}));

const renderQuickBar = (_props: TerminalQuickBarProps) => (
  <div data-testid="terminal-quickbar" />
);

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-view-${sessionId}`}>terminal:{sessionId}</div>
  ),
}));

function TerminalPage(props: ComponentProps<typeof TerminalPageBase>) {
  return (
    <TerminalPageBase
      {...props}
      renderQuickBar={renderQuickBar}
      renderTerminalShell={renderTerminalShellUi}
      renderSessionDrawer={(drawerProps) => <TerminalSessionDrawer {...drawerProps} />}
    />
  );
}

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
  };
}

function makeRelayDevice(overrides: Partial<{
  deviceId: string;
  deviceName: string;
  hostId: string;
  endpointHost: string;
  includeDirectEndpoint: boolean;
  sessions: string[];
  daemonConnected: boolean;
}> = {}) {
  const deviceId = overrides.deviceId || 'device-mac-studio';
  const hostId = overrides.hostId || 'mac-studio';
  const endpointHost = overrides.endpointHost || '100.66.1.82';
  const now = new Date().toISOString();
  return {
    deviceId,
    deviceName: overrides.deviceName || 'Mac Studio',
    platform: 'darwin',
    appVersion: 'test',
    updatedAt: now,
    client: {
      connected: true,
      lastSeenAt: now,
    },
    daemon: {
      connected: overrides.daemonConnected ?? true,
      lastSeenAt: now,
      hostId,
      version: 'test',
      endpoints: [
        ...(overrides.includeDirectEndpoint === false ? [] : [{
          id: `direct:tailscale:${hostId}`,
          kind: 'tailscale' as const,
          host: endpointHost,
          port: 3333,
          authRequired: true,
          lastSeenAt: now,
        }]),
        {
          id: `relay-rtc:${hostId}`,
          kind: 'relay-rtc' as const,
          relayHostId: hostId,
          authRequired: true,
          lastSeenAt: now,
        },
      ],
      sessions: (overrides.sessions || []).map((name) => ({
        name,
        cwd: '/Users/jason',
        title: name,
        updatedAt: now,
      })),
    },
  };
}

describe('TerminalPage portrait session drawer', () => {
  beforeEach(() => {
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 390,
        height: 844,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.clear();
  });

  it('hides the header in portrait and opens the session drawer on right swipe', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[1]!.daemonHostId = 'daemon-a';
    const sessionGroups = [{
      id: 'daemon-a',
      name: 'Daemon A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      authToken: 'token-a',
      sessionNames: ['tmux-s1', 'tmux-s2'],
      lastOpenedAt: 1,
    }];
    const onSwitchSession = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={sessionGroups}
        activeSession={sessions[0]}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenSettings={onOpenSettings}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.queryByTestId('terminal-header')).toBeNull();
    expect(screen.getByTestId('terminal-connection-status-strip')).toBeTruthy();
    expect(screen.getByTestId('terminal-portrait-back-button')).toBeTruthy();
    expect(screen.getByTestId('terminal-portrait-settings-button')).toBeTruthy();
    expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();

    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('true');

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    const activeSurfaceSessionId = resolvedSwipeSurface.getAttribute('data-testid')?.replace('terminal-swipe-surface-', '') || '';
    const targetSessionId = activeSurfaceSessionId === 's1' ? 's2' : 's1';
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('false');
    expect(screen.queryByTestId('terminal-connection-status-strip')).toBeNull();
    expect(screen.queryByTestId('terminal-portrait-back-button')).toBeNull();
    expect(screen.queryByTestId('terminal-portrait-settings-button')).toBeNull();
    expect(screen.queryByTestId('terminal-quickbar')).toBeNull();

    fireEvent.click(await screen.findByTestId(`terminal-session-drawer-select-${targetSessionId}`));
    expect(onSwitchSession).toHaveBeenCalledWith(targetSessionId);
  });

  it('renders only the plugin-provided session drawer slot render callback', () => {
    const session = makeSession('s1');
    session.daemonHostId = 'daemon-a';
    const renderDrawer = vi.fn((props: TerminalSessionDrawerProps) => (
      <div
        data-testid="plugin-session-drawer-slot"
        data-open={props.open ? 'true' : 'false'}
      />
    ));

    render(
      <TerminalPageBase
        sessions={[session]}
        sessionGroups={[]}
        activeSession={session}
        renderTerminalShell={renderTerminalShellUi}
        renderSessionDrawer={renderDrawer}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.queryByTestId('terminal-session-drawer')).toBeNull();
    expect(renderDrawer).toHaveBeenCalled();
    expect(screen.getByTestId('plugin-session-drawer-slot')).toBeTruthy();
  });

  it('keeps the portrait top controls and terminal stage on separate rows', () => {
    const session = makeSession('s1');
    session.daemonHostId = 'daemon-a';
    render(
      <TerminalPage
        sessions={[session]}
        sessionGroups={[]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenSettings={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const status = screen.getByTestId('terminal-connection-status-strip');
    const sessionsButton = screen.getByTestId('terminal-portrait-session-drawer-button');
    const stage = screen.getByTestId('terminal-stage-shell');
    expect(Number.parseInt(status.style.top, 10)).toBeGreaterThan(Number.parseInt(sessionsButton.style.top, 10));
    expect(Number.parseInt(stage.style.top, 10)).toBeGreaterThan(Number.parseInt(status.style.top, 10) + 34);
  });

  it('keeps a visible portrait entry point and a visible drawer surface', () => {
    const session = makeSession('s1');
    render(
      <TerminalPage
        sessions={[session]}
        sessionGroups={[{
          id: 'host-s1',
          name: 'Host S1',
          bridgeHost: session.bridgeHost,
          bridgePort: session.bridgePort,
          sessionNames: [session.sessionName],
          lastOpenedAt: 1,
        }]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const openButton = screen.getByTestId('terminal-portrait-session-drawer-button');
    expect(openButton).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(openButton);
    const drawer = screen.getByTestId('terminal-session-drawer');
    expect(drawer.getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('terminal-session-drawer-header')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-select-s1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('terminal-session-drawer-close'));
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes Settings and upgrade entry from the portrait terminal shell', () => {
    const sessions = [makeSession('s1')];
    const onOpenSettings = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenSettings={onOpenSettings}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '设置和升级' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('shows live route and direction rates in the portrait top status strip without aggregate bandwidth', () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.resolvedPath = 'ipv4';
    sessions[0]!.resolvedEndpoint = '192.168.1.20:3333';

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        getSessionDebugMetrics={() => ({
          uplinkBps: 1024,
          downlinkBps: 2048,
          renderHz: 0,
          pullHz: 0,
          transportBufferedBytes: 0,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: false,
          status: 'waiting',
          active: true,
          updatedAt: 1,
        })}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getByTestId('terminal-connection-status-route').textContent).toContain('局域网');
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('tmux-s1');
    expect(screen.queryByTestId('terminal-connection-status-bandwidth')).toBeNull();
    expect(screen.getByTestId('terminal-connection-status-uplink').textContent).toBe('↑ 1.0 KB/s');
    expect(screen.getByTestId('terminal-connection-status-downlink').textContent).toBe('↓ 2.0 KB/s');
  });

  it('renames the remote tmux session when the portrait status title is clicked without opening the route menu', async () => {
    const sessions = [makeSession('s1')];
    const onRenameRemoteSession = vi.fn(async () => undefined);

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRenameRemoteSession={onRenameRemoteSession}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-connection-status-session'));
    fireEvent.change(screen.getByRole('textbox', { name: '新的 session 名称' }), {
      target: { value: 'renamed-session' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));

    expect(onRenameRemoteSession).toHaveBeenCalledWith('s1', 'renamed-session');
    expect(screen.queryByTestId('terminal-connection-route-menu')).toBeNull();
  });

  it('surfaces a remote tmux rename failure without changing the visible title', async () => {
    const sessions = [makeSession('s1')];
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRenameRemoteSession={vi.fn(async () => { throw new Error('rename failed'); })}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-connection-status-session'));
    fireEvent.change(screen.getByRole('textbox', { name: '新的 session 名称' }), {
      target: { value: 'renamed-session' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));

    await waitFor(() => expect(screen.getByTestId('rename-dialog-error').textContent).toContain('rename failed'));
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('tmux-s1');
    expect(screen.getByTestId('rename-dialog-input')).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('shows standard reconnect progress in the portrait status strip without an error overlay', () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.state = 'reconnecting';
    sessions[0]!.lastError = 'rtc data channel closed';
    sessions[0]!.resolvedPath = 'ipv4';
    sessions[0]!.resolvedEndpoint = '192.168.1.20:3333';

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        getSessionDebugMetrics={() => ({
          uplinkBps: 0,
          downlinkBps: 0,
          renderHz: 0,
          pullHz: 0,
          transportBufferedBytes: 0,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: false,
          status: 'reconnecting',
          active: true,
          updatedAt: 1,
        })}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
    expect(screen.getByTestId('terminal-connection-status-activity').textContent).toBe('正在重连');
    expect(screen.getByTestId('terminal-connection-status-route').textContent).toBe('正在重连');
    expect(screen.getByTestId('terminal-connection-status-strip').style.background).toBe('transparent');
    expect(screen.getByTestId('terminal-connection-status-strip').style.boxShadow).toBe('none');
  });

  it('does not show recovery banner when a stale reconnecting label still has live traffic', () => {
    vi.useFakeTimers();
    const sessions = [makeSession('s1')];
    sessions[0]!.state = 'reconnecting';
    sessions[0]!.lastError = 'rtc data channel closed';
    sessions[0]!.resolvedPath = 'tailscale';
    sessions[0]!.resolvedEndpoint = '100.66.1.82:3333';

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        getSessionDebugMetrics={() => ({
          uplinkBps: 725,
          downlinkBps: 6200,
          renderHz: 0,
          pullHz: 0,
          transportBufferedBytes: 0,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: false,
          status: 'reconnecting',
          active: true,
          updatedAt: 1,
        })}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
    expect(screen.queryByTestId('terminal-connection-status-activity')).toBeNull();
    expect(screen.getByTestId('terminal-connection-status-route').textContent).toBe('Tailscale');
    expect(screen.getByTestId('terminal-connection-status-uplink').textContent).toBe('↑ 725 B/s');
    expect(screen.getByTestId('terminal-connection-status-downlink').textContent).toBe('↓ 6.1 KB/s');

    act(() => {
      vi.advanceTimersByTime(10_500);
    });

    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
    vi.useRealTimers();
  });

  it('shows the typed control-directory wait without highlighting the portrait status strip', () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.state = 'reconnecting';
    sessions[0]!.lastConnectStage = 'connecting';
    sessions[0]!.lastError = 'waiting for confirmed control directory';

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getByTestId('terminal-connection-status-activity').textContent).toBe('正在同步控制通道');
    expect(screen.queryByTestId('terminal-network-banner')).toBeNull();
    expect(screen.getByTestId('terminal-connection-status-strip').className).not.toContain('zterm-neo-status-strip');
  });

  it('keeps one portrait status strip bound to the active session after session switches', () => {
    const first = makeSession('s1');
    first.resolvedPath = 'ipv4';
    first.resolvedEndpoint = '192.168.1.20:3333';
    const second = makeSession('s2');
    second.resolvedPath = 'tailscale';
    second.resolvedEndpoint = '100.66.1.82:3333';
    const getSessionDebugMetrics = vi.fn((sessionId: string) => ({
      uplinkBps: sessionId === 's1' ? 1024 : 4096,
      downlinkBps: sessionId === 's1' ? 2048 : 8192,
      renderHz: 0,
      pullHz: 0,
      transportBufferedBytes: 0,
      transportBackpressured: false,
      lastRenderCommitAt: 0,
      bufferPullActive: false,
      status: 'waiting' as const,
      active: sessionId === 's2',
      updatedAt: 1,
    }));

    const view = render(
      <TerminalPage
        sessions={[first, second]}
        activeSession={first}
        getSessionDebugMetrics={getSessionDebugMetrics}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getAllByTestId('terminal-connection-status-strip')).toHaveLength(1);
    expect(screen.getByTestId('terminal-connection-status-route').textContent).toContain('局域网');
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('tmux-s1');
    expect(screen.getByTestId('terminal-connection-status-uplink').textContent).toBe('↑ 1.0 KB/s');
    expect(screen.getByTestId('terminal-connection-status-downlink').textContent).toBe('↓ 2.0 KB/s');

    view.rerender(
      <TerminalPage
        sessions={[first, second]}
        activeSession={second}
        getSessionDebugMetrics={getSessionDebugMetrics}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getAllByTestId('terminal-connection-status-strip')).toHaveLength(1);
    expect(screen.getByTestId('terminal-connection-status-route').textContent).toContain('Tailscale');
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('tmux-s2');
    expect(screen.getByTestId('terminal-connection-status-uplink').textContent).toBe('↑ 4.0 KB/s');
    expect(screen.getByTestId('terminal-connection-status-downlink').textContent).toBe('↓ 8.0 KB/s');
    expect(screen.getByTestId('terminal-connection-status-route').textContent).not.toContain('局域网');
  });

  it('opens the portrait route selector and sends the manual websocket preference', () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.resolvedPath = 'rtc-relay';
    sessions[0]!.resolvedRelayTransport = 'turn';
    const onUseWebSocketSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onUseWebSocketSession={onUseWebSocketSession}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-connection-status-strip'));
    fireEvent.click(screen.getByTestId('terminal-route-option-websocket'));

    expect(onUseWebSocketSession).toHaveBeenCalledWith('s1');
  });

  it('routes drawer plus action to the quick tab picker', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onOpenQuickTabPicker = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={onOpenQuickTabPicker}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    fireEvent.touchEnd(screen.getByTestId('terminal-session-drawer-add'), {
      changedTouches: [{ clientX: 180, clientY: 560 }],
    });
    expect(screen.getByTestId('terminal-session-drawer-new-session-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('创建'));
    expect(onOpenQuickTabPicker).toHaveBeenCalled();
  });

  it('merges direct endpoint sessions into the Relay daemon host rail identity', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    directSession.connectionName = '100.66.1.82';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-direct-mac-studio',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice(),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(await screen.findByTestId('terminal-session-drawer-host-mac-studio')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
    expect(screen.getByTestId('terminal-session-drawer-row-direct-rcc')).toBeTruthy();
  });

  it('enumerates each canonical daemon session once when direct and Relay history overlap', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    directSession.connectionName = '100.66.1.82';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[
          {
            id: 'group-direct-mac-studio',
            name: '100.66.1.82',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['rcc', 'freehand'],
            lastOpenedAt: 2,
          },
          {
            id: 'daemon:mac-studio',
            name: 'Mac Studio',
            bridgeHost: '',
            bridgePort: 3333,
            daemonHostId: 'mac-studio',
            relayEndpointCandidates: [{
              id: 'relay-rtc:mac-studio',
              kind: 'relay-rtc' as const,
              relayHostId: 'mac-studio',
              authRequired: true,
              lastSeenAt: '2026-07-17T00:00:00.000Z',
            }],
            sessionNames: ['rcc', 'freehand'],
            lastOpenedAt: 1,
          },
        ]}
        relayDevices={[
          makeRelayDevice({
            sessions: ['rcc', 'freehand'],
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(await screen.findByTestId('terminal-session-drawer-row-direct-rcc')).toBeTruthy();
    const drawerList = within(screen.getByTestId('terminal-session-drawer-list'));
    expect(drawerList.getAllByText('rcc')).toHaveLength(1);
    expect(drawerList.getAllByText('freehand')).toHaveLength(1);
  });

  it('uses saved server daemon identity aliases when Relay directory only exposes rtc endpoint', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    directSession.connectionName = '100.66.1.82';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-direct-mac-studio',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({ includeDirectEndpoint: false }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-session-drawer-host-mac-studio').textContent).toContain('1');
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
    }, { timeout: 3000 });
    expect(screen.getByTestId('terminal-session-drawer-row-direct-rcc')).toBeTruthy();
  });

  it('does not infer an rtc-only daemon identity from a unique common session catalog', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-direct-mac-studio',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['rcc', 'freehand'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: ['rcc', 'freehand', 'onestop'],
          }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
            sessions: ['powershell'],
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect((await screen.findByTestId('terminal-session-drawer-host-100.66.1.82:3333')).textContent).toContain('2');
    expect(screen.getByTestId('terminal-session-drawer-host-mac-studio').textContent).toContain('0');
  });

  it('does not render an empty direct runtime host rail when the Relay catalog owns the drawer group', async () => {
    const directSession = makeSession('direct-zterm');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.daemonHostId = undefined;
    directSession.sessionName = 'zterm';
    directSession.title = 'zterm';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'daemon:mac-studio',
          name: 'Mac Studio',
          bridgeHost: '',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          relayEndpointCandidates: [{
            id: 'relay-rtc:mac-studio',
            kind: 'relay-rtc' as const,
            relayHostId: 'mac-studio',
            authRequired: true,
            lastSeenAt: '2026-07-17T00:00:00.000Z',
          }],
          sessionNames: ['zterm', 'rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: ['zterm', 'rcc'],
          }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            includeDirectEndpoint: false,
            sessions: ['server'],
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('2');
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
  });

  it('opens an rtc-only aliased drawer session with a route-aware target instead of the stale direct group target', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.daemonHostId = undefined;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    const onOpenDrawerRemoteSession = vi.fn();

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-direct-mac-studio',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['rcc', 'freehand'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: ['rcc', 'freehand', 'onestop'],
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-remote:daemon:mac-studio::session:freehand'));

    expect(onOpenDrawerRemoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        transportMode: 'auto',
        relayEndpointCandidates: [expect.objectContaining({
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
        })],
      }),
      'freehand',
    );
  });

  it('switches an already-open direct drawer row locally when Relay owns the catalog', async () => {
    const activeSession = makeSession('active-zterm');
    activeSession.bridgeHost = '100.66.1.82';
    activeSession.bridgePort = 3333;
    activeSession.daemonHostId = undefined;
    activeSession.sessionName = 'zterm';
    activeSession.title = 'zterm';
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.daemonHostId = undefined;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    const onOpenDrawerRemoteSession = vi.fn(() => 'direct-rcc');
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={[activeSession, directSession]}
        activeSession={activeSession}
        sessionGroups={[{
          id: 'group-direct-mac-studio',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['zterm', 'rcc', 'freehand'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: ['zterm', 'rcc', 'freehand', 'onestop'],
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-direct-rcc'));

    expect(onSwitchSession).toHaveBeenCalledWith('direct-rcc');
    expect(onOpenDrawerRemoteSession).not.toHaveBeenCalled();
  });

  it('recomputes drawer enumeration when only the Relay session catalog changes', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';
    const sessions = [directSession];
    const sessionGroups = [{
      id: 'group-direct-mac-studio',
      name: '100.66.1.82',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      sessionNames: ['rcc', 'freehand'],
      lastOpenedAt: 1,
    }];
    const quickActions: never[] = [];
    const shortcutActions: never[] = [];
    const handlers = {
      onSwitchSession: vi.fn(),
      onMoveSession: vi.fn(),
      onRenameSession: vi.fn(),
      onCloseSession: vi.fn(),
      onOpenConnections: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onResize: vi.fn(),
      onTerminalInput: vi.fn(),
      onTerminalViewportChange: vi.fn(),
    };

    const { rerender } = render(
      <TerminalPage
        sessions={sessions}
        activeSession={directSession}
        sessionGroups={sessionGroups}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: [],
          }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
            includeDirectEndpoint: false,
            sessions: ['powershell'],
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        {...handlers}
        quickActions={quickActions}
        shortcutActions={shortcutActions}
        sessionDraft=""
      />,
    );

    rerender(
      <TerminalPage
        sessions={sessions}
        activeSession={directSession}
        sessionGroups={sessionGroups}
        relayDevices={[
          makeRelayDevice({
            includeDirectEndpoint: false,
            sessions: ['rcc', 'freehand', 'onestop'],
          }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
            includeDirectEndpoint: false,
            sessions: ['powershell'],
          }),
        ]}
        serverIdentityAliasInputs={[{
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          connectionName: 'Mac Studio',
        }]}
        {...handlers}
        quickActions={quickActions}
        shortcutActions={shortcutActions}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('2');
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
  });

  it('does not enumerate disconnected stale relay daemon devices as empty drawer hosts', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.daemonHostId = 'mac-studio';
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-mac-studio',
          name: 'Mac Studio',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'mac-studio',
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({
            deviceId: 'rtc-device-1784267569532',
            deviceName: 'rtc-device-1784267569532',
            hostId: 'rtc-verify-1784267569532',
            includeDirectEndpoint: false,
            daemonConnected: false,
            sessions: ['agentpi', 'rcc', 'zterm'],
          }),
          makeRelayDevice({
            deviceId: 'mac-studio',
            deviceName: 'Mac Studio',
            hostId: 'mac-studio',
            includeDirectEndpoint: false,
            sessions: ['rcc', 'zterm'],
          }),
          makeRelayDevice({
            deviceId: 'windows-pc',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            includeDirectEndpoint: false,
            sessions: ['powershell'],
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('1');
    expect(screen.queryByTestId('terminal-session-drawer-host-rtc-verify-1784267569532')).toBeNull();
    expect(screen.queryByText('rtc-device-1784267569532')).toBeNull();
  });

  it('canonicalizes a connecting catalog row when its endpoint matches the online daemon', async () => {
    const connectingSession = makeSession('freehand-live');
    connectingSession.bridgeHost = '100.66.1.82';
    connectingSession.bridgePort = 3333;
    connectingSession.daemonHostId = 'mac-studio';
    connectingSession.sessionName = 'freehand';
    connectingSession.title = 'freehand';
    connectingSession.state = 'connecting';

    render(
      <TerminalPage
        sessions={[connectingSession]}
        activeSession={connectingSession}
        sessionGroups={[
          {
            id: 'group-old-daemon',
            name: 'daemon-Macstudio-old',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            daemonHostId: 'daemon-Macstudio-old',
            sessionNames: ['freehand'],
            lastOpenedAt: 1,
          },
          {
            id: 'group-mac-studio',
            name: 'Mac Studio',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            daemonHostId: 'mac-studio',
            sessionNames: ['rcc'],
            lastOpenedAt: 2,
          },
        ]}
        relayDevices={[
          makeRelayDevice({
            deviceId: 'mac-studio',
            deviceName: 'Mac Studio',
            hostId: 'mac-studio',
            endpointHost: '100.66.1.82',
            sessions: ['freehand', 'rcc'],
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(screen.queryByTestId('terminal-session-drawer-host-daemon-Macstudio-old')).toBeNull();
    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('2');
    expect(screen.getByTestId('terminal-session-drawer-row-freehand-live')).toBeTruthy();
  });

  it('does not merge an rtc-only direct group when multiple Relay catalogs match', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';

    render(
      <TerminalPage
        sessions={[directSession]}
        activeSession={directSession}
        sessionGroups={[{
          id: 'group-direct-ambiguous',
          name: '100.66.1.82',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[
          makeRelayDevice({ includeDirectEndpoint: false, sessions: ['rcc'] }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
            includeDirectEndpoint: false,
            sessions: ['rcc'],
          }),
        ]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(await screen.findByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-mac-studio').textContent).toContain('0');
    expect(screen.getByTestId('terminal-session-drawer-host-windows-pc').textContent).toContain('0');
  });

  it('updates drawer identity when relay devices change under the memoized TerminalPage', async () => {
    const directSession = makeSession('direct-rcc');
    directSession.bridgeHost = '100.66.1.82';
    directSession.bridgePort = 3333;
    directSession.sessionName = 'rcc';
    directSession.title = 'rcc';

    const baseProps = {
      sessions: [directSession],
      activeSession: directSession,
      sessionGroups: [{
        id: 'group-direct-mac-studio',
        name: '100.66.1.82',
        bridgeHost: '100.66.1.82',
        bridgePort: 3333,
        sessionNames: ['rcc'],
        lastOpenedAt: 1,
      }],
      onSwitchSession: vi.fn(),
      onMoveSession: vi.fn(),
      onRenameSession: vi.fn(),
      onCloseSession: vi.fn(),
      onOpenConnections: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onResize: vi.fn(),
      onTerminalInput: vi.fn(),
      onTerminalViewportChange: vi.fn(),
      quickActions: [],
      shortcutActions: [],
      sessionDraft: '',
    };

    const { rerender } = render(
      <TerminalPage
        {...baseProps}
        relayDevices={[
          makeRelayDevice({ includeDirectEndpoint: false }),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
          }),
        ]}
      />,
    );
    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, { touches: [{ clientX: 236, clientY: 206 }], cancelable: true });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });
    expect(await screen.findByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeTruthy();

    rerender(
      <TerminalPage
        {...baseProps}
        relayDevices={[
          makeRelayDevice(),
          makeRelayDevice({
            deviceId: 'device-windows',
            deviceName: 'Windows PC',
            hostId: 'windows-pc',
            endpointHost: '100.66.1.90',
          }),
        ]}
      />,
    );

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('1');
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
  });

  it('canonicalizes an explicit stale daemon identity to the unique online Relay daemon', async () => {
    render(
      <TerminalPage
        sessions={[makeSession('drawer-anchor')]}
        activeSession={makeSession('drawer-anchor')}
        sessionGroups={[{
          id: 'stale-daemon-group',
          name: 'Mac Studio',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          daemonHostId: 'daemon-Macstu-old',
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[makeRelayDevice({ sessions: ['rcc'] })]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement;
    fireEvent.touchStart(swipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(screen.queryByTestId('terminal-session-drawer-host-daemon-Macstu-old')).toBeNull();
    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('1');
    expect(screen.getByTestId('terminal-session-drawer-row-remote:daemon:mac-studio::session:rcc')).toBeTruthy();
  });

  it('keeps a stale daemon identity separate from one same-name Relay catalog without endpoint evidence', async () => {
    render(
      <TerminalPage
        sessions={[makeSession('drawer-anchor')]}
        activeSession={makeSession('drawer-anchor')}
        sessionGroups={[{
          id: 'ambiguous-stale-group',
          name: '100.66.1.82',
          bridgeHost: '10.0.0.9',
          bridgePort: 3333,
          daemonHostId: 'daemon-ambiguous-old',
          sessionNames: ['rcc'],
          lastOpenedAt: 1,
        }]}
        relayDevices={[makeRelayDevice({ sessions: ['rcc'] })]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement;
    fireEvent.touchStart(swipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    const staleHost = await screen.findByTestId('terminal-session-drawer-host-daemon-ambiguous-old');
    expect(staleHost).toBeTruthy();
    expect(screen.getByTestId('terminal-session-drawer-host-mac-studio').textContent).toContain('0');
    fireEvent.click(staleHost);
    expect(screen.getByTestId('terminal-session-drawer-row-remote:daemon:daemon-ambiguous-old::session:rcc')).toBeTruthy();
  });

  it('keeps mirror-fixed non-edge right pan from opening the session drawer', () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        terminalWidthMode="mirror-fixed"
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 88, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('true');
    expect(onSwitchSession).not.toHaveBeenCalled();
  });

  it('refreshes drawer host sessions and opens remote-only sessions from the drawer', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onRefreshDrawerHostSessions = vi.fn();
    const onOpenDrawerRemoteSession = vi.fn();
    const relayEndpointCandidates = [{
      id: 'relay-rtc:daemon-a',
      kind: 'relay-rtc' as const,
      relayHostId: 'daemon-a',
      authRequired: true,
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    }];

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          relayEndpointCandidates,
          sessionNames: ['tmux-s1', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onRefreshDrawerHostSessions={onRefreshDrawerHostSessions}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(onRefreshDrawerHostSessions).toHaveBeenCalledWith('daemon-a'));
    expect(await screen.findByText('remote-beta')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-remote:daemon:daemon-a::session:remote-beta'));

    expect(onOpenDrawerRemoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
        relayEndpointCandidates,
        sessionNames: ['tmux-s1', 'remote-beta'],
      }),
      'remote-beta',
    );
  });

  it('renders and opens an independently projected Herdr catalog row beside tmux rows', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onOpenDrawerRemoteSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[
          {
            id: 'daemon:daemon-a',
            name: 'Daemon A',
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            daemonHostId: 'daemon-a',
            terminalBackend: 'tmux',
            sessionNames: ['shared'],
            lastOpenedAt: 1,
          },
          {
            id: 'daemon:daemon-a::backend:herdr',
            name: 'Daemon A Herdr',
            bridgeHost: '100.127.23.27',
            bridgePort: 3333,
            daemonHostId: 'daemon-a',
            terminalBackend: 'herdr',
            sessionNames: ['shared'],
            lastOpenedAt: 2,
          },
        ]}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={onOpenDrawerRemoteSession}
        onRefreshDrawerHostSessions={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const drawer = screen.getByTestId('terminal-session-drawer');
    const edgeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement;
    fireEvent.touchStart(edgeSurface, { touches: [{ clientX: 4, clientY: 206 }] });
    fireEvent.touchMove(edgeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(edgeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    expect(drawer.getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('terminal-session-drawer-select-remote:daemon:daemon-a::session:shared')).toBeTruthy();
    const row = await screen.findByTestId('terminal-session-drawer-select-remote:daemon:daemon-a::backend:herdr::session:shared');
    fireEvent.click(row);

    expect(onOpenDrawerRemoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalBackend: 'herdr',
        daemonHostId: 'daemon-a',
      }),
      'shared',
    );
  });

  it('projects a remote-only drawer session into the center viewport after materialization', async () => {
    const currentSession = makeSession('s1');
    currentSession.daemonHostId = 'daemon-a';
    currentSession.sessionName = 'tmux-s1';
    const openedSession = makeSession('remote-opened');
    openedSession.daemonHostId = 'daemon-a';
    openedSession.sessionName = 'remote-beta';
    openedSession.title = 'remote beta tab';
    openedSession.state = 'connecting';
    const onOpenDrawerRemoteSession = vi.fn(() => 'remote-opened');
    const baseProps = {
      sessionGroups: [{
        id: 'daemon:daemon-a',
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
        lastOpenedAt: 1,
      }],
      onSwitchSession: vi.fn(),
      onMoveSession: vi.fn(),
      onRenameSession: vi.fn(),
      onCloseSession: vi.fn(),
      onOpenConnections: vi.fn(),
      onOpenQuickTabPicker: vi.fn(),
      onOpenDrawerRemoteSession,
      onRefreshDrawerHostSessions: vi.fn(),
      onResize: vi.fn(),
      onTerminalInput: vi.fn(),
      onTerminalViewportChange: vi.fn(),
      quickActions: [],
      shortcutActions: [],
      sessionDraft: '',
    };

    const { rerender } = render(
      <TerminalPage
        {...baseProps}
        sessions={[currentSession]}
        activeSession={currentSession}
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-remote:daemon:daemon-a::session:remote-beta'));
    expect(onOpenDrawerRemoteSession).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalPage
        {...baseProps}
        sessions={[currentSession, openedSession]}
        activeSession={openedSession}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('terminal-view-remote-opened')).toBeTruthy());
    expect(screen.queryByTestId('terminal-view-remote:daemon:daemon-a::session:remote-beta')).toBeNull();
  });

  it('routes remote-only drawer close to remote tmux session close instead of local open-tab close', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onCloseSession = vi.fn();
    const onCloseDrawerRemoteSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['tmux-s1', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={vi.fn()}
        onCloseDrawerRemoteSession={onCloseDrawerRemoteSession}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByText('remote-beta')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-session-drawer-close-remote:daemon:daemon-a::session:remote-beta'));

    expect(onCloseSession).not.toHaveBeenCalled();
    expect(onCloseDrawerRemoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
      }),
      'remote-beta',
    );
  });

  it('routes opened daemon catalog drawer close through remote tmux kill before closing the local tab', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onCloseSession = vi.fn();
    const onCloseDrawerRemoteSession = vi.fn(async () => undefined);

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['tmux-s1', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={vi.fn()}
        onCloseDrawerRemoteSession={onCloseDrawerRemoteSession}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    fireEvent.touchStart(swipeSurface!, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface!, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface!, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByText('tab-s1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-session-drawer-close-s1'));

    expect(onCloseDrawerRemoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Daemon A',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        authToken: 'token-a',
        sessionNames: ['tmux-s1', 'remote-beta'],
      }),
      'tmux-s1',
    );
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledWith('s1', 'terminal-session-drawer-remote-close-success'));
  });

  it('does not close the local tab when opened catalog remote kill fails', async () => {
    const sessions = [makeSession('s1')];
    sessions[0]!.daemonHostId = 'daemon-a';
    const onCloseSession = vi.fn();
    const onCloseDrawerRemoteSession = vi.fn(async () => {
      throw new Error('remote kill failed');
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['tmux-s1'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onOpenDrawerRemoteSession={vi.fn()}
        onCloseDrawerRemoteSession={onCloseDrawerRemoteSession}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement;
    fireEvent.touchStart(swipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByText('tab-s1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('terminal-session-drawer-close-s1'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('remote kill failed'));
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  it('shows only daemon catalog sessions and hides stale opened tabs from the drawer', async () => {
    const sessions = [makeSession('live'), makeSession('stale')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[0]!.sessionName = 'live-main';
    sessions[0]!.title = 'live tab';
    sessions[1]!.daemonHostId = 'daemon-a';
    sessions[1]!.sessionName = 'stale-old';
    sessions[1]!.title = 'stale tab';
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['live-main', 'remote-beta'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement | null;
    expect(swipeSurface).toBeTruthy();
    const resolvedSwipeSurface = swipeSurface!;
    fireEvent.touchStart(resolvedSwipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(resolvedSwipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(resolvedSwipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    await waitFor(() => expect(screen.getByTestId('terminal-session-drawer').getAttribute('aria-hidden')).toBe('false'));
    expect(screen.getByText('live tab')).toBeTruthy();
    expect(screen.getByText('remote-beta')).toBeTruthy();
    expect(screen.queryByText('stale tab')).toBeNull();
    expect(screen.queryByText('stale-old')).toBeNull();

    fireEvent.click(screen.getByText('live tab'));
    expect(onSwitchSession).toHaveBeenCalledWith('live');
  });

  it('does not select a session from the synthetic click after edge-opening the drawer', async () => {
    const sessions = [makeSession('active'), makeSession('other')];
    sessions[0]!.daemonHostId = 'daemon-a';
    sessions[0]!.sessionName = 'active-main';
    sessions[1]!.daemonHostId = 'daemon-a';
    sessions[1]!.sessionName = 'other-main';
    const onSwitchSession = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        sessionGroups={[{
          id: 'daemon:daemon-a',
          name: 'Daemon A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-a',
          sessionNames: ['active-main', 'other-main'],
          lastOpenedAt: 1,
        }]}
        activeSession={sessions[0]}
        onSwitchSession={onSwitchSession}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onRefreshDrawerHostSessions={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    const swipeSurface = document.querySelector('[data-testid^="terminal-swipe-surface-"][data-swipe-enabled="true"]') as HTMLElement;
    fireEvent.touchStart(swipeSurface, { touches: [{ clientX: 56, clientY: 200 }] });
    fireEvent.touchMove(swipeSurface, {
      touches: [{ clientX: 236, clientY: 206 }],
      cancelable: true,
    });
    fireEvent.touchEnd(swipeSurface, { changedTouches: [{ clientX: 236, clientY: 206 }] });

    const otherRow = await screen.findByTestId('terminal-session-drawer-select-other');
    fireEvent.click(otherRow, { detail: 1 });
    expect(onSwitchSession).not.toHaveBeenCalled();

    fireEvent.touchStart(otherRow, {
      touches: [{ clientX: 120, clientY: 220 }],
    });
    fireEvent.touchEnd(otherRow, {
      changedTouches: [{ clientX: 120, clientY: 220 }],
    });
    fireEvent.click(otherRow, { detail: 1 });
    expect(onSwitchSession).toHaveBeenCalledWith('other');
    expect(onSwitchSession).toHaveBeenCalledTimes(1);
  });
});

describe('resolveTerminalSessionGroupViewportSlots', () => {
  it('projects top into center without mutating the fixed slot map', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'top',
    )).toEqual({
      top: null,
      center: 's1',
      bottom: 's2',
    });
  });

  it('projects bottom into center without mutating the fixed slot map', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'bottom',
    )).toEqual({
      top: 's2',
      center: 's3',
      bottom: null,
    });
  });

  it('keeps fixed slots unchanged when the center slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportSlots(
      { top: 's1', center: 's2', bottom: 's3' },
      'center',
    )).toEqual({
      top: 's1',
      center: 's2',
      bottom: 's3',
    });
  });
});

describe('resolveSessionGroupBoundaryProjection', () => {
  it('hides the before edge and shows only the after edge when focus is before', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'before',
    )).toEqual({
      slots: {
        before: null,
        center: 's1',
        after: 's2',
      },
      visible: {
        before: false,
        after: true,
      },
    });
  });

  it('shows both edges when focus is center', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'center',
    )).toEqual({
      slots: {
        before: 's1',
        center: 's2',
        after: 's3',
      },
      visible: {
        before: true,
        after: true,
      },
    });
  });

  it('shows only the before edge when focus is after', () => {
    expect(resolveSessionGroupBoundaryProjection(
      { before: 's1', center: 's2', after: 's3' },
      'after',
    )).toEqual({
      slots: {
        before: 's2',
        center: 's3',
        after: null,
      },
      visible: {
        before: true,
        after: false,
      },
    });
  });
});

describe('resolveTerminalSessionGroupViewportProjection', () => {
  it('hides the top peek when the top slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'top',
    )).toEqual({
      slots: {
        top: null,
        center: 's1',
        bottom: 's2',
      },
      visible: {
        top: false,
        bottom: true,
      },
    });
  });

  it('hides the bottom peek when the bottom slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'bottom',
    )).toEqual({
      slots: {
        top: 's2',
        center: 's3',
        bottom: null,
      },
      visible: {
        top: true,
        bottom: false,
      },
    });
  });

  it('keeps both peeks visible when the center slot is focused', () => {
    expect(resolveTerminalSessionGroupViewportProjection(
      { top: 's1', center: 's2', bottom: 's3' },
      'center',
    )).toEqual({
      slots: {
        top: 's1',
        center: 's2',
        bottom: 's3',
      },
      visible: {
        top: true,
        bottom: true,
      },
    });
  });
});

describe('resolveTerminalSessionGroupSlotReplacement', () => {
  it('replaces the currently focused bottom slot without changing top or center', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's4',
      'bottom',
    )).toEqual({
      top: 's1',
      center: 's2',
      bottom: 's4',
    });
  });

  it('replaces the currently focused top slot without changing center or bottom', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's4',
      'top',
    )).toEqual({
      top: 's4',
      center: 's2',
      bottom: 's3',
    });
  });

  it('moves an already assigned session into the target slot without duplicates', () => {
    expect(resolveTerminalSessionGroupSlotReplacement(
      { top: 's1', center: 's2', bottom: 's3' },
      's1',
      'bottom',
    )).toEqual({
      top: null,
      center: 's2',
      bottom: 's1',
    });
  });
});

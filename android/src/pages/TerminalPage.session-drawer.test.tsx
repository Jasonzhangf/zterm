// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { resolveSessionGroupBoundaryProjection } from '../lib/session-group-viewport';
import {
  TerminalPage,
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
  resolveTerminalSessionGroupViewportProjection,
} from './TerminalPage';

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

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: () => <div data-testid="terminal-quickbar" />,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-view-${sessionId}`}>terminal:{sessionId}</div>
  ),
}));

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
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
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
  return {
    deviceId,
    deviceName: overrides.deviceName || 'Mac Studio',
    platform: 'darwin',
    appVersion: 'test',
    updatedAt: '2026-07-17T00:00:00.000Z',
    client: {
      connected: true,
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    },
    daemon: {
      connected: overrides.daemonConnected ?? true,
      lastSeenAt: '2026-07-17T00:00:00.000Z',
      hostId,
      version: 'test',
      endpoints: [
        ...(overrides.includeDirectEndpoint === false ? [] : [{
          id: `direct:tailscale:${hostId}`,
          kind: 'tailscale' as const,
          host: endpointHost,
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-17T00:00:00.000Z',
        }]),
        {
          id: `relay-rtc:${hostId}`,
          kind: 'relay-rtc' as const,
          relayHostId: hostId,
          authRequired: true,
          lastSeenAt: '2026-07-17T00:00:00.000Z',
        },
      ],
      sessions: (overrides.sessions || []).map((name) => ({
        name,
        cwd: '/Users/jason',
        title: name,
        updatedAt: '2026-07-17T00:00:00.000Z',
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
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.queryByTestId('terminal-header')).toBeNull();

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

    fireEvent.click(await screen.findByTestId(`terminal-session-drawer-select-${targetSessionId}`));
    expect(onSwitchSession).toHaveBeenCalledWith(targetSessionId);
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

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('1');
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
    expect(screen.getByTestId('terminal-session-drawer-row-direct-rcc')).toBeTruthy();
  });

  it('uses an unambiguous Relay session catalog alias when rtc is the only published endpoint', async () => {
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

    expect((await screen.findByTestId('terminal-session-drawer-host-mac-studio')).textContent).toContain('2');
    expect(screen.queryByTestId('terminal-session-drawer-host-100.66.1.82:3333')).toBeNull();
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

  it('opens an rtc-only aliased drawer session with a WebRTC-first target instead of the stale direct group target', async () => {
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

    fireEvent.click(await screen.findByTestId('terminal-session-drawer-select-remote:bridge:100.66.1.82::3333::session:freehand'));

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

  it('routes an already-open direct drawer row back through the WebRTC-first open owner when Relay owns the catalog', async () => {
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

    expect(onSwitchSession).not.toHaveBeenCalled();
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
      'rcc',
    );
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

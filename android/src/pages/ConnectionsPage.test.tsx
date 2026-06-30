// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeTraversalRelayAccountState } from '../lib/traversal-relay-client';
import { getServerIdentityTone } from '../lib/server-identity';
import { TraversalRouteHealthCache } from '../lib/traversal/route-health-cache';
import type { Host, Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from '../lib/types';
import type { TraversalPlanCandidate } from '../lib/traversal/types';
import { ConnectionsPage } from './ConnectionsPage';

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'host-1',
    createdAt: overrides.createdAt || 1,
    name: overrides.name || 'Main Host',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    sessionName: overrides.sessionName || 'main',
    authType: overrides.authType || 'password',
    tags: overrides.tags || [],
    pinned: overrides.pinned || false,
    authToken: overrides.authToken || 'token-a',
    tailscaleHost: overrides.tailscaleHost,
    ipv6Host: overrides.ipv6Host,
    ipv4Host: overrides.ipv4Host,
    signalUrl: overrides.signalUrl,
    transportMode: overrides.transportMode || 'auto',
    password: overrides.password,
    privateKey: overrides.privateKey,
    lastConnected: overrides.lastConnected || 10,
    autoCommand: overrides.autoCommand,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id || 'session-1',
    hostId: overrides.hostId || 'host-1',
    connectionName: overrides.connectionName || 'Main Host',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    sessionName: overrides.sessionName || 'logs',
    authToken: overrides.authToken || 'token-a',
    title: overrides.title || 'logs',
    ws: null,
    state: overrides.state || 'connected',
    hasUnread: overrides.hasUnread || false,
    createdAt: overrides.createdAt || 20,
    buffer: overrides.buffer || {
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

function makeGroup(overrides: Partial<SessionGroupHistory> = {}): SessionGroupHistory {
  return {
    id: overrides.id || 'group-1',
    name: overrides.name || 'server group',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    authToken: overrides.authToken || 'token-a',
    sessionNames: overrides.sessionNames || ['main', 'logs'],
    missingSessionNames: overrides.missingSessionNames || [],
    lastOpenedAt: overrides.lastOpenedAt || 30,
  };
}

function makeRelayDevice(overrides: Partial<TraversalRelayDeviceSnapshot> = {}): TraversalRelayDeviceSnapshot {
  return {
    deviceId: overrides.deviceId || 'mac-studio-device',
    deviceName: overrides.deviceName || 'mac-studio',
    platform: overrides.platform || 'mac',
    appVersion: overrides.appVersion || '0.1.2',
    updatedAt: overrides.updatedAt || '2026-05-29T00:00:00.000Z',
    client: overrides.client || { connected: false, lastSeenAt: '' },
    daemon: overrides.daemon || {
      connected: true,
      lastSeenAt: '2026-05-29T00:00:00.000Z',
      hostId: 'mac-studio',
      version: '0.1.2',
    },
  };
}

describe('ConnectionsPage', () => {
  afterEach(() => {
    cleanup();
    writeTraversalRelayAccountState(null);
    vi.useRealTimers();
  });

  it('covers grouped server usage: open defaults, manage selection, open single sessions, and route edit/delete', () => {
    const onResumeSession = vi.fn();
    const onCloseSession = vi.fn();
    const onOpenGroupSession = vi.fn();
    const onEditServerGroup = vi.fn();
    const onSaveServerGroupSelection = vi.fn();
    const onOpenServerGroups = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({ id: 'host-main', sessionName: 'main', name: 'Main Host', lastConnected: 10 }),
          makeHost({ id: 'host-logs', sessionName: 'logs', name: 'Logs Host', lastConnected: 12 }),
        ]}
        sessions={[makeSession({ id: 'live-logs', hostId: 'host-logs', sessionName: 'logs' })]}
        sessionGroups={[makeGroup()]}
        onResumeSession={onResumeSession}
        onCloseSession={onCloseSession}
        onOpenGroupSession={onOpenGroupSession}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={onSaveServerGroupSelection}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={onEdit}
        onDelete={onDelete}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('Sessions')[0]);
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeHost: '100.64.0.10', bridgePort: 3333 }),
      expect.arrayContaining(['main', 'logs']),
    );
    expect(onOpenServerGroups).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText('+')[0]);

    fireEvent.click(screen.getByText('None'));
    expect(onSaveServerGroupSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeHost: '100.64.0.10' }),
      [],
    );

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onSaveServerGroupSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeHost: '100.64.0.10' }),
      ['main'],
    );

    fireEvent.click(screen.getByText('Open checked'));
    expect(onOpenServerGroups).toHaveBeenLastCalledWith([
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        sessionNames: ['main'],
      }),
    ]);

    fireEvent.click(screen.getAllByText('Enter')[0]);
    expect(onResumeSession).toHaveBeenCalledWith('live-logs');

    fireEvent.click(screen.getByText('Close'));
    expect(onCloseSession).toHaveBeenCalledWith('live-logs', 'connections-session-row-close-button');

    fireEvent.click(screen.getByText('Open'));
    expect(onOpenGroupSession).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeHost: '100.64.0.10', bridgePort: 3333 }),
      'main',
    );

    fireEvent.click(screen.getAllByText('Edit')[1]);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'host-main' }));

    fireEvent.click(screen.getAllByText('Del')[1]);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'host-main' }));
  });

  it('can select all visible server groups from the same list and open them together', () => {
    const onOpenServerGroups = vi.fn();
    render(
      <ConnectionsPage
        hosts={[
          makeHost({ id: 'host-a', bridgeHost: '100.64.0.10', daemonHostId: 'daemon-a', sessionName: 'main' }),
          makeHost({ id: 'host-b', bridgeHost: '100.64.0.20', daemonHostId: 'daemon-b', sessionName: 'work' }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({ id: 'group-a', bridgeHost: '100.64.0.10', daemonHostId: 'daemon-a', sessionNames: ['main'] }),
          makeGroup({ id: 'group-b', bridgeHost: '100.64.0.20', daemonHostId: 'daemon-b', sessionNames: ['work'] }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('All servers'));
    expect(screen.getByText('Open selected groups')).toBeTruthy();

    fireEvent.click(screen.getByText('Open selected groups'));
    expect(onOpenServerGroups).toHaveBeenCalledWith([
      expect.objectContaining({ daemonHostId: 'daemon-a', sessionNames: ['main'] }),
      expect.objectContaining({ daemonHostId: 'daemon-b', sessionNames: ['work'] }),
    ]);
  });

  it('renders account daemon devices as concise parent rows with child sessions', () => {
    render(
      <ConnectionsPage
        relayDevices={[makeRelayDevice()]}
        hosts={[makeHost({ daemonHostId: 'mac-studio', sessionName: 'main' })]}
        sessions={[makeSession({ id: 'live-demo', daemonHostId: 'daemon-Macstudio.local-128564413166185f', sessionName: 'demo' })]}
        sessionGroups={[makeGroup({ daemonHostId: 'mac-studio', sessionNames: ['main'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('mac-studio · 2 sessions')).toBeTruthy();
    expect(screen.queryByText(/daemon-Macstudio\.local/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand mac-studio sessions'));
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
  });

  it('uses the same server identity tone as the drawer for daemon-first groups', () => {
    render(
      <ConnectionsPage
        relayDevices={[makeRelayDevice()]}
        hosts={[makeHost({ daemonHostId: 'mac-studio', sessionName: 'main' })]}
        sessions={[makeSession({ id: 'live-demo', daemonHostId: 'daemon-Macstudio.local-128564413166185f', sessionName: 'demo' })]}
        sessionGroups={[makeGroup({ daemonHostId: 'mac-studio', sessionNames: ['main'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const card = screen.getByTestId('connection-card');
    const tone = getServerIdentityTone({
      daemonHostId: 'mac-studio',
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      connectionName: 'mac-studio',
    });
    const probe = document.createElement('div');
    probe.style.border = `1px solid ${tone.lightCardBorder}`;
    document.body.appendChild(probe);

    expect(card.getAttribute('data-server-key')).toBe('mac-studio');
    expect(window.getComputedStyle(card).borderTopColor).toBe(window.getComputedStyle(probe).borderTopColor);
    document.body.removeChild(probe);
  });

  it('shows route badge, RTT, last error, and last success for relay directory machines', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    writeTraversalRelayAccountState({
      username: 'jason',
      password: '',
      relayBaseUrl: 'http://relay.test/relay/',
      accessToken: 'token',
      user: { id: 'user-a', username: 'jason', createdAt: '2026-06-28T00:00:00.000Z' },
      deviceId: 'android-device',
      deviceName: 'ZTerm Android',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1000,
    });
    const routeHealthCache = new TraversalRouteHealthCache({ now: () => 1000 });
    const relayCandidate = {
      id: 'relay-rtc:relay-daemon-a',
      kind: 'rtc',
      path: 'rtc-relay',
      endpoint: 'relay-daemon-a',
      signalUrl: 'wss://relay.example/ws/client?hostId=relay-daemon-a',
      iceServers: [],
    } satisfies TraversalPlanCandidate;
    const directCandidate = {
      id: 'direct:tailscale:relay-daemon-a',
      kind: 'ws',
      path: 'tailscale',
      endpoint: 'relay-mac.tailnet.ts.net',
      url: 'ws://relay-mac.tailnet.ts.net',
    } satisfies TraversalPlanCandidate;
    routeHealthCache.recordSuccess({ accountId: 'user-a', daemonHostId: 'relay-daemon-a' }, relayCandidate, 144);
    routeHealthCache.recordFailure({ accountId: 'user-a', daemonHostId: 'relay-daemon-a' }, directCandidate, 'timeout');

    render(
      <ConnectionsPage
        bridgeSettings={{ traversalPathPriority: ['tailscale', 'rtc-relay', 'ipv4'] }}
        routeHealthCache={routeHealthCache}
        relayDevices={[
          makeRelayDevice({
            deviceId: 'relay-device-a',
            deviceName: 'relay-mac',
            daemon: {
              connected: true,
              lastSeenAt: '2026-06-28T00:00:00.000Z',
              hostId: 'relay-daemon-a',
              version: '0.1.3',
              endpoints: [
                {
                  id: 'direct:tailscale:relay-daemon-a',
                  kind: 'tailscale',
                  host: 'relay-mac.tailnet.ts.net',
                  port: 3333,
                  authRequired: true,
                  lastSeenAt: '2026-06-28T00:00:00.000Z',
                },
                {
                  id: 'relay-rtc:relay-daemon-a',
                  kind: 'relay-rtc',
                  relayHostId: 'relay-daemon-a',
                  authRequired: true,
                  lastSeenAt: '2026-06-28T00:00:00.000Z',
                },
              ],
              sessions: [
                {
                  name: 'main',
                  updatedAt: '2026-06-28T00:00:00.000Z',
                },
              ],
            },
          }),
        ]}
        hosts={[]}
        sessions={[]}
        sessionGroups={[]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText(/Route Relay RTC · RTT 144ms · last success just now · last error timeout · just now/)).toBeTruthy();
    expect(screen.getByText('Route Relay RTC · 144ms')).toBeTruthy();
  });

  it('greys missing sessions and can close them in one click', () => {
    const onSaveServerGroupSelection = vi.fn();
    const onDeleteServerGroup = vi.fn();
    render(
      <ConnectionsPage
        hosts={[makeHost({ daemonHostId: 'daemon-host-1', sessionName: 'main' })]}
        sessions={[]}
        sessionGroups={[makeGroup({
          daemonHostId: 'daemon-host-1',
          sessionNames: ['main', 'ghost'],
          missingSessionNames: ['ghost'],
        })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={onSaveServerGroupSelection}
        onDeleteServerGroup={onDeleteServerGroup}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Expand daemon-host-1 sessions'));
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getByText('Close missing')).toBeTruthy();

    fireEvent.click(screen.getByText('Close missing'));
    expect(onSaveServerGroupSelection).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-host-1' }),
      ['main'],
    );
    expect(onDeleteServerGroup).not.toHaveBeenCalled();
  });

  it('surfaces missing-session groups on the card and expands them from card tap instead of opening blindly', () => {
    const onOpenServerGroups = vi.fn();
    render(
      <ConnectionsPage
        hosts={[makeHost({ daemonHostId: 'daemon-host-1', sessionName: 'main' })]}
        sessions={[]}
        sessionGroups={[makeGroup({
          daemonHostId: 'daemon-host-1',
          sessionNames: ['main', 'ghost'],
          missingSessionNames: ['ghost'],
        })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('1 missing · review and close stale sessions')).toBeTruthy();
    fireEvent.click(screen.getByText('daemon-host-1 · 2 sessions'));
    expect(onOpenServerGroups).not.toHaveBeenCalled();
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getByText('Close missing')).toBeTruthy();
  });

it('exits group management and restores the add-server entry', () => {
    const onOpenVaults = vi.fn();

    render(
      <ConnectionsPage
        hosts={[makeHost({ daemonHostId: 'daemon-host-1', sessionName: 'main' })]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', sessionNames: ['main'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenVaults={onOpenVaults}
      />,
    );

    fireEvent.click(screen.getByLabelText('Expand daemon-host-1 sessions'));
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.queryByLabelText('新增服务器')).toBeNull();

    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByText('main')).toBeNull();
    expect(screen.getByLabelText('新增服务器')).toBeTruthy();

    fireEvent.click(screen.getByText('Vaults'));
    expect(onOpenVaults).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Vaults are not available yet')).toBeTruthy();
  });

  it('routes card tap to the matching server picker instead of a shared open path', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        hosts={[makeHost({ daemonHostId: 'daemon-host-1', sessionName: 'main' })]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', sessionNames: ['main'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('daemon-host-1 · 1 session'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
      }),
      ['main'],
    );
  });

  it('covers empty-state entry actions: add server and open settings login', () => {
    const onAddNew = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <ConnectionsPage
        hosts={[]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', bridgeHost: '100.64.0.10', bridgePort: 3333, sessionNames: ['main', 'logs'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={onAddNew}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByLabelText('新增服务器')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('新增服务器'));
    expect(onAddNew).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });


  it('does not render host-only groups when there is no sessionGroup or live runtime session truth', () => {
    render(
      <ConnectionsPage
        hosts={[
          makeHost({ id: 'host-stale', bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-1', sessionName: 'stale' }),
        ]}
        sessions={[]}
        sessionGroups={[]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.queryByText(/daemon-host-1 · 0 sessions$/)).toBeNull();
    expect(screen.getByText('No connections yet')).toBeTruthy();
  });

  it('groups hosts by daemonHostId first even when bridge endpoint differs', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({ id: 'host-main', bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-1', sessionName: 'main' }),
          makeHost({ id: 'host-logs', bridgeHost: '100.127.23.27', bridgePort: 4444, daemonHostId: 'daemon-host-1', sessionName: 'logs' }),
        ]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', bridgeHost: '100.64.0.10', bridgePort: 3333, sessionNames: ['main', 'logs'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('daemon-host-1 · 2 sessions')).toBeTruthy();
    expect(screen.getByText('saved · 100.64.0.10:3333')).toBeTruthy();

    fireEvent.click(screen.getByText('Sessions'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
      }),
      expect.arrayContaining(['main', 'logs']),
    );
  });


  it('opens the newer daemon endpoint instead of a stale saved host endpoint for the same server card', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-stale',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            daemonHostId: 'daemon-host-1',
            sessionName: 'main',
            lastConnected: 1,
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            daemonHostId: 'daemon-host-1',
            bridgeHost: '100.127.23.27',
            bridgePort: 4444,
            sessionNames: ['main'],
            lastOpenedAt: 99,
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Sessions'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
      }),
      ['main'],
    );
  });


  it('opens with the newer daemon auth token instead of a stale saved host token for the same server card', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-stale',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            daemonHostId: 'daemon-host-1',
            authToken: 'token-stale',
            sessionName: 'main',
            lastConnected: 1,
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            daemonHostId: 'daemon-host-1',
            bridgeHost: '100.127.23.27',
            bridgePort: 4444,
            authToken: 'token-fresh',
            sessionNames: ['main'],
            lastOpenedAt: 99,
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Sessions'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        authToken: 'token-fresh',
      }),
      ['main'],
    );
  });

  it('keeps each server card pinned to its own bridge target when opening the picker', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-a',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            daemonHostId: 'daemon-a',
            sessionName: 'main',
          }),
          makeHost({
            id: 'host-b',
            bridgeHost: '100.75.122.121',
            bridgePort: 3333,
            daemonHostId: 'daemon-b',
            sessionName: 'work',
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            id: 'group-a',
            daemonHostId: 'daemon-a',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            sessionNames: ['main'],
          }),
          makeGroup({
            id: 'group-b',
            daemonHostId: 'daemon-b',
            bridgeHost: '100.75.122.121',
            bridgePort: 3333,
            sessionNames: ['work'],
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('daemon-a · 1 session'));
    fireEvent.click(screen.getByText('daemon-b · 1 session'));

    expect(onEditServerGroup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
      }),
      ['main'],
    );
    expect(onEditServerGroup).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        daemonHostId: 'daemon-b',
        bridgeHost: '100.75.122.121',
        bridgePort: 3333,
      }),
      ['work'],
    );
  });

  it('uses saved server preset auth when a relay directory group opens the picker', () => {
    const onEditServerGroup = vi.fn();

    render(
      <ConnectionsPage
        bridgeSettings={{
          servers: [{
            id: 'windows-preset',
            name: 'Windows',
            targetHost: '100.75.122.121',
            targetPort: 3333,
            authToken: 'token-win',
            relayHostId: 'windows-daemon',
          }],
          traversalPathPriority: ['tailscale', 'rtc-relay'],
        }}
        hosts={[]}
        sessions={[]}
        sessionGroups={[]}
        relayDevices={[makeRelayDevice({
          deviceId: 'windows-device',
          deviceName: 'Windows PC',
          platform: 'win32',
          daemon: {
            connected: true,
            lastSeenAt: '2026-06-30T00:00:00.000Z',
            hostId: 'windows-daemon',
            version: '0.1.3',
            endpoints: [{
              id: 'direct:tailscale:windows-daemon',
              kind: 'tailscale',
              host: '100.75.122.121',
              port: 3333,
              authRequired: true,
              lastSeenAt: '2026-06-30T00:00:00.000Z',
            }],
            sessions: [{ name: 'main', updatedAt: '2026-06-30T00:00:00.000Z' }],
          },
        })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Windows PC · 1 session'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.75.122.121',
        bridgePort: 3333,
        daemonHostId: 'windows-daemon',
        authToken: 'token-win',
        relayEndpointCandidates: expect.arrayContaining([
          expect.objectContaining({ id: 'direct:tailscale:windows-daemon' }),
        ]),
      }),
      ['main'],
    );
  });

  it('keeps daemonHostId when opening checked sessions from expanded group', () => {
    const onOpenServerGroups = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({ id: 'host-main', bridgeHost: '100.64.0.10', bridgePort: 3333, daemonHostId: 'daemon-host-1', sessionName: 'main' }),
          makeHost({ id: 'host-logs', bridgeHost: '100.127.23.27', bridgePort: 4444, daemonHostId: 'daemon-host-1', sessionName: 'logs' }),
        ]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', bridgeHost: '100.64.0.10', bridgePort: 3333, sessionNames: ['main', 'logs'] })]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.click(screen.getByText('Open checked'));

    expect(onOpenServerGroups).toHaveBeenLastCalledWith([
      expect.objectContaining({
        name: 'daemon-host-1 · 2 sessions',
        daemonHostId: 'daemon-host-1',
        sessionNames: expect.arrayContaining(['main', 'logs']),
      }),
    ]);
  });

  it('collapses bridge-history and daemon-live entries for the same server into one card', () => {
    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-main',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionName: 'zterm',
          }),
        ]}
        sessions={[
          makeSession({
            id: 'live-zterm',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            daemonHostId: 'daemon-Macstudio.local-128564413166185f',
            sessionName: 'zterm',
          }),
        ]}
        sessionGroups={[
          makeGroup({
            id: 'bridge:100.66.1.82::3333',
            name: '100.66.1.82 · 1 session',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/· 1 session$/)).toHaveLength(1);
    expect(screen.getByText('daemon-Macstudio.local-128564413166185f · 1 session')).toBeTruthy();
  });


  it('uses the fresh matching saved host for row Edit when stale and fresh candidates exist for the same daemon session', () => {
    const onEdit = vi.fn();

    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-stale',
            name: 'Old Main Host',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            daemonHostId: 'daemon-host-1',
            authToken: 'token-stale',
            sessionName: 'main',
            lastConnected: 200,
          }),
          makeHost({
            id: 'host-fresh',
            name: 'Fresh Main Host',
            bridgeHost: '100.127.23.27',
            bridgePort: 4444,
            daemonHostId: 'daemon-host-1',
            authToken: 'token-fresh',
            sessionName: 'main',
            lastConnected: 100,
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            daemonHostId: 'daemon-host-1',
            bridgeHost: '100.127.23.27',
            bridgePort: 4444,
            authToken: 'token-fresh',
            sessionNames: ['main'],
            lastOpenedAt: 99,
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'host-fresh',
      name: 'Fresh Main Host',
      bridgeHost: '100.127.23.27',
      bridgePort: 4444,
      authToken: 'token-fresh',
    }));
  });


  it('preserves expanded selection state when a server card upgrades from bridge id to daemon id across rerender', () => {
    const onSaveServerGroupSelection = vi.fn();
    const view = render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-main',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionName: 'zterm',
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            id: 'bridge:100.66.1.82::3333',
            name: '100.66.1.82 · 1 session',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={onSaveServerGroupSelection}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.click(screen.getByText('None'));
    expect(onSaveServerGroupSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeHost: '100.66.1.82', bridgePort: 3333 }),
      [],
    );
    expect(screen.getByText('0 selected · history-only')).toBeTruthy();

    view.rerender(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-main',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionName: 'zterm',
          }),
        ]}
        sessions={[
          makeSession({
            id: 'live-zterm',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            daemonHostId: 'daemon-Macstudio.local-128564413166185f',
            sessionName: 'zterm',
          }),
        ]}
        sessionGroups={[
          makeGroup({
            id: 'bridge:100.66.1.82::3333',
            name: '100.66.1.82 · 1 session',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={onSaveServerGroupSelection}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('0 selected · history-only')).toBeTruthy();
    expect(screen.queryByText('1 default · ready')).toBeNull();
  });

  it('opens history-only sessions through the matching picker target without synthesizing a runtime open', () => {
    const onEditServerGroup = vi.fn();
    const onOpenServerGroups = vi.fn();
    const onOpenGroupSession = vi.fn();
    const recentTs = Date.now() - 60_000;

    render(
      <ConnectionsPage
        hosts={[]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            daemonHostId: 'daemon-host-1',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            sessionNames: ['gone-a', 'gone-b'],
            lastOpenedAt: recentTs,
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={onOpenGroupSession}
        onEditServerGroup={onEditServerGroup}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('History only · last active 1 min ago')).toBeTruthy();
    expect(screen.getByText('2 default · history-only')).toBeTruthy();

    fireEvent.click(screen.getByText('Sessions'));
    expect(onEditServerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        authToken: 'token-a',
      }),
      [],
    );
    expect(onOpenServerGroups).not.toHaveBeenCalled();

    expect(onOpenGroupSession).not.toHaveBeenCalled();
  });

  it('does not render a second stale bridge-only server card when daemon-owned saved host truth already exists for the same session', () => {
    render(
      <ConnectionsPage
        hosts={[
          makeHost({
            id: 'host-main',
            name: 'Fresh Main Host',
            bridgeHost: '100.127.23.27',
            bridgePort: 4444,
            daemonHostId: 'daemon-host-1',
            authToken: 'token-fresh',
            sessionName: 'main',
            lastConnected: 100,
          }),
        ]}
        sessions={[]}
        sessionGroups={[
          makeGroup({
            id: 'bridge:100.64.0.10::3333',
            bridgeHost: '100.64.0.10',
            bridgePort: 3333,
            authToken: 'token-stale',
            sessionNames: ['main'],
            lastOpenedAt: 99,
          }),
        ]}
        onResumeSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenGroupSession={vi.fn()}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={vi.fn()}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Sessions')).toHaveLength(1);
    expect(screen.getByText('daemon-host-1 · 1 session')).toBeTruthy();
    expect(screen.queryByText('100.64.0.10 · 1 session')).toBeNull();
  });
});

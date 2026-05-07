// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Host, Session, SessionGroupHistory } from '../lib/types';
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
    lastOpenedAt: overrides.lastOpenedAt || 30,
  };
}

describe('ConnectionsPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('covers grouped server usage: open defaults, manage selection, open single sessions, and route edit/delete', () => {
    const onResumeSession = vi.fn();
    const onOpenGroupSession = vi.fn();
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
        onOpenGroupSession={onOpenGroupSession}
        onEditServerGroup={vi.fn()}
        onSaveServerGroupSelection={onSaveServerGroupSelection}
        onDeleteServerGroup={vi.fn()}
        onOpenServerGroups={onOpenServerGroups}
        onEdit={onEdit}
        onDelete={onDelete}
        onAddNew={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('Enter')[0]);
    expect(onOpenServerGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        sessionNames: expect.arrayContaining(['main', 'logs']),
      }),
    ]);

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

    fireEvent.click(screen.getAllByText('Enter')[1]);
    expect(onResumeSession).toHaveBeenCalledWith('live-logs');

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

  it('covers empty-state entry actions: add new connection and open settings', () => {
    const onAddNew = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <ConnectionsPage
        hosts={[]}
        sessions={[]}
        sessionGroups={[makeGroup({ daemonHostId: 'daemon-host-1', bridgeHost: '100.64.0.10', bridgePort: 3333, sessionNames: ['main', 'logs'] })]}
        onResumeSession={vi.fn()}
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

    fireEvent.click(screen.getByLabelText('新建连接'));
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

    expect(screen.getByText('daemon-host-1 · 2 sessions')).toBeTruthy();
    expect(screen.getByText('daemon-host-1')).toBeTruthy();

    fireEvent.click(screen.getAllByText('Open')[0]);
    expect(onOpenServerGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'daemon-host-1 · 2 sessions',
        daemonHostId: 'daemon-host-1',
        sessionNames: expect.arrayContaining(['main', 'logs']),
      }),
    ]);
  });


  it('opens the newer daemon endpoint instead of a stale saved host endpoint for the same server card', () => {
    const onOpenServerGroups = vi.fn();

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

    fireEvent.click(screen.getByText('Open'));
    expect(onOpenServerGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        sessionNames: ['main'],
      }),
    ]);
  });


  it('opens with the newer daemon auth token instead of a stale saved host token for the same server card', () => {
    const onOpenServerGroups = vi.fn();

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

    fireEvent.click(screen.getByText('Open'));
    expect(onOpenServerGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        daemonHostId: 'daemon-host-1',
        authToken: 'token-fresh',
      }),
    ]);
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
            name: '100.66.1.82 · 1 sessions',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
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

    expect(screen.getAllByText(/· 1 sessions$/)).toHaveLength(1);
    expect(screen.getByText('daemon-Macstudio.local-128564413166185f · 1 sessions')).toBeTruthy();
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
            name: '100.66.1.82 · 1 sessions',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
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
            name: '100.66.1.82 · 1 sessions',
            bridgeHost: '100.66.1.82',
            bridgePort: 3333,
            sessionNames: ['zterm'],
          }),
        ]}
        onResumeSession={vi.fn()}
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

  it('does not offer open actions for history-only sessions that no longer have a saved host or live runtime session', () => {
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
        onOpenGroupSession={onOpenGroupSession}
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

    expect(screen.getByText('History only · last active 1 min ago')).toBeTruthy();
    expect(screen.getByText('2 default · history-only')).toBeTruthy();

    fireEvent.click(screen.getAllByText('Open')[0]);
    expect(onOpenServerGroups).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.click(screen.getByText('Open checked'));
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

    expect(screen.getAllByText('Open')).toHaveLength(1);
    expect(screen.getByText('daemon-host-1 · 1 sessions')).toBeTruthy();
    expect(screen.queryByText('100.64.0.10 · 1 sessions')).toBeNull();
  });
});

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
        sessionGroups={[]}
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
});

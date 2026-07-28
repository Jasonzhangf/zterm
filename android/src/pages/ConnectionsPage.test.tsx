// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '../lib/types';
import { ConnectionsPage, type ConnectionsHomeActiveSession } from './ConnectionsPage';

function makeSavedHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'host-tailscale-a',
    createdAt: overrides.createdAt || 1,
    name: overrides.name || 'Mac Studio Tailscale',
    bridgeHost: overrides.bridgeHost ?? '100.66.1.82',
    bridgePort: overrides.bridgePort ?? 3333,
    daemonHostId: overrides.daemonHostId ?? 'mac-studio',
    sessionName: overrides.sessionName ?? '',
    authToken: overrides.authToken ?? 'token-a',
    authType: overrides.authType ?? 'password',
    password: overrides.password,
    privateKey: overrides.privateKey,
    autoCommand: overrides.autoCommand ?? '',
    tags: overrides.tags ?? ['tailscale'],
    pinned: overrides.pinned ?? false,
    lastConnected: overrides.lastConnected ?? 2,
    relayEndpointCandidates: overrides.relayEndpointCandidates ?? [],
  };
}

function makeActiveSession(overrides: Partial<ConnectionsHomeActiveSession> = {}): ConnectionsHomeActiveSession {
  return {
    id: overrides.id || 'session-live-a',
    title: overrides.title || 'zterm',
    connectionName: overrides.connectionName || 'Mac Studio Tailscale',
    bridgeHost: overrides.bridgeHost || '100.66.1.82',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId || 'mac-studio',
    sessionName: overrides.sessionName || 'zterm',
    state: overrides.state || 'connected',
    resolvedEndpoint: overrides.resolvedEndpoint,
    resolvedPath: overrides.resolvedPath,
    customName: overrides.customName,
  };
}

describe('ConnectionsPage server home', () => {
  afterEach(cleanup);

  it('shows configured servers and active sessions without embedding Relay login on Home', () => {
    const onResumeSession = vi.fn();
    const onOpenSavedConnection = vi.fn();
    const onOpenSettings = vi.fn();
    const savedHost = makeSavedHost();
    const activeSession = makeActiveSession();

    render(
      <ConnectionsPage
        savedConnections={[savedHost]}
        activeSessions={[activeSession]}
        activeSessionId={activeSession.id}
        onResumeSession={onResumeSession}
        onOpenSavedConnection={onOpenSavedConnection}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByTestId('connections-home')).toBeTruthy();
    expect(screen.getByTestId('connections-home-header')).toBeTruthy();
    expect(screen.getByTestId('active-session-list')).toBeTruthy();
    expect(screen.getByTestId('saved-connection-list')).toBeTruthy();
    expect(screen.getByText('Mac Studio Tailscale')).toBeTruthy();
    expect(screen.getByText('100.66.1.82:3333')).toBeTruthy();
    expect(screen.getAllByText('Tailscale').length).toBeGreaterThan(0);
    expect(screen.getByTestId('saved-connection-row')).toBeTruthy();
    expect(screen.getByTestId('active-session-row')).toBeTruthy();
    expect(screen.getByRole('button', { name: '设置和升级' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Configure servers' })).toBeTruthy();
    expect(screen.queryByLabelText('Relay account')).toBeNull();
    expect(screen.queryByLabelText('Relay password')).toBeNull();
    expect(screen.queryByTestId('relay-fixed-host')).toBeNull();
    expect(screen.queryByText('Relay routes')).toBeNull();
    expect(screen.queryByText('All servers')).toBeNull();
    expect(screen.queryByText('Open selected groups')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Resume zterm' }));
    expect(onResumeSession).toHaveBeenCalledWith(activeSession.id);
    fireEvent.click(screen.getByRole('button', { name: 'Open Mac Studio Tailscale' }));
    expect(onOpenSavedConnection).toHaveBeenCalledWith(savedHost);
    fireEvent.click(screen.getByRole('button', { name: 'Configure servers' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('opens a route-aware saved server row directly when it has relay-rtc candidates', () => {
    const onOpenSavedConnection = vi.fn();
    const savedHost = makeSavedHost({
      relayHostId: 'mac-studio',
      relayEndpointCandidates: [
        {
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale',
          host: 'mac-studio.tailnet.ts.net',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-16T10:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-16T10:00:00.000Z',
        },
      ],
    });

    render(
      <ConnectionsPage
        savedConnections={[savedHost]}
        onOpenSavedConnection={onOpenSavedConnection}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Tailscale')).toBeTruthy();
    expect(screen.queryByText('Relay 可用')).toBeNull();
    expect(screen.getByText('自动线路')).toBeTruthy();
    expect(screen.queryByTestId('saved-connection-relay-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Mac Studio Tailscale with Relay' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Mac Studio Tailscale' }));
    expect(onOpenSavedConnection).toHaveBeenCalledWith(savedHost);
  });

  it('renders a relay-only server row with daemon identity instead of an empty endpoint', () => {
    render(
      <ConnectionsPage
        savedConnections={[makeSavedHost({
          id: 'relay-device-a',
          name: 'Windows Office',
          bridgeHost: '',
          daemonHostId: 'windows-office',
          relayHostId: 'windows-office',
          bridgePort: 3333,
          tags: [],
          relayEndpointCandidates: [{
            id: 'relay-rtc:windows-office',
            kind: 'relay-rtc',
            relayHostId: 'windows-office',
            authRequired: true,
            lastSeenAt: '2026-07-16T10:00:00.000Z',
          }],
        })]}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Windows Office')).toBeTruthy();
    expect(screen.getByText('windows-office:3333')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy();
  });

  it('keeps Home useful when no server has been configured yet', () => {
    const onOpenSettings = vi.fn();
    render(<ConnectionsPage onOpenSettings={onOpenSettings} />);

    expect(screen.getByText('No configured servers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置和升级' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

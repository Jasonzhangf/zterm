// @vitest-environment jsdom

/**
 * Submodule tests: TerminalConnectionStatusStrip (client.app_shell).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
});
import { TerminalConnectionStatusStrip } from './TerminalConnectionStatusStrip';
import type { Session } from '../lib/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    connectionName: 'conn',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'shared',
    state: 'connected',
    ws: null,
    title: 'shared',
    ...overrides,
  } as Session;
}

describe('TerminalConnectionStatusStrip', () => {
  it('renders the connection route and session name projection', () => {
    render(
      <TerminalConnectionStatusStrip
        session={makeSession({ resolvedPath: 'rtc-direct' })}
        topInsetPx={0}
      />,
    );
    expect(screen.getByTestId('terminal-connection-status-strip')).toBeTruthy();
    expect(screen.getByTestId('terminal-connection-status-route').textContent).toContain('UDP');
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('shared');
  });

  it('renders nothing without a session', () => {
    const { container } = render(
      <TerminalConnectionStatusStrip session={null} topInsetPx={0} />,
    );
    expect(container.childNodes.length).toBe(0);
  });

  it('opens the route menu and emits transport override intents', () => {
    const onUseAutoSession = vi.fn();
    const onUseWebSocketSession = vi.fn();
    const onForceRelaySession = vi.fn();
    render(
      <TerminalConnectionStatusStrip
        session={makeSession()}
        topInsetPx={0}
        onUseAutoSession={onUseAutoSession}
        onUseWebSocketSession={onUseWebSocketSession}
        onForceRelaySession={onForceRelaySession}
      />,
    );
    fireEvent.click(screen.getByTestId('terminal-connection-status-strip'));
    fireEvent.click(screen.getByTestId('terminal-route-option-websocket'));
    expect(onUseWebSocketSession).toHaveBeenCalledWith('s1');
  });

  it('opens the rename dialog and emits the remote rename intent', async () => {
    const onRenameRemoteSession = vi.fn(async () => undefined);
    render(
      <TerminalConnectionStatusStrip
        session={makeSession()}
        topInsetPx={0}
        onRenameRemoteSession={onRenameRemoteSession}
      />,
    );
    fireEvent.click(screen.getByTestId('terminal-connection-status-session'));
    const input = await screen.findByTestId('rename-dialog-input');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(onRenameRemoteSession).toHaveBeenCalledWith('s1', 'renamed'));
  });

  it('surfaces remote rename failures without changing the projection', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRenameRemoteSession = vi.fn(async () => { throw new Error('rename failed'); });
    render(
      <TerminalConnectionStatusStrip
        session={makeSession()}
        topInsetPx={0}
        onRenameRemoteSession={onRenameRemoteSession}
      />,
    );
    fireEvent.click(screen.getByTestId('terminal-connection-status-session'));
    const input = await screen.findByTestId('rename-dialog-input');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('rename failed'));
    alertSpy.mockRestore();
  });
});

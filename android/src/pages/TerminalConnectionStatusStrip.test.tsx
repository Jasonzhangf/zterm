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

async function longPress(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, pointerId: 1 });
  await new Promise((resolve) => window.setTimeout(resolve, 550));
  fireEvent.pointerUp(element, { button: 0, pointerId: 1 });
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
    expect(screen.getByTestId('terminal-connection-status-backend').textContent).toBe('tmux');
  });

  it('keeps route, session, backend, and rates in the first portrait top row', () => {
    render(
      <TerminalConnectionStatusStrip
        session={makeSession({ terminalBackend: 'herdr' })}
        topInsetPx={0}
      />,
    );
    const strip = screen.getByTestId('terminal-connection-status-strip');
    expect(strip.style.top).toBe('8px');
    expect(strip.contains(screen.getByTestId('terminal-connection-status-route'))).toBe(true);
    expect(strip.contains(screen.getByTestId('terminal-connection-status-session'))).toBe(true);
    expect(strip.contains(screen.getByTestId('terminal-connection-status-backend'))).toBe(true);
    expect(strip.contains(screen.getByTestId('terminal-connection-status-rates'))).toBe(true);
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('shared');
    expect(screen.getByTestId('terminal-connection-status-backend').textContent).toBe('herdr');
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
    await longPress(screen.getByTestId('terminal-connection-status-session'));
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
    await longPress(screen.getByTestId('terminal-connection-status-session'));
    const input = await screen.findByTestId('rename-dialog-input');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }));
    await waitFor(() => expect(screen.getByTestId('rename-dialog-error').textContent).toContain('rename failed'));
    expect(screen.getByTestId('terminal-connection-status-session').textContent).toBe('shared');
    expect(screen.getByTestId('rename-dialog-input')).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

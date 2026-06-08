// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSlot } from './TerminalSlot';
import type { TerminalConnectionState } from '../lib/terminal-runtime';
import type { Host, TerminalRenderBufferProjection } from '@zterm/shared';

vi.mock('@zterm/shared', async () => {
  const actual = await vi.importActual<typeof import('@zterm/shared')>('@zterm/shared');
  return {
    ...actual,
    MacTerminalView: (props: { allowDomFocus?: boolean }) => (
      <div data-testid="mac-terminal-view" data-allow-dom-focus={props.allowDomFocus ? 'true' : 'false'} />
    ),
    formatBridgeSessionTarget: (target: { sessionName?: string; bridgeHost?: string; bridgePort?: number }) =>
      `${target.bridgeHost || 'local'}:${target.bridgePort || 3333}/${target.sessionName || 'main'}`,
  };
});

function projection(): TerminalRenderBufferProjection {
  return {
    lines: [],
    gapRanges: [],
    startIndex: 0,
    endIndex: 0,
    viewportEndIndex: 0,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    revision: 0,
  };
}

function host(): Host {
  return {
    id: 'host-1',
    createdAt: 0,
    name: 'Local daemon',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'zterm_mac_color',
    authType: 'password',
    tags: [],
    pinned: false,
  };
}

function session(): TerminalConnectionState {
  return {
    status: 'connected',
    connectedSessionId: 'session-1',
    activeTarget: host(),
    error: null,
  } as TerminalConnectionState;
}

afterEach(() => cleanup());

describe('TerminalSlot live surface', () => {
  it('gives MacTerminalView DOM focus and a flex terminal surface so input and bottom row stay visible', () => {
    const { container, getByTestId } = render(
      <TerminalSlot
        host={host()}
        session={session()}
        projection={projection()}
        isDetailsVisible={false}
        onInput={vi.fn()}
        onResize={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(container.querySelector('.slot-stack.terminal-slot-shell')).toBeTruthy();
    expect(container.querySelector('.terminal-surface-shell')).toBeTruthy();
    expect(container.querySelector('.terminal-surface.live')).toBeTruthy();
    expect(getByTestId('mac-terminal-view')).toHaveAttribute('data-allow-dom-focus', 'true');
  });
});

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionViewportModeStore } from '../lib/session-viewport-mode-store';
import type { Session } from '../lib/types';
import { TerminalDebugOverlay } from './TerminalPageDebugOverlay';

function makeSession(): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'conn-1',
    bridgeHost: '100.0.0.1',
    bridgePort: 3333,
    sessionName: 'tmux-main',
    title: 'main-shell',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    resolvedPath: 'rtc-relay',
    resolvedRelayTransport: 'turn',
    lastConnectStage: 'connect-sent',
    selectedIcePair: {
      local: {
        candidateType: 'relay',
        address: '159.75.134.56',
        port: 49152,
        protocol: 'udp',
      },
      remote: {
        candidateType: 'srflx',
        address: '120.229.11.244',
        port: 52000,
        protocol: 'udp',
      },
      roundTripTimeMs: 91,
    },
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

describe('TerminalDebugOverlay', () => {
  it('renders only the compact switch-troubleshooting fields', () => {
    const session = makeSession();
    const sessionViewportModeStore = createSessionViewportModeStore();
    sessionViewportModeStore.setMode(session.id, 'reading');

    const debugOverlayDragRef = {
      current: {
        startX: 0,
        startY: 0,
        startPosX: 0,
        startPosY: 0,
        dragging: false,
      },
    } as MutableRefObject<{
      startX: number;
      startY: number;
      startPosX: number;
      startPosY: number;
      dragging: boolean;
    }>;

    render(
      <TerminalDebugOverlay
        visible
        session={session}
        visiblePaneSessions={[session]}
        sessionViewportModeStore={sessionViewportModeStore}
        getSessionDebugMetrics={() => ({
          uplinkBps: 1024,
          downlinkBps: 2048,
          renderHz: 3,
          pullHz: 4,
          transportBufferedBytes: 512,
          transportBackpressured: false,
          lastRenderCommitAt: 0,
          bufferPullActive: true,
          status: 'refreshing',
          active: true,
          updatedAt: 1,
        })}
        debugOverlayPos={{ x: 0, y: 0 }}
        debugOverlayDragRef={debugOverlayDragRef}
        onClose={vi.fn()}
        onMove={vi.fn()}
        keyboardInset={24}
        shellHeight={360}
        rawShellHeight={400}
        visualViewportHeight={320}
        visualViewportWidth={200}
        visualViewportOffsetTop={8}
        currentLayoutViewportHeight={288}
        terminalKeyboardRequested
        keyboardViewportAlreadyResized
        containerHeightPx={280}
        viewportRows={24}
        copyModeActive
        copyStartRowIndex={12}
        effectiveKeyboardLiftPx={16}
        terminalImeLiftPx={10}
        quickBarShellKeyboardLiftPx={6}
        quickBarHeight={48}
        terminalChromeBottomPx={96}
        layoutMode="mirror-fixed"
        landscape
        splitVisible
        quickBarCollapsed
        copySelection={{ active: true, sessionId: session.id, startRowIndex: 12, endRowIndex: 18, menu: null }}
        sessionDrawerDebug={{ open: true, lastEvent: 'switch', eventSeq: 7, callbackSeq: 2, pageCallbackSeq: 5, pickerMode: 'relay' }}
        getRemoteWindowInputDebug={() => ({
          contextActive: true,
          contextLabel: 'app-window/os-event',
          sessionId: 'session-1',
          streamId: 'stream-1',
          targetId: 'target-1',
          inputRoute: 'os-event',
          focusPolicy: 'bring-to-focus',
          lastSource: 'overlay',
          lastEvent: 'click #1 primary',
          lastSent: true,
          lastAt: Date.now(),
          lastPoint: '10,20 n=0.10,0.20',
          lastResult: 'accepted',
          lastResultAt: Date.now(),
          counts: {
            focus: 0,
            pointerDown: 0,
            pointerMove: 0,
            pointerUp: 0,
            click: 1,
            scroll: 0,
            key: 0,
            text: 0,
            accepted: 1,
            error: 0,
          },
          video: 'aY · vY · r4',
        })}
      />,
    );

    expect(screen.getAllByText('状态').length).toBeGreaterThan(1);
    expect(screen.getByText('main-shell · session-1')).toBeTruthy();
    expect(screen.getByText('connected / refreshing · A')).toBeTruthy();
    expect(screen.getByText('reading')).toBeTruthy();
    expect(screen.getByText('rtc-relay / turn / connect-sent')).toBeTruthy();
    expect(screen.getByText('L relay 159.75.134.56:49152 /udp / R srflx 120.229.11.244:52000 /udp · 91ms')).toBeTruthy();
    expect(screen.getByTestId('terminal-debug-remote-window-context').textContent).toContain('app-window/os-event');
    expect(screen.getByTestId('terminal-debug-remote-window-event').textContent).toContain('SEND Y');
    expect(screen.getByTestId('terminal-debug-remote-window-result').textContent).toContain('accepted');
    expect(screen.getByText('3.0 Hz / 4.0 Hz')).toBeTruthy();
    expect(screen.getByText(/1\.0 KB\/s/)).toBeTruthy();
    expect(screen.getByText(/buf 512 B/)).toBeTruthy();
    expect(screen.queryByText('SCR')).toBeNull();
    expect(screen.queryByText('DPR')).toBeNull();
    expect(screen.queryByText('BUF')).toBeNull();
    expect(screen.queryByText('LC')).toBeNull();
  });
});

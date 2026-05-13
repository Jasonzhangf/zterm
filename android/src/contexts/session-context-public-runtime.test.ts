// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';
import { updateSessionViewportRuntime } from './session-context-public-runtime';

function makeSession(sessionId: string): Session {
  return {
    id: sessionId,
    hostId: `host-${sessionId}`,
    connectionName: `conn-${sessionId}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `tmux-${sessionId}`,
    title: sessionId,
    ws: null,
    state: 'connected',
    hasUnread: false,
    buffer: createSessionBufferState({
      lines: Array.from({ length: 24 }, (_, index) => `row-${96 + index}`),
      startIndex: 96,
      endIndex: 120,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
      cols: 80,
      rows: 24,
      revision: 5,
      cacheLines: 1000,
    }),
    daemonHeadRevision: 5,
    daemonHeadEndIndex: 120,
    createdAt: 1,
  };
}

describe('session-context-public-runtime', () => {
  it('requests visible-range repair when follow viewport expands upward beyond the current local window', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const requestSessionBufferSync = vi.fn(() => true);

    updateSessionViewportRuntime({
      sessionId,
      visibleRange: {
        startIndex: 80,
        endIndex: 120,
        viewportRows: 40,
      },
      triggerRepair: false,
      viewportMode: 'follow',
      sessionVisibleRangeRef: {
        current: new Map([
          [sessionId, {
            startIndex: 96,
            endIndex: 120,
            viewportRows: 24,
          }],
        ]),
      },
      isSessionTransportActive: () => true,
      sessions: [session],
      sessionBufferHeadsRef: { current: new Map() },
      readSessionBufferSnapshot: () => session.buffer,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, {
      reason: 'viewport-visible-range-demand',
      purpose: 'reading-repair',
      requestWindowOverride: { requestStartIndex: 80, requestEndIndex: 120 },
      requestMissingRangesOverride: [{ startIndex: 80, endIndex: 96 }],
      sessionOverride: session,
    });
  });

  it('does not request repair when follow viewport change does not expand beyond the previous visible range', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const requestSessionBufferSync = vi.fn(() => true);

    updateSessionViewportRuntime({
      sessionId,
      visibleRange: {
        startIndex: 97,
        endIndex: 121,
        viewportRows: 24,
      },
      triggerRepair: false,
      viewportMode: 'follow',
      sessionVisibleRangeRef: {
        current: new Map([
          [sessionId, {
            startIndex: 96,
            endIndex: 120,
            viewportRows: 24,
          }],
        ]),
      },
      isSessionTransportActive: () => true,
      sessions: [session],
      sessionBufferHeadsRef: { current: new Map() },
      readSessionBufferSnapshot: () => session.buffer,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).not.toHaveBeenCalled();
  });

  it('requests visible-range repair when follow viewport expands upward over stale rows even if local buffer still covers the old smaller follow window', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const requestSessionBufferSync = vi.fn(() => true);

    updateSessionViewportRuntime({
      sessionId,
      visibleRange: {
        startIndex: 80,
        endIndex: 120,
        viewportRows: 40,
      },
      triggerRepair: false,
      viewportMode: 'follow',
      sessionVisibleRangeRef: {
        current: new Map([
          [sessionId, {
            startIndex: 96,
            endIndex: 120,
            viewportRows: 24,
          }],
        ]),
      },
      isSessionTransportActive: () => true,
      sessions: [session],
      sessionBufferHeadsRef: {
        current: new Map([
          [sessionId, {
            revision: 6,
            latestEndIndex: 120,
            availableStartIndex: 0,
            availableEndIndex: 120,
            seenAt: 1,
          }],
        ]),
      },
      readSessionBufferSnapshot: () => session.buffer,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, {
      reason: 'viewport-visible-range-demand',
      purpose: 'reading-repair',
      requestWindowOverride: { requestStartIndex: 80, requestEndIndex: 120 },
      requestMissingRangesOverride: [{ startIndex: 80, endIndex: 96 }],
      sessionOverride: session,
    });
  });

  it('requests visible-range repair when follow viewport expands upward over already-filled local rows that may be stale from a narrower tail repaint', () => {
    const sessionId = 'session-1';
    const session: Session = {
      ...makeSession(sessionId),
      buffer: createSessionBufferState({
        lines: Array.from({ length: 40 }, (_, index) => `row-${80 + index}`),
        startIndex: 80,
        endIndex: 120,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 120,
        cols: 80,
        rows: 40,
        revision: 6,
        cacheLines: 1000,
      }),
      daemonHeadRevision: 6,
      daemonHeadEndIndex: 120,
    };
    const requestSessionBufferSync = vi.fn(() => true);

    updateSessionViewportRuntime({
      sessionId,
      visibleRange: {
        startIndex: 80,
        endIndex: 120,
        viewportRows: 40,
      },
      triggerRepair: false,
      viewportMode: 'follow',
      sessionVisibleRangeRef: {
        current: new Map([
          [sessionId, {
            startIndex: 96,
            endIndex: 120,
            viewportRows: 24,
          }],
        ]),
      },
      isSessionTransportActive: () => true,
      sessions: [session],
      sessionBufferHeadsRef: {
        current: new Map([
          [sessionId, {
            revision: 6,
            latestEndIndex: 120,
            availableStartIndex: 0,
            availableEndIndex: 120,
            seenAt: 1,
          }],
        ]),
      },
      readSessionBufferSnapshot: () => session.buffer,
      requestSessionBufferSync,
    });

    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, {
      reason: 'viewport-visible-range-demand',
      purpose: 'reading-repair',
      requestWindowOverride: { requestStartIndex: 80, requestEndIndex: 120 },
      requestMissingRangesOverride: [{ startIndex: 80, endIndex: 96 }],
      sessionOverride: session,
    });
  });
});

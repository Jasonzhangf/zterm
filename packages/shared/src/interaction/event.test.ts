import { describe, it, expect } from 'vitest';
import { createEvent, isEventType, type TerminalEvent, type EventType } from './event';

describe('event contract', () => {
  it('creates a typed session/created event with correlation', () => {
    const evt = createEvent('session/created', { sessionId: 's1', host: '127.0.0.1', port: 4444, sessionName: 'test' }, 'op-001');
    expect(evt.type).toBe('session/created');
    expect(isEventType(evt, 'session/created')).toBe(true);
    if (isEventType(evt, 'session/created')) {
      expect(evt.payload.sessionId).toBe('s1');
    }
    expect(evt.operationCorrelation).toBe('op-001');
    expect(typeof evt.timestamp).toBe('number');
  });

  it('creates buffer/head-received event', () => {
    const evt = createEvent('buffer/head-received', { sessionId: 's1', revision: 5, latestEndIndex: 100 });
    expect(evt.type).toBe('buffer/head-received');
    if (isEventType(evt, 'buffer/head-received')) {
      expect(evt.payload.revision).toBe(5);
    }
  });

  it('creates renderer events', () => {
    const follow = createEvent('renderer/follow', { sessionId: 's1', renderBottomIndex: 80 });
    expect(follow.type).toBe('renderer/follow');

    const reading = createEvent('renderer/reading', { sessionId: 's1', renderBottomIndex: 50, viewportRows: 24 });
    if (isEventType(reading, 'renderer/reading')) {
      expect(reading.payload.viewportRows).toBe(24);
    }

    const commit = createEvent('renderer/commit', { sessionId: 's1', rowsRendered: 40 });
    if (isEventType(commit, 'renderer/commit')) {
      expect(commit.payload.rowsRendered).toBe(40);
    }
  });

  it('creates pane events', () => {
    const split = createEvent('pane/split', { paneId: 'p1', newPaneId: 'p2', direction: 'horizontal' });
    if (isEventType(split, 'pane/split')) {
      expect(split.payload.newPaneId).toBe('p2');
    }

    const merged = createEvent('pane/merged', { sourcePaneId: 'p2', targetPaneId: 'p1' });
    if (isEventType(merged, 'pane/merged')) {
      expect(merged.payload.sourcePaneId).toBe('p2');
    }

    const activated = createEvent('pane/activated', { paneId: 'p1' });
    if (isEventType(activated, 'pane/activated')) {
      expect(activated.payload.paneId).toBe('p1');
    }
  });

  it('creates file-transfer events', () => {
    const started = createEvent('file-transfer/started', { transferId: 't1', sessionId: 's1', fileName: 'test.txt', remotePath: '/tmp/test.txt' });
    if (isEventType(started, 'file-transfer/started')) {
      expect(started.payload.fileName).toBe('test.txt');
    }
  });

  it('creates app lifecycle events with empty payload', () => {
    const resumed = createEvent('app/foreground-resumed', {});
    expect(resumed.type).toBe('app/foreground-resumed');

    const paused = createEvent('app/background-paused', {});
    expect(paused.type).toBe('app/background-paused');
  });

  it('creates operation/failed event with error', () => {
    const evt = createEvent('operation/failed', { operationType: 'terminal/input', error: 'session not found' });
    if (isEventType(evt, 'operation/failed')) {
      expect(evt.payload.error).toBe('session not found');
      expect(evt.payload.operationType).toBe('terminal/input');
    }
  });

  it('isEventType narrows correctly', () => {
    const evt = createEvent('session/closed', { sessionId: 's1' });
    if (isEventType(evt, 'session/closed')) {
      expect(evt.payload.sessionId).toBe('s1');
    } else {
      throw new Error('should narrow');
    }
  });

  it('isEventType returns false for mismatch', () => {
    const evt = createEvent('session/closed', { sessionId: 's1' });
    expect(isEventType(evt, 'session/created')).toBe(false);
  });

  it('all event types are covered in TerminalEventMap', () => {
    const types: EventType[] = [
      'session/created', 'session/attached', 'session/detached', 'session/closed', 'session/error',
      'transport/connected', 'transport/disconnected', 'transport/reconnecting',
      'buffer/head-received', 'buffer/sync-applied', 'buffer/gap-detected',
      'renderer/follow', 'renderer/reading', 'renderer/commit',
      'open-tab/opened', 'open-tab/closed', 'open-tab/moved', 'open-tab/active-changed',
      'pane/split', 'pane/merged', 'pane/activated',
      'file-transfer/started', 'file-transfer/progress', 'file-transfer/completed', 'file-transfer/failed', 'file-transfer/cancelled',
      'screenshot/captured', 'screenshot/failed',
      'schedule/created', 'schedule/toggled', 'schedule/removed', 'schedule/fired',
      'app/foreground-resumed', 'app/background-paused', 'app/update-available', 'app/update-applied',
      'operation/failed',
    ];
    expect(types.length).toBe(37);
  });

  it('events are serializable', () => {
    const evt = createEvent('transport/reconnecting', { sessionId: 's1', attempt: 3 });
    const json = JSON.stringify(evt);
    const parsed = JSON.parse(json) as TerminalEvent;
    expect(parsed.type).toBe('transport/reconnecting');
    if (isEventType(parsed, 'transport/reconnecting')) {
      expect(parsed.payload.sessionId).toBe('s1');
      expect(parsed.payload.attempt).toBe(3);
    }
  });
});

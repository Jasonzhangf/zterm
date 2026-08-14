import { describe, expect, it, vi } from 'vitest';
import { createHerdrBackendRuntime, mapHerdrCanonicalSnapshot } from './herdr-backend-runtime';
import type { HerdrCanonicalSnapshot } from './herdr-frame-canonicalizer';

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);

function snapshot(overrides: Partial<HerdrCanonicalSnapshot> = {}): HerdrCanonicalSnapshot {
  return {
    ztermRevision: 7,
    attachmentSeq: 12,
    full: false,
    cols: 80,
    rows: 2,
    bufferLines: [[
      { char: 65, fg: 1, bg: 256, flags: 0, width: 1 },
      { char: 32, fg: 256, bg: 256, flags: 0, width: 1 },
    ]],
    cursor: { rowIndex: 100, col: 1, visible: true },
    localCursor: { row: 0, col: 1, visible: true },
    cursorKeysApp: true,
    alternateScreen: false,
    scrollbackCount: 0,
    absoluteRange: {
      startIndex: 100,
      endIndex: 101,
      availableStartIndex: 100,
      availableEndIndex: 101,
      origin: 'herdr-canonicalizer-scrollback',
    },
    capabilityGaps: [],
    ...overrides,
  };
}

describe('Herdr backend runtime mirror projection', () => {
  it('enumerates every running official Herdr session without a zterm name filter', () => {
    childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
      if (args.join(' ') === 'session list --json') {
        return JSON.stringify({ sessions: [
          { name: 'hd-codex', running: true },
          { name: 'manual-project', running: true },
          { name: 'stopped-project', running: false },
        ] });
      }
      if (args[args.length - 2] === 'pane' && args[args.length - 1] === 'list') {
        return JSON.stringify({ result: { panes: [{ terminal_id: 'terminal-1', pane_id: 'pane-1' }] } });
      }
      throw new Error(`unexpected Herdr command: ${args.join(' ')}`);
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });

    expect(runtime.listSessions().map((session) => session.sessionName)).toEqual([
      'hd-codex',
      'manual-project',
    ]);
  });

  it('removes externally stopped sessions on the next authoritative enumeration', () => {
    let listed = [{ name: 'manual-project', running: true }];
    childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
      if (args.join(' ') === 'session list --json') return JSON.stringify({ sessions: listed });
      if (args[args.length - 2] === 'pane' && args[args.length - 1] === 'list') {
        return JSON.stringify({ result: { panes: [{ terminal_id: 'terminal-1', pane_id: 'pane-1' }] } });
      }
      throw new Error(`unexpected Herdr command: ${args.join(' ')}`);
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    const sessions = runtime.listSessions();
    expect(sessions.map((session) => session.sessionName)).toEqual(['manual-project']);
    expect(sessions[0]).not.toHaveProperty('workspace');
    listed = [];
    expect(runtime.listSessions()).toEqual([]);
  });

  it('projects canonical rows, range owner, cursor, geometry, and zterm revision without remapping seq', () => {
    const mapped = mapHerdrCanonicalSnapshot(snapshot());

    expect(mapped).toEqual({
      revision: 7,
      bufferStartIndex: 100,
      bufferLines: snapshot().bufferLines,
      cols: 80,
      rows: 2,
      cursorKeysApp: true,
      cursor: { rowIndex: 100, col: 1, visible: true },
    });
    expect(mapped.revision).not.toBe(snapshot().attachmentSeq);
  });

  it('fails explicitly when canonicalizer did not provide an absolute range', () => {
    expect(() => mapHerdrCanonicalSnapshot(snapshot({ absoluteRange: null }))).toThrow(
      'Herdr absolute range unavailable; refusing to publish a fabricated mirror range',
    );
  });

  it('fails explicitly when the absolute range does not cover the canonical body', () => {
    expect(() => mapHerdrCanonicalSnapshot(snapshot({
      absoluteRange: {
        startIndex: 100,
        endIndex: 102,
        availableStartIndex: 100,
        availableEndIndex: 102,
        origin: 'herdr-canonicalizer-scrollback',
      },
    }))).toThrow('Herdr canonical absolute range does not cover the canonical buffer body');
  });

  it('trims the canonical VT scrollback at the mirror edge while preserving absolute range identity', () => {
    const mapped = mapHerdrCanonicalSnapshot({
      ...snapshot(),
      absoluteRange: {
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        origin: 'herdr-canonicalizer-scrollback',
      },
      bufferLines: [
        [{ char: 1, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 2, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 3, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 4, fg: 256, bg: 256, flags: 0, width: 1 }],
      ],
      cursor: { rowIndex: 103, col: 1, visible: true },
    }, 2);

    expect(mapped.bufferStartIndex).toBe(102);
    expect(mapped.bufferLines.map((line) => line[0]?.char)).toEqual([3, 4]);
    expect(mapped.cursor).toEqual({ rowIndex: 103, col: 1, visible: true });
    expect(mapped.revision).toBe(snapshot().ztermRevision);
  });

  it('fails explicitly when a bounded mirror window would drop the canonical cursor', () => {
    expect(() => mapHerdrCanonicalSnapshot({
      ...snapshot({
        bufferLines: [
          [{ char: 1, fg: 256, bg: 256, flags: 0, width: 1 }],
          [{ char: 2, fg: 256, bg: 256, flags: 0, width: 1 }],
        ],
        cursor: { rowIndex: 0, col: 0, visible: true },
        absoluteRange: {
          startIndex: 0,
          endIndex: 2,
          availableStartIndex: 0,
          availableEndIndex: 2,
          origin: 'herdr-canonicalizer-scrollback',
        },
      }),
    }, 1)).toThrow('Herdr canonical cursor falls outside the bounded mirror window');
  });

});

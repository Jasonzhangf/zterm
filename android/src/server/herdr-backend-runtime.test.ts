import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCell } from '@zterm/shared/types';
import {
  advanceHerdrHistoryLiveTailWindow,
  createHerdrBackendRuntime,
  type HerdrHistorySnapshot,
} from './herdr-backend-runtime';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';
import type {
  HerdrCanonicalSnapshot,
  HerdrScrollMetrics,
  HerdrTerminalFrame,
} from './herdr-frame-canonicalizer';

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);
vi.mock('./mirror-line-canonicalizer', () => ({
  canonicalizeCapturedMirrorLines: vi.fn(),
}));

let herdrFrameSeq = 0;
function buildHerdrFrame(overrides: Partial<HerdrTerminalFrame> = {}): HerdrTerminalFrame {
  herdrFrameSeq += 1;
  return {
    type: 'terminal.frame',
    bytes: Buffer.from('LIVE_TAIL_1\nLIVE_TAIL_2\n', 'utf8').toString('base64'),
    seq: herdrFrameSeq,
    full: true,
    width: 80,
    height: 24,
    scroll: {
      maxOffsetFromBottom: 401,
      offsetFromBottom: 0,
      viewportRows: 24,
    },
    ...overrides,
  };
}

function createMockProcess(options: {
  emitFrame?: boolean;
  frame?: HerdrTerminalFrame;
  onFrameHandler?: (send: (frame?: HerdrTerminalFrame) => void) => void;
} = {}) {
  return {
    unref: vi.fn(),
    killed: false,
    exitCode: null,
    pid: 1234,
    kill: vi.fn(),
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((_event: string, handler: (chunk: string) => void) => {
        if (_event === 'data') {
          const send = (frame?: HerdrTerminalFrame) => {
            handler(`${JSON.stringify(frame ?? options.frame ?? buildHerdrFrame())}\n`);
          };
          if (options.emitFrame) {
            queueMicrotask(() => send());
          }
          options.onFrameHandler?.(send);
        }
      }),
    },
    stderr: {
      setEncoding: vi.fn(),
      on: vi.fn(),
    },
    stdin: {
      writable: true,
      write: vi.fn(),
    },
  };
}

function createMockHerdrRuntime(options: {
  paneReadOutput?: string;
  paneReadError?: Error;
  maxMirrorLines?: number;
  scroll?: HerdrScrollMetrics;
  scrollError?: Error;
  frameOverrides?: Partial<HerdrTerminalFrame>;
  onLiveActivity?: (sessionName: string) => void;
} = {}) {
  let paneReadCalls = 0;
  const state = {
    paneReadOutput: options.paneReadOutput ?? 'HISTORY_1\n',
    scroll: options.scroll || {
      maxOffsetFromBottom: 401,
      offsetFromBottom: 0,
      viewportRows: 24,
    },
    scrollError: options.scrollError,
  };
  const frameEmitters: Array<(frame?: HerdrTerminalFrame) => void> = [];
  childProcessMocks.spawn.mockImplementation((_executable: string, args: string[]) => {
    if (args.some((arg) => arg === 'control')) {
      return createMockProcess({
        emitFrame: true,
        frame: buildHerdrFrame(options.frameOverrides),
        onFrameHandler: (send) => frameEmitters.push(send),
      });
    }
    return createMockProcess();
  });
  childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
    const joined = args.join(' ');
    if (args[args.length - 2] === 'pane' && args[args.length - 1] === 'list') {
      return JSON.stringify({ result: { panes: [{ terminal_id: 'terminal-1', pane_id: 'pane-1' }] } });
    }
    if (args[args.length - 2] === 'api' && args[args.length - 1] === 'snapshot') {
      return JSON.stringify({
        result: {
          snapshot: {
            layouts: [{
              panes: [{ pane_id: 'pane-1', rect: { x: 0, y: 0, width: 80, height: 24 } }],
            }],
          },
        },
      });
    }
    if (joined.includes('pane get')) {
      if (state.scrollError) {
        throw state.scrollError;
      }
      return JSON.stringify({
        result: {
          pane: {
            scroll: {
              max_offset_from_bottom: state.scroll.maxOffsetFromBottom,
              offset_from_bottom: state.scroll.offsetFromBottom,
              viewport_rows: state.scroll.viewportRows,
            },
          },
        },
      });
    }
    if (joined.includes('pane read')) {
      paneReadCalls += 1;
      if (options.paneReadError) {
        throw options.paneReadError;
      }
      return state.paneReadOutput;
    }
    throw new Error(`unexpected Herdr command: ${joined}`);
  });
  const runtime = createHerdrBackendRuntime({
    executable: 'herdr',
    maxMirrorLines: options.maxMirrorLines,
    onLiveActivity: options.onLiveActivity,
  });
  return {
    runtime,
    paneReadCalls: () => paneReadCalls,
    emitFrame: (frame?: HerdrTerminalFrame) => {
      for (const send of frameEmitters) {
        send(frame);
      }
    },
    setPaneReadOutput: (value: string) => {
      state.paneReadOutput = value;
    },
    setScrollError: (value: Error | undefined) => {
      state.scrollError = value;
    },
    setScroll: (value: HerdrScrollMetrics) => {
      state.scroll = value;
    },
  };
}

function rowText(row: Array<{ char: number; width: number }>) {
  return row
    .filter((cell) => cell.width !== 0)
    .map((cell) => String.fromCodePoint(cell.char))
    .join('')
    .replace(/\s+$/u, '');
}

function cellsFromText(text: string): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0)!,
    fg: 7,
    bg: 0,
    flags: 0,
    width: 1,
  }));
}

describe('Herdr backend runtime mirror projection', () => {
  beforeEach(() => {
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.spawn.mockReset();
    vi.mocked(canonicalizeCapturedMirrorLines).mockReset();
    vi.mocked(canonicalizeCapturedMirrorLines).mockImplementation(
      async (lines: string[]) => lines.map(cellsFromText),
    );
  });

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
      if (args[args.length - 2] === 'api' && args[args.length - 1] === 'snapshot') {
        return JSON.stringify({
          result: {
            snapshot: {
              layouts: [{
                panes: [{ pane_id: 'pane-1', rect: { x: 0, y: 0, width: 120, height: 90 } }],
              }],
            },
          },
        });
      }
      throw new Error(`unexpected Herdr command: ${args.join(' ')}`);
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });

    expect(runtime.listSessions().map((session) => session.sessionName)).toEqual([
      'hd-codex',
      'manual-project',
    ]);
  });

  it('reads existing pane geometry from layout rect and ignores stale viewport rows', async () => {
    childProcessMocks.spawn.mockImplementation(() => createMockProcess());
    childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
      if (args.join(' ') === 'session list --json') {
        return JSON.stringify({ sessions: [{ name: 'hd-codex', running: true }] });
      }
      if (args[args.length - 2] === 'pane' && args[args.length - 1] === 'list') {
        return JSON.stringify({ result: { panes: [{ terminal_id: 'terminal-1', pane_id: 'pane-1' }] } });
      }
      if (args[args.length - 2] === 'api' && args[args.length - 1] === 'snapshot') {
        return JSON.stringify({
          result: {
            snapshot: {
              panes: [{ pane_id: 'pane-1', scroll: { viewport_rows: 24 } }],
              layouts: [{
                panes: [{ pane_id: 'pane-1', rect: { x: 26, y: 1, width: 242, height: 113 } }],
              }],
            },
          },
        });
      }
      throw new Error(`unexpected Herdr command: ${args.join(' ')}`);
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    expect(runtime.listSessions()[0]).toMatchObject({ cols: 242, rows: 113 });

    const pendingSnapshot = runtime.readSnapshot('hd-codex');
    await vi.waitFor(() => {
      expect(childProcessMocks.spawn).toHaveBeenCalledWith(
        'herdr',
        expect.arrayContaining(['--cols', '242', '--rows', '113']),
        expect.any(Object),
      );
    });
    void pendingSnapshot.catch(() => undefined);
  });

  it('uses the Herdr-created workspace geometry without a zterm geometry policy', () => {
    childProcessMocks.spawn.mockImplementation(() => createMockProcess());
    let snapshotCalls = 0;
    childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
      if (args[args.length - 2] === 'api' && args[args.length - 1] === 'snapshot') {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return JSON.stringify({ result: {} });
        return JSON.stringify({
          result: {
            snapshot: {
              layouts: [{
                panes: [{ pane_id: 'pane-created', rect: { x: 0, y: 0, width: 111, height: 80 } }],
              }],
            },
          },
        });
      }
      if (args.includes('workspace') && args.includes('create')) {
        return JSON.stringify({
          result: {
            root_pane: {
              terminal_id: 'terminal-created',
              pane_id: 'pane-created',
              cwd: '/tmp',
            },
          },
        });
      }
      throw new Error(`unexpected Herdr command: ${args.join(' ')}`);
    });

    const runtime = createHerdrBackendRuntime({ executable: 'herdr' });
    expect(runtime.createSession({ sessionName: 'manual-project', cwd: '/tmp' })).toMatchObject({
      cols: 111,
      rows: 80,
    });
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      'herdr',
      expect.arrayContaining(['workspace', 'create', '--cwd', '/tmp', '--no-focus']),
      expect.any(Object),
    );
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalledWith(
      'herdr',
      expect.arrayContaining(['workspace', 'create', '--cols', '80', '--rows', '80']),
      expect.any(Object),
    );
  });

  it('removes externally stopped sessions on the next authoritative enumeration', () => {
    let listed = [{ name: 'manual-project', running: true }];
    childProcessMocks.execFileSync.mockImplementation((_executable: string, args: string[]) => {
      if (args.join(' ') === 'session list --json') return JSON.stringify({ sessions: listed });
      if (args[args.length - 2] === 'pane' && args[args.length - 1] === 'list') {
        return JSON.stringify({ result: { panes: [{ terminal_id: 'terminal-1', pane_id: 'pane-1' }] } });
      }
      if (args[args.length - 2] === 'api' && args[args.length - 1] === 'snapshot') {
        return JSON.stringify({
          result: {
            snapshot: {
              layouts: [{
                panes: [{ pane_id: 'pane-1', rect: { x: 0, y: 0, width: 70, height: 24 } }],
              }],
            },
          },
        });
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

  it('publishes pane read recent history instead of the canonicalizer frame-only window', async () => {
    const paneReadOutput = `${Array.from({ length: 402 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime } = createMockHerdrRuntime({
      paneReadOutput,
      scroll: { maxOffsetFromBottom: 378, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 378, offsetFromBottom: 0, viewportRows: 24 },
      },
    });

    const snapshot = await runtime.readSnapshot('hd-codex');

    expect(snapshot.bufferLines).toHaveLength(402);
    expect(snapshot.bufferStartIndex).toBe(0);
    expect(snapshot.availableStartIndex).toBe(0);
    expect(snapshot.availableEndIndex).toBe(402);
    expect(snapshot.totalAvailableLines).toBe(402);
    expect(snapshot.capabilityGaps).toEqual(['herdr-history-limit-1000']);
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      'herdr',
      expect.arrayContaining([
        'pane', 'read', 'pane-1',
        '--source', 'recent', '--lines', '1000',
        '--format', 'ansi', '--raw',
      ]),
      expect.any(Object),
    );
  });

  it('uses a 1000-line window with a monotonic daemon start when Herdr has more history', async () => {
    const paneReadOutput = `${Array.from({ length: 1000 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime } = createMockHerdrRuntime({
      paneReadOutput,
      scroll: { maxOffsetFromBottom: 4976, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 4976, offsetFromBottom: 0, viewportRows: 24 },
      },
    });

    const snapshot = await runtime.readSnapshot('hd-codex');

    expect(snapshot.bufferLines).toHaveLength(1000);
    expect(snapshot.bufferStartIndex).toBe(4000);
    expect(snapshot.availableStartIndex).toBe(4000);
    expect(snapshot.availableEndIndex).toBe(5000);
    expect(snapshot.totalAvailableLines).toBe(5000);
  });

  it('overlays the canonical live visible tail when the host is at the bottom', async () => {
    const paneReadOutput = `${Array.from({ length: 402 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime } = createMockHerdrRuntime({
      paneReadOutput,
      scroll: { maxOffsetFromBottom: 378, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 378, offsetFromBottom: 0, viewportRows: 24 },
      },
    });

    const snapshot = await runtime.readSnapshot('hd-codex');
    const overlayText = snapshot.bufferLines.slice(-24, -22).map(rowText);

    expect(overlayText[0]).toBe('LIVE_TAIL_1');
    expect(overlayText[1]).toContain('LIVE_TAIL_2');
    expect(snapshot.cursor).not.toBeNull();
    expect(snapshot.cursor!.rowIndex).toBeGreaterThanOrEqual(378);
    expect(snapshot.cursor!.rowIndex).toBeLessThan(402);
  });

  it('advances the live tail window when authoritative total growth fits the visible frame', () => {
    const history: HerdrHistorySnapshot = {
      bufferLines: Array.from({ length: 100 }, (_, index) => cellsFromText(`OLD_${index}`)),
      sourceEndIndex: 100,
      cols: 80,
      rows: 24,
      refreshedAt: 0,
    };
    const live: HerdrCanonicalSnapshot = {
      ztermRevision: 2,
      attachmentSeq: 2,
      full: true,
      cols: 80,
      rows: 24,
      bufferLines: Array.from({ length: 24 }, (_, index) => cellsFromText(`LIVE_${index}`)),
      cursor: null,
      localCursor: { row: 23, col: 0, visible: true },
      cursorKeysApp: false,
      alternateScreen: false,
      scrollbackCount: 86,
      absoluteRange: null,
      capabilityGaps: [],
      scrollMetrics: { maxOffsetFromBottom: 86, offsetFromBottom: 0, viewportRows: 24 },
    };

    const merged = advanceHerdrHistoryLiveTailWindow(history, live);

    expect(merged.canOverlay).toBe(true);
    expect(merged.sourceEndIndex).toBe(110);
    expect(merged.bufferLines).toHaveLength(100);
    expect(rowText(merged.bufferLines[0])).toBe('OLD_10');
    expect(merged.bufferLines.slice(-24).map(rowText)).toEqual(
      Array.from({ length: 24 }, (_, index) => `LIVE_${index}`),
    );
  });

  it('suppresses the live overlay instead of publishing a gap when growth exceeds the visible frame', () => {
    const history: HerdrHistorySnapshot = {
      bufferLines: Array.from({ length: 100 }, (_, index) => cellsFromText(`OLD_${index}`)),
      sourceEndIndex: 100,
      cols: 80,
      rows: 24,
      refreshedAt: 0,
    };
    const live: HerdrCanonicalSnapshot = {
      ztermRevision: 2,
      attachmentSeq: 2,
      full: true,
      cols: 80,
      rows: 24,
      bufferLines: Array.from({ length: 24 }, (_, index) => cellsFromText(`LIVE_${index}`)),
      cursor: null,
      localCursor: { row: 23, col: 0, visible: true },
      cursorKeysApp: false,
      alternateScreen: false,
      scrollbackCount: 116,
      absoluteRange: null,
      capabilityGaps: [],
      scrollMetrics: { maxOffsetFromBottom: 116, offsetFromBottom: 0, viewportRows: 24 },
    };

    const merged = advanceHerdrHistoryLiveTailWindow(history, live);

    expect(merged.canOverlay).toBe(false);
    expect(merged.sourceEndIndex).toBe(100);
    expect(merged.bufferLines).toBe(history.bufferLines);
  });

  it('suppresses the live overlay when growth equals the entire history tail', () => {
    const history: HerdrHistorySnapshot = {
      bufferLines: Array.from({ length: 100 }, (_, index) => cellsFromText(`OLD_${index}`)),
      sourceEndIndex: 100,
      cols: 80,
      rows: 24,
      refreshedAt: 0,
    };
    const live: HerdrCanonicalSnapshot = {
      ztermRevision: 2,
      attachmentSeq: 2,
      full: true,
      cols: 80,
      rows: 24,
      bufferLines: Array.from({ length: 24 }, (_, index) => cellsFromText(`LIVE_${index}`)),
      cursor: null,
      localCursor: { row: 23, col: 0, visible: true },
      cursorKeysApp: false,
      alternateScreen: false,
      scrollbackCount: 176,
      absoluteRange: null,
      capabilityGaps: [],
      scrollMetrics: { maxOffsetFromBottom: 176, offsetFromBottom: 0, viewportRows: 24 },
    };

    const merged = advanceHerdrHistoryLiveTailWindow(history, live);

    expect(merged.canOverlay).toBe(false);
    expect(merged.sourceEndIndex).toBe(100);
    expect(merged.bufferLines).toBe(history.bufferLines);
  });

  it('overlays live rows between metrics samples without advancing sourceEndIndex', () => {
    const history: HerdrHistorySnapshot = {
      bufferLines: Array.from({ length: 100 }, (_, index) => cellsFromText(`OLD_${index}`)),
      sourceEndIndex: 100,
      cols: 80,
      rows: 24,
      refreshedAt: 0,
    };
    const live: HerdrCanonicalSnapshot = {
      ztermRevision: 2,
      attachmentSeq: 2,
      full: true,
      cols: 80,
      rows: 24,
      bufferLines: Array.from({ length: 24 }, (_, index) => cellsFromText(`LIVE_${index}`)),
      cursor: null,
      localCursor: { row: 23, col: 0, visible: true },
      cursorKeysApp: false,
      alternateScreen: false,
      scrollbackCount: 86,
      absoluteRange: null,
      capabilityGaps: [],
      scrollMetrics: null,
    };

    const merged = advanceHerdrHistoryLiveTailWindow(history, live, {
      overlayMetrics: { maxOffsetFromBottom: 86, offsetFromBottom: 0, viewportRows: 24 },
      canAdvanceSourceEnd: false,
    });

    expect(merged.canOverlay).toBe(true);
    expect(merged.sourceEndIndex).toBe(100);
    expect(merged.bufferLines).toHaveLength(100);
    expect(rowText(merged.bufferLines[0])).toBe('OLD_0');
    expect(merged.bufferLines.slice(-24).map(rowText)).toEqual(
      Array.from({ length: 24 }, (_, index) => `LIVE_${index}`),
    );
  });

  it('does not use confirmed scrolled metrics to overlay live rows between samples', () => {
    const history: HerdrHistorySnapshot = {
      bufferLines: Array.from({ length: 100 }, (_, index) => cellsFromText(`OLD_${index}`)),
      sourceEndIndex: 100,
      cols: 80,
      rows: 24,
      refreshedAt: 0,
    };
    const live: HerdrCanonicalSnapshot = {
      ztermRevision: 2,
      attachmentSeq: 2,
      full: true,
      cols: 80,
      rows: 24,
      bufferLines: Array.from({ length: 24 }, (_, index) => cellsFromText(`LIVE_${index}`)),
      cursor: null,
      localCursor: { row: 23, col: 0, visible: true },
      cursorKeysApp: false,
      alternateScreen: false,
      scrollbackCount: 86,
      absoluteRange: null,
      capabilityGaps: [],
      scrollMetrics: null,
    };

    const merged = advanceHerdrHistoryLiveTailWindow(history, live, {
      overlayMetrics: { maxOffsetFromBottom: 86, offsetFromBottom: 1, viewportRows: 24 },
      canAdvanceSourceEnd: false,
    });

    expect(merged.canOverlay).toBe(false);
    expect(merged.sourceEndIndex).toBe(100);
    expect(merged.bufferLines).toBe(history.bufferLines);
  });

  it('does not overlay live rows and exposes a cursor gap while the host is scrolled', async () => {
    const paneReadOutput = `${Array.from({ length: 402 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime } = createMockHerdrRuntime({
      paneReadOutput,
      scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      },
    });

    const snapshot = await runtime.readSnapshot('hd-codex');
    const overlayText = snapshot.bufferLines.slice(-24, -22).map(rowText);

    expect(overlayText).not.toEqual(['LIVE_TAIL_1', 'LIVE_TAIL_2']);
    expect(snapshot.cursor).toBeNull();
  });

  it('does not re-read the 1000-line history on every mirror live sync', async () => {
    const { runtime, paneReadCalls } = createMockHerdrRuntime();

    await runtime.readSnapshot('hd-codex');
    const callsAfterFirst = paneReadCalls();
    await runtime.readSnapshot('hd-codex');

    expect(callsAfterFirst).toBe(1);
    expect(paneReadCalls()).toBe(1);
  });

  it('fails explicitly when pane read fails instead of falling back to frame-only rows', async () => {
    const { runtime } = createMockHerdrRuntime({
      paneReadError: new Error('pane read command failed'),
    });

    await expect(runtime.readSnapshot('hd-codex')).rejects.toThrow('pane read command failed');
  });

  it('fails explicitly when pane read returns no recent history rows', async () => {
    const { runtime } = createMockHerdrRuntime({ paneReadOutput: '' });

    await expect(runtime.readSnapshot('hd-codex')).rejects.toThrow(
      'returned empty recent history',
    );
  });

  it('invokes onLiveActivity for canonical frames so server wiring can wake the mirror', async () => {
    const onLiveActivity = vi.fn();
    const { runtime } = createMockHerdrRuntime({ onLiveActivity });

    await runtime.readSnapshot('hd-codex');

    expect(onLiveActivity).toHaveBeenCalledWith('hd-codex');
  });

  it('does not start an immediate 1000-line refresh on every metrics-bearing frame while host stays scrolled', async () => {
    const paneReadOutput = `${Array.from({ length: 402 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const onLiveActivity = vi.fn();
    const { runtime, emitFrame, paneReadCalls } = createMockHerdrRuntime({
      paneReadOutput,
      onLiveActivity,
      scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      },
    });

    await runtime.readSnapshot('hd-codex');
    const callsAfterInitial = paneReadCalls();
    await new Promise((resolve) => setTimeout(resolve, 110));
    const activityCallsBefore = onLiveActivity.mock.calls.length;
    emitFrame(buildHerdrFrame({
      scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
    }));
    await vi.waitFor(() => {
      expect(onLiveActivity.mock.calls.length).toBeGreaterThan(activityCallsBefore);
    });

    expect(paneReadCalls()).toBe(callsAfterInitial);
  });

  it('starts an immediate history refresh when confirmed host scroll state changes', async () => {
    const paneReadOutput = `${Array.from({ length: 402 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const onLiveActivity = vi.fn();
    const { runtime, emitFrame, paneReadCalls, setScroll } = createMockHerdrRuntime({
      paneReadOutput,
      onLiveActivity,
      scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 1, viewportRows: 24 },
      },
    });

    await runtime.readSnapshot('hd-codex');
    const callsAfterInitial = paneReadCalls();
    await new Promise((resolve) => setTimeout(resolve, 110));
    const activityCallsBefore = onLiveActivity.mock.calls.length;
    setScroll({ maxOffsetFromBottom: 401, offsetFromBottom: 0, viewportRows: 24 });
    emitFrame(buildHerdrFrame({
      scroll: { maxOffsetFromBottom: 401, offsetFromBottom: 0, viewportRows: 24 },
    }));
    await vi.waitFor(() => {
      expect(onLiveActivity.mock.calls.length).toBeGreaterThan(activityCallsBefore);
    });

    await vi.waitFor(() => {
      expect(paneReadCalls()).toBe(callsAfterInitial + 1);
    });
  });

  it('rejects history read when fresh scroll metrics fail instead of republishing under a stale total', async () => {
    const paneReadOutput = `${Array.from({ length: 1000 }, (_, index) => `NEW_${index}`).join('\n')}\n`;
    const { runtime } = createMockHerdrRuntime({
      paneReadOutput,
      scrollError: new Error('pane get failed'),
    });

    await expect(runtime.readSnapshot('hd-codex')).rejects.toThrow(
      'refusing to publish history at a stale absolute index',
    );
  });

  it('keeps an existing bounded window when a scheduled refresh loses fresh scroll metrics', async () => {
    const oldOutput = `${Array.from({ length: 1000 }, (_, index) => `OLD_${index}`).join('\n')}\n`;
    const newOutput = `${Array.from({ length: 1000 }, (_, index) => `NEW_${index}`).join('\n')}\n`;
    const { runtime, setPaneReadOutput, setScrollError } = createMockHerdrRuntime({
      paneReadOutput: oldOutput,
      scroll: { maxOffsetFromBottom: 4976, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 4976, offsetFromBottom: 0, viewportRows: 24 },
      },
    });

    const first = await runtime.readSnapshot('hd-codex');
    expect(first.bufferStartIndex).toBe(4000);
    expect(rowText(first.bufferLines[0])).toBe('OLD_0');

    vi.useFakeTimers();
    try {
      vi.setSystemTime(2000);
      await runtime.readSnapshot('hd-codex');
      setPaneReadOutput(newOutput);
      setScrollError(new Error('pane get failed'));
      await vi.advanceTimersByTimeAsync(1000);

      const second = await runtime.readSnapshot('hd-codex');
      expect(second.bufferStartIndex).toBe(4000);
      expect(second.availableEndIndex).toBe(5000);
      expect(rowText(second.bufferLines[0])).toBe('OLD_0');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries a history read when geometry changes during canonicalization', async () => {
    const onLiveActivity = vi.fn();
    const paneReadOutput = `${Array.from({ length: 100 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime, emitFrame, setScroll } = createMockHerdrRuntime({
      paneReadOutput,
      onLiveActivity,
      scroll: { maxOffsetFromBottom: 76, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 76, offsetFromBottom: 0, viewportRows: 24 },
      },
    });
    const canonicalize = vi.mocked(canonicalizeCapturedMirrorLines);
    let releaseCanonicalize!: () => void;
    let canonicalizeStartedResolve!: () => void;
    const canonicalizeStarted = new Promise<void>((resolve) => {
      canonicalizeStartedResolve = resolve;
    });
    let canonicalizeCalls = 0;
    canonicalize.mockImplementation(async (lines: string[]) => {
      canonicalizeCalls += 1;
      if (canonicalizeCalls === 1) {
        canonicalizeStartedResolve();
        await new Promise<void>((resolve) => {
          releaseCanonicalize = resolve;
        });
        return lines.map((line) => cellsFromText(`OLD_${line}`));
      }
      return lines.map(cellsFromText);
    });

    const pending = runtime.readSnapshot('hd-codex');
    await canonicalizeStarted;
    const activityCallsBeforeResize = onLiveActivity.mock.calls.length;
    setScroll({ maxOffsetFromBottom: 70, offsetFromBottom: 0, viewportRows: 30 });
    emitFrame(buildHerdrFrame({
      width: 100,
      height: 30,
      scroll: { maxOffsetFromBottom: 70, offsetFromBottom: 0, viewportRows: 30 },
    }));
    await vi.waitFor(() => {
      expect(onLiveActivity.mock.calls.length).toBeGreaterThan(activityCallsBeforeResize);
    });
    releaseCanonicalize();

    const snapshot = await pending;
    expect(canonicalizeCalls).toBe(2);
    expect(canonicalize).toHaveBeenLastCalledWith(expect.any(Array), 100);
    expect(snapshot.cols).toBe(100);
    expect(snapshot.rows).toBe(30);
    expect(rowText(snapshot.bufferLines[0])).toBe('HISTORY_1');
  });

  it('does not publish a merged snapshot while live geometry diverges from history', async () => {
    const onLiveActivity = vi.fn();
    const paneReadOutput = `${Array.from({ length: 100 }, (_, index) => `HISTORY_${index + 1}`).join('\n')}\n`;
    const { runtime, emitFrame, setScroll } = createMockHerdrRuntime({
      paneReadOutput,
      onLiveActivity,
      scroll: { maxOffsetFromBottom: 76, offsetFromBottom: 0, viewportRows: 24 },
      frameOverrides: {
        scroll: { maxOffsetFromBottom: 76, offsetFromBottom: 0, viewportRows: 24 },
      },
    });
    const canonicalize = vi.mocked(canonicalizeCapturedMirrorLines);
    let releaseCanonicalize!: () => void;
    let refreshCanonicalizeStartedResolve!: () => void;
    const refreshCanonicalizeStarted = new Promise<void>((resolve) => {
      refreshCanonicalizeStartedResolve = resolve;
    });
    let canonicalizeCalls = 0;
    canonicalize.mockImplementation(async (lines: string[]) => {
      canonicalizeCalls += 1;
      if (canonicalizeCalls === 2) {
        refreshCanonicalizeStartedResolve();
        await new Promise<void>((resolve) => {
          releaseCanonicalize = resolve;
        });
      }
      return lines.map(cellsFromText);
    });

    const first = await runtime.readSnapshot('hd-codex');
    expect(first.cols).toBe(80);
    expect(first.rows).toBe(24);

    const activityCallsBeforeResize = onLiveActivity.mock.calls.length;
    setScroll({ maxOffsetFromBottom: 70, offsetFromBottom: 0, viewportRows: 30 });
    emitFrame(buildHerdrFrame({
      width: 100,
      height: 30,
      scroll: { maxOffsetFromBottom: 70, offsetFromBottom: 0, viewportRows: 30 },
    }));
    await vi.waitFor(() => {
      expect(onLiveActivity.mock.calls.length).toBeGreaterThan(activityCallsBeforeResize);
    });
    await refreshCanonicalizeStarted;

    await expect(runtime.readSnapshot('hd-codex')).rejects.toThrow(
      'refusing stale mirror publish',
    );

    releaseCanonicalize();
    await vi.waitFor(async () => {
      const snapshot = await runtime.readSnapshot('hd-codex');
      expect(snapshot.cols).toBe(100);
      expect(snapshot.rows).toBe(30);
    });
  });

});

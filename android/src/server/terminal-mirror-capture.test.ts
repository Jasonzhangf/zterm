import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalMirrorCaptureRuntime,
  resolveAuthoritativeMirrorCaptureWindow,
  resolveStableMirrorCaptureSnapshot,
} from './terminal-mirror-capture';
import type { SessionMirror } from './terminal-runtime-types';

function row(text: string) {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1 as const,
  }));
}

describe('terminal mirror capture runtime', () => {
  it('converts tmux history_size into total canonical rows in normal mode', () => {
    const runTmux = vi.fn((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}')) {
        return { ok: true as const, stdout: '%1\t29\t12\t80\t0\n' };
      }
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const runtime = createTerminalMirrorCaptureRuntime({
      resolveMirrorCacheLines: (rows) => rows,
      runTmux,
      logTimePrefix: () => '2026-05-02 00:00:00',
    });

    expect(runtime.readTmuxPaneMetrics('demo')).toEqual({
      paneId: '%1',
      tmuxAvailableLineCountHint: 41,
      paneRows: 12,
      paneCols: 80,
      alternateOn: false,
    });
  });

  it('keeps alternate-screen history continuous instead of resetting to pane height', () => {
    const runTmux = vi.fn((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}')) {
        return { ok: true as const, stdout: '%9\t777\t56\t80\t1\n' };
      }
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const runtime = createTerminalMirrorCaptureRuntime({
      resolveMirrorCacheLines: (rows) => rows,
      runTmux,
      logTimePrefix: () => '2026-05-02 00:00:00',
    });

    expect(runtime.readTmuxPaneMetrics('demo')).toEqual({
      paneId: '%9',
      tmuxAvailableLineCountHint: 833,
      paneRows: 56,
      paneCols: 80,
      alternateOn: true,
    });
  });

  it('anchors the mirror window only from tmux authoritative start, regardless of repeated tail content', () => {
    const nextLines = [
      row('Run /review on my current changes'),
      row('gpt-5.4 high'),
      row('branch: main'),
      row('line-112'),
      row('line-113'),
      row('line-114'),
      row('line-115'),
      row('line-116'),
      row('line-117'),
      row('line-118'),
      row('line-119'),
      row('line-120'),
    ];

    const next = resolveAuthoritativeMirrorCaptureWindow({
      nextLines,
      computedStartIndex: 109,
    });

    expect(next.continuity).toBe('authoritative-replace');
    expect(next.startIndex).toBe(109);
    expect(next.lines).toEqual(nextLines);
  });

  it('does not infer absolute continuity from same-sized content overlap', () => {
    const nextLines = [
      row('line-201'),
      row('line-202'),
      row('line-203'),
      row('line-204'),
    ];

    const next = resolveAuthoritativeMirrorCaptureWindow({
      nextLines,
      computedStartIndex: 201,
    });

    expect(next.continuity).toBe('authoritative-replace');
    expect(next.startIndex).toBe(201);
    expect(next.lines).toEqual(nextLines);
  });

  it('publishes only a stable capture snapshot when tmux returns an intermediate frame first', async () => {
    const unstable = {
      rows: 24,
      cols: 80,
      cursorKeysApp: false,
      lastScrollbackCount: 0,
      bufferStartIndex: 100,
      bufferLines: [row('draft-1'), row('draft-2')],
      cursor: null,
      capturedLineCount: 2,
      canonicalLineCount: 2,
      totalAvailableLines: 102,
      visibleTopIndex: 100,
    };
    const stable = {
      rows: 24,
      cols: 80,
      cursorKeysApp: false,
      lastScrollbackCount: 0,
      bufferStartIndex: 100,
      bufferLines: [row('final-1'), row('final-2')],
      cursor: null,
      capturedLineCount: 2,
      canonicalLineCount: 2,
      totalAvailableLines: 102,
      visibleTopIndex: 100,
    };
    const readSnapshot = vi
      .fn()
      .mockResolvedValueOnce(unstable)
      .mockResolvedValueOnce(stable)
      .mockResolvedValueOnce(stable);

    const result = await resolveStableMirrorCaptureSnapshot({
      readSnapshot,
      maxAttempts: 4,
    });

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(result.stabilized).toBe(true);
    expect(result.stabilizedAgainst).toBe('consecutive-capture');
    expect(result.attempts).toBe(3);
    expect(result.snapshot).toEqual(stable);
  });

  it('accepts the first snapshot immediately when it already matches the current mirror truth', async () => {
    const stableSnapshot = {
      rows: 24,
      cols: 80,
      cursorKeysApp: false,
      lastScrollbackCount: 0,
      bufferStartIndex: 100,
      bufferLines: [row('line-1'), row('line-2')],
      cursor: null,
      capturedLineCount: 2,
      canonicalLineCount: 2,
      totalAvailableLines: 102,
      visibleTopIndex: 100,
    };
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      revision: 1,
      lastScrollbackCount: 0,
      bufferStartIndex: 100,
      bufferLines: [row('line-1'), row('line-2')],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      subscribers: new Set(),
    };
    const readSnapshot = vi.fn().mockResolvedValue(stableSnapshot);

    const result = await resolveStableMirrorCaptureSnapshot({
      readSnapshot,
      currentMirror: mirror,
      maxAttempts: 4,
    });

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(result.stabilizedAgainst).toBe('current-mirror');
    expect(result.snapshot).toEqual(stableSnapshot);
  });

  it('publishes a changed snapshot immediately in live mode instead of waiting for a second identical tick', async () => {
    const runTmux = vi.fn((args: string[]) => {
      if (args[0] === 'display-message' && args.includes('#{pane_id}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}')) {
        return { ok: true as const, stdout: '%1\t0\t2\t80\t0\n' };
      }
      if (args[0] === 'display-message' && args.includes('#{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag}')) {
        return { ok: true as const, stdout: '0 1 1 0\n' };
      }
      if (args[0] === 'capture-pane') {
        return { ok: true as const, stdout: 'line-1\nline-2\n' };
      }
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const runtime = createTerminalMirrorCaptureRuntime({
      resolveMirrorCacheLines: () => 20,
      runTmux,
      logTimePrefix: () => '2026-05-06 21:22:00',
    });

    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 80,
      rows: 2,
      cursorKeysApp: false,
      revision: 1,
      lastScrollbackCount: 0,
      bufferStartIndex: 0,
      bufferLines: [row('old-1'), row('old-2')],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      liveSyncTimer: null,
      subscribers: new Set(),
    };

    const changed = await runtime.captureMirrorAuthoritativeBufferFromTmux(mirror);

    expect(changed).toBe(true);
    expect(mirror.bufferLines).toEqual([row('line-1'), row('line-2')]);
    expect(mirror.pendingStableCaptureSnapshot).toBeNull();
  });

  it('fails explicitly when tmux capture never stabilizes within the capped attempts', async () => {
    const readSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        rows: 24,
        cols: 80,
        cursorKeysApp: false,
        lastScrollbackCount: 0,
        bufferStartIndex: 100,
        bufferLines: [row('a')],
        cursor: null,
        capturedLineCount: 1,
        canonicalLineCount: 1,
        totalAvailableLines: 101,
        visibleTopIndex: 100,
      })
      .mockResolvedValueOnce({
        rows: 24,
        cols: 80,
        cursorKeysApp: false,
        lastScrollbackCount: 0,
        bufferStartIndex: 100,
        bufferLines: [row('b')],
        cursor: null,
        capturedLineCount: 1,
        canonicalLineCount: 1,
        totalAvailableLines: 101,
        visibleTopIndex: 100,
      })
      .mockResolvedValueOnce({
        rows: 24,
        cols: 80,
        cursorKeysApp: false,
        lastScrollbackCount: 0,
        bufferStartIndex: 100,
        bufferLines: [row('c')],
        cursor: null,
        capturedLineCount: 1,
        canonicalLineCount: 1,
        totalAvailableLines: 101,
        visibleTopIndex: 100,
      });

    await expect(resolveStableMirrorCaptureSnapshot({
      readSnapshot,
      maxAttempts: 3,
    })).rejects.toThrow('tmux capture remained unstable after 3 attempts');
  });
});

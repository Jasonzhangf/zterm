import { describe, expect, it, vi } from 'vitest';
import { createTerminalMirrorCaptureRuntime } from './terminal-mirror-capture';

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
});

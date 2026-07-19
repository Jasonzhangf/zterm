import { describe, expect, it, vi } from 'vitest';
import {
  buildRemoteWindowStreamTargets,
  createRemoteWindowStreamDaemonRuntime,
  flattenIterm2SplitTree,
  parseTmuxClientTargets,
  type Iterm2RawCatalog,
  type Iterm2RawNode,
} from './remote-window-stream-daemon';

function makeNestedItermTree(): Iterm2RawNode {
  return {
    type: 'splitter',
    vertical: true,
    children: [
      {
        type: 'session',
        sessionId: 'left',
        title: 'left-pane',
        tty: '/dev/ttys001',
        frame: { x: 0, y: 0, width: 100, height: 200 },
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'right-top',
            title: 'right-top-pane',
            tty: '/dev/ttys002',
            frame: { x: 0, y: 0, width: 200, height: 100 },
          },
          {
            type: 'session',
            sessionId: 'right-bottom',
            title: 'right-bottom-pane',
            tty: '/dev/ttys003',
            frame: { x: 0, y: 101, width: 200, height: 99 },
          },
        ],
      },
    ],
  };
}

function makeCatalog(): Iterm2RawCatalog {
  return {
    windows: [{
      windowId: 'window-1',
      title: 'iTerm2 Gate',
      pid: 123,
      frame: { x: 10, y: 20, width: 302, height: 250 },
      tabs: [{
        tabId: 'tab-1',
        activeSessionId: 'left',
        root: makeNestedItermTree(),
      }],
    }],
  };
}

function makeLiveComplexItermTree(): Iterm2RawNode {
  return {
    type: 'splitter',
    vertical: true,
    children: [
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'left-top',
            title: 'left-top',
            frame: { x: 0, y: 0, width: 801, height: 987 },
          },
          {
            type: 'session',
            sessionId: 'left-bottom',
            title: 'left-bottom',
            frame: { x: 0, y: 988, width: 801, height: 989 },
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'splitter',
            vertical: true,
            children: [
              {
                type: 'session',
                sessionId: 'middle-a-top-left',
                title: 'middle-a-top-left',
                frame: { x: 0, y: 0, width: 682, height: 978 },
              },
              {
                type: 'session',
                sessionId: 'middle-a-top-right',
                title: 'middle-a-top-right',
                frame: { x: 683, y: 0, width: 710, height: 978 },
              },
            ],
          },
          {
            type: 'splitter',
            vertical: true,
            children: [
              {
                type: 'session',
                sessionId: 'middle-a-bottom-left',
                title: 'middle-a-bottom-left',
                frame: { x: 0, y: 0, width: 699, height: 998 },
              },
              {
                type: 'session',
                sessionId: 'middle-a-bottom-right',
                title: 'middle-a-bottom-right',
                frame: { x: 700, y: 0, width: 693, height: 998 },
              },
            ],
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'middle-b-top',
            title: 'middle-b-top',
            frame: { x: 0, y: 0, width: 787, height: 978 },
          },
          {
            type: 'session',
            sessionId: 'middle-b-bottom',
            title: 'middle-b-bottom',
            frame: { x: 0, y: 979, width: 787, height: 998 },
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'right-top',
            title: 'right-top',
            frame: { x: 0, y: 0, width: 815, height: 987 },
          },
          {
            type: 'session',
            sessionId: 'right-bottom',
            title: 'right-bottom',
            frame: { x: 0, y: 988, width: 815, height: 989 },
          },
        ],
      },
    ],
  };
}

describe('remote window stream daemon owner', () => {
  it('flattens nested iTerm2 splitters before applying top-left crop math', () => {
    const panes = flattenIterm2SplitTree(makeNestedItermTree());

    expect(panes.map((pane) => [pane.sessionId, pane.frame])).toEqual([
      ['left', { x: 0, y: 0, width: 100, height: 200 }],
      ['right-top', { x: 101, y: 0, width: 200, height: 100 }],
      ['right-bottom', { x: 101, y: 101, width: 200, height: 99 }],
    ]);
  });

  it('does not double-count positioned leaf offsets in a real nested iTerm2 split tree', () => {
    const panes = flattenIterm2SplitTree(makeLiveComplexItermTree());
    const paneById = new Map(panes.map((pane) => [pane.sessionId, pane]));

    expect(paneById.get('middle-a-top-left')?.frame.x).toBe(802);
    expect(paneById.get('middle-a-top-right')?.frame.x).toBe(1485);
    expect(paneById.get('middle-b-top')?.frame.x).toBe(2196);
    expect(paneById.get('right-top')?.frame.x).toBe(2984);
    expect(paneById.get('right-bottom')?.frame).toEqual({
      x: 2984,
      y: 988,
      width: 815,
      height: 989,
    });

    const catalog: Iterm2RawCatalog = {
      windows: [{
        windowId: 'live-complex-window',
        title: 'iTerm2',
        frame: { x: 0, y: 85, width: 3799, height: 2045 },
        tabs: [{
          tabId: 'live-complex-tab',
          root: makeLiveComplexItermTree(),
        }],
      }],
    };
    const targets = buildRemoteWindowStreamTargets(
      catalog,
      new Map(),
      '2026-07-19T00:00:00.000Z',
    );

    for (const target of targets.filter((entry) => entry.videoTarget.kind === 'iterm2-pane')) {
      const windowBounds = target.videoTarget.windowBoundsTopLeftPx;
      const crop = target.videoTarget.cropRectTopLeftPx;
      expect(crop).toBeDefined();
      expect(crop!.x).toBeGreaterThanOrEqual(windowBounds.x);
      expect(crop!.y).toBeGreaterThanOrEqual(windowBounds.y);
      expect(crop!.x + crop!.width).toBeLessThanOrEqual(windowBounds.x + windowBounds.width);
      expect(crop!.y + crop!.height).toBeLessThanOrEqual(windowBounds.y + windowBounds.height);
    }
  });

  it('rejects pane manifests whose flattened content exceeds the owning window', () => {
    const catalog = makeCatalog();
    catalog.windows[0]!.frame.width = 300;

    expect(() => buildRemoteWindowStreamTargets(
      catalog,
      new Map(),
      '2026-07-19T00:00:00.000Z',
    )).toThrow('content bounds exceed window bounds');
  });

  it('builds app-window and pane manifests with tmux reverse lookup and no inverted-y crop', () => {
    const tmuxTargets = parseTmuxClientTargets([
      '/dev/ttys002\tzterm\t@1\t%2',
      '/dev/ttys999\tother\t@3\t%4',
    ].join('\n'));

    const targets = buildRemoteWindowStreamTargets(makeCatalog(), tmuxTargets, '2026-07-19T00:00:00.000Z');
    const appTarget = targets.find((target) => target.videoTarget.kind === 'app-window');
    const paneTargets = targets.filter((target) => target.videoTarget.kind === 'iterm2-pane');
    const tmuxPane = paneTargets.find((target) => target.inputTarget.itermSessionId === 'right-top');
    const bottomPane = paneTargets.find((target) => target.inputTarget.itermSessionId === 'right-bottom');

    expect(appTarget?.videoTarget.cropRectTopLeftPx).toEqual({ x: 10, y: 20, width: 302, height: 250 });
    expect(paneTargets).toHaveLength(3);
    expect(tmuxPane?.inputTarget).toMatchObject({
      kind: 'tmux-pane',
      tty: '/dev/ttys002',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    });
    expect(tmuxPane?.focusPolicy).toBe('no-focus-steal');
    expect(tmuxPane?.inputRoute).toBe('tmux-input');
    expect(tmuxPane?.videoTarget.cropRectTopLeftPx).toEqual({ x: 111, y: 70, width: 200, height: 100 });
    expect(bottomPane?.videoTarget.cropRectTopLeftPx).toEqual({ x: 111, y: 171, width: 200, height: 99 });
    expect(bottomPane?.videoTarget.cropRectTopLeftPx?.y).not.toBe(70);
  });

  it('returns an explicit unsupported-platform error without querying iTerm2', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify(makeCatalog()));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'linux',
      runIterm2Python,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-linux' });

    expect(runIterm2Python).not.toHaveBeenCalled();
    expect(response).toEqual({
      requestId: 'rw-linux',
      code: 'remote_window_platform_unsupported',
      message: 'remote window stream catalog is only available on macOS daemon hosts',
    });
  });

  it('queries iTerm2 and returns typed target manifests on macOS daemon hosts', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      now: () => '2026-07-19T00:00:00.000Z',
      runIterm2Python: vi.fn(async () => JSON.stringify(makeCatalog())),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '/dev/ttys001\talpha\t@5\t%6\n' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-darwin' });

    expect('targets' in response ? response.targets.length : 0).toBe(4);
    expect('targets' in response ? response.targets[1]?.inputTarget : null).toMatchObject({
      kind: 'tmux-pane',
      tmuxSession: 'alpha',
      tmuxWindowId: '@5',
      tmuxPaneId: '%6',
    });
  });

  it('surfaces iTerm2 API failures explicitly instead of falling back to screenshot or terminal buffer truth', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runIterm2Python: vi.fn(async () => {
        throw new Error('No module named iterm2');
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-error' });

    expect(response).toEqual({
      requestId: 'rw-error',
      code: 'iterm2_api_unavailable',
      message: 'No module named iterm2',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  buildMacosAppWindowTargets,
  buildRemoteWindowStreamTargets,
  createRemoteWindowStreamDaemonRuntime,
  flattenIterm2SplitTree,
  parseTmuxClientTargets,
  summarizeRemoteWindowCatalogError,
  type Iterm2RawCatalog,
  type Iterm2RawNode,
  type MacosAppWindowCatalog,
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

function makeAppWindowCatalog(): MacosAppWindowCatalog {
  return {
    windows: [
      {
        windowId: '64',
        ownerName: 'Google Chrome',
        appBundleId: 'com.google.Chrome',
        pid: 487,
        title: 'Chrome Window',
        frame: { x: 700, y: 139, width: 1200, height: 800 },
      },
      {
        windowId: '33',
        ownerName: 'iTerm',
        appBundleId: 'com.googlecode.iterm2',
        pid: 479,
        title: 'Default (tmux)',
        frame: { x: 0, y: 30, width: 1600, height: 900 },
      },
    ],
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
  it('builds selectable non-iTerm2 app-window manifests from the macOS app catalog', () => {
    const targets = buildMacosAppWindowTargets(makeAppWindowCatalog(), '2026-07-19T00:00:00.000Z');
    const chrome = targets.find((target) => target.videoTarget.appBundleId === 'com.google.Chrome');

    expect(targets).toHaveLength(2);
    expect(chrome).toMatchObject({
      streamTargetId: 'app-window:487:64',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.google.Chrome',
        pid: 487,
        windowId: '64',
        title: 'Chrome Window',
        cropRectTopLeftPx: { x: 700, y: 139, width: 1200, height: 800 },
      },
      inputTarget: {
        kind: 'app-window',
      },
      focusPolicy: 'bring-to-focus',
      inputRoute: 'os-event',
    });
  });

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

  it('keeps non-tmux iTerm2 panes selectable without fake tmux metadata', () => {
    const targets = buildRemoteWindowStreamTargets(
      makeCatalog(),
      new Map(),
      '2026-07-19T00:00:00.000Z',
      { includeAppWindowTargets: false },
    );

    expect(targets).toHaveLength(3);
    for (const target of targets) {
      expect(target.inputTarget).toMatchObject({
        kind: 'iterm2-pane',
      });
      expect(target.inputTarget.tmuxSession).toBeUndefined();
      expect(target.focusPolicy).toBe('bring-to-focus');
      expect(target.inputRoute).toBe('iterm2-api');
    }
  });

  it('returns an explicit unsupported-platform error without querying iTerm2', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify(makeCatalog()));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify(makeAppWindowCatalog()));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'linux',
      runIterm2Python,
      runMacosAppWindowCatalog,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-linux' });

    expect(runIterm2Python).not.toHaveBeenCalled();
    expect(runMacosAppWindowCatalog).not.toHaveBeenCalled();
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

    const response = await runtime.listTargets({ requestId: 'rw-darwin', includeAppWindows: false });

    expect('targets' in response ? response.targets.length : 0).toBe(3);
    expect('targets' in response ? response.targets[0]?.inputTarget : null).toMatchObject({
      kind: 'tmux-pane',
      tmuxSession: 'alpha',
      tmuxWindowId: '@5',
      tmuxPaneId: '%6',
    });
  });

  it('returns non-iTerm2 app windows and non-tmux iTerm2 panes in the same catalog response', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      now: () => '2026-07-19T00:00:00.000Z',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => JSON.stringify(makeCatalog())),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-combined' });
    expect('targets' in response ? response.targets : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          streamTargetId: 'app-window:487:64',
          videoTarget: expect.objectContaining({
            kind: 'app-window',
            appBundleId: 'com.google.Chrome',
          }),
          inputTarget: { kind: 'app-window' },
        }),
        expect.objectContaining({
          streamTargetId: 'iterm2-pane:window-1:tab-1:left',
          inputTarget: expect.objectContaining({
            kind: 'iterm2-pane',
          }),
        }),
      ]),
    );
    expect('targets' in response ? response.targets.filter((target) => target.videoTarget.kind === 'app-window') : []).toHaveLength(2);
    expect('targets' in response ? response.targets.filter((target) => target.videoTarget.kind === 'iterm2-pane') : []).toHaveLength(3);
  });

  it('keeps app-window targets selectable while surfacing iTerm2 catalog errors explicitly', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => {
        throw new Error('No module named iterm2');
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-partial' });

    expect('targets' in response ? response.targets.map((target) => target.streamTargetId) : []).toContain('app-window:487:64');
    expect('errors' in response ? response.errors : []).toEqual([{
      requestId: 'rw-partial',
      code: 'iterm2_api_unavailable',
      message: 'iTerm2 Python API unavailable: missing Python module iterm2',
    }]);
  });

  it('does not expose the inline Python catalog script in user-visible daemon errors', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => {
        throw new Error([
          'Command failed: python3 -c import json import iterm2 def frame_dict(frame): return {"x": frame.origin.x}',
          'Traceback (most recent call last):',
          '  File "<string>", line 3, in <module>',
          "ModuleNotFoundError: No module named 'iterm2'",
        ].join('\n'));
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-short-error' });
    const errorMessage = 'errors' in response ? response.errors?.[0]?.message || '' : '';

    expect(errorMessage).toBe('iTerm2 Python API unavailable: missing Python module iterm2');
    expect(errorMessage).not.toContain('python3 -c');
    expect(errorMessage).not.toContain('frame_dict');
  });

  it('summarizes long catalog failures without dropping the explicit failure reason', () => {
    const message = summarizeRemoteWindowCatalogError(
      new Error([
        'Command failed: swift -e import AppKit func number(_ value: Any?) -> Double? { return nil }',
        'remote permission denied while listing windows',
      ].join('\n')),
      'macOS app window catalog unavailable',
    );

    expect(message).toBe('remote permission denied while listing windows');
    expect(message).not.toContain('swift -e');
    expect(message.length).toBeLessThanOrEqual(220);
  });

  it('surfaces iTerm2 API failures explicitly instead of falling back to screenshot or terminal buffer truth', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runIterm2Python: vi.fn(async () => {
        throw new Error('No module named iterm2');
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-error', includeAppWindows: false });

    expect(response).toEqual({
      requestId: 'rw-error',
      code: 'iterm2_api_unavailable',
      message: 'iTerm2 Python API unavailable: missing Python module iterm2',
    });
  });
});

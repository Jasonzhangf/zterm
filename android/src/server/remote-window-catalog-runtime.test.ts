import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteWindowCatalogRuntime } from './remote-window-catalog-runtime';

afterEach(() => {
  vi.useRealTimers();
});

function createRuntime(
  platform: NodeJS.Platform = 'linux',
  overrides: Partial<Parameters<typeof createRemoteWindowCatalogRuntime>[0]> = {},
) {
  return createRemoteWindowCatalogRuntime({
    platform,
    pythonBinary: 'python3',
    swiftBinary: 'swift',
    iterm2PythonTimeoutMs: 5_000,
    appWindowCatalogTimeoutMs: 15_000,
    targetCatalogRefreshIntervalMs: 5_000,
    now: () => '2026-08-19T00:00:00.000Z',
    nowMs: () => 1_000,
    runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
    runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify({ windows: [] })),
    runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    ...overrides,
  });
}

describe('remote window catalog runtime owner', () => {
  it('rejects missing request identity and unsupported platforms before enumeration', async () => {
    await expect(createRuntime('darwin').listTargets({ requestId: '' })).resolves.toMatchObject({
      code: 'remote_window_request_invalid',
    });
    await expect(createRuntime('linux').listTargets({ requestId: 'request-1' })).resolves.toMatchObject({
      requestId: 'request-1',
      code: 'remote_window_platform_unsupported',
    });
  });

  it('does not warm an unsupported host', () => {
    const runtime = createRuntime('linux');
    expect(() => runtime.warm()).not.toThrow();
  });

  it('returns the daemon snapshot without starting a client-driven enumeration', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runtime = createRuntime('darwin', {
      runIterm2Python,
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.waitFor(() => {
      expect(runIterm2Python).toHaveBeenCalledTimes(1);
      expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    });

    await expect(runtime.listTargets({
      requestId: 'read-1',
    })).resolves.toMatchObject({
      requestId: 'read-1',
      targets: [],
    });
    expect(runIterm2Python).toHaveBeenCalledTimes(1);
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('waits for the daemon-owned warm refresh and does not enumerate on read', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runIterm2Python = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runtime = createRuntime('darwin', {
      runIterm2Python,
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const read = runtime.listTargets({ requestId: 'read-wait' });
    await Promise.resolve();
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    expect(runIterm2Python).not.toHaveBeenCalled();

    resolveCatalog(JSON.stringify({ windows: [] }));
    await expect(read).resolves.toMatchObject({
      requestId: 'read-wait',
      targets: [],
    });
    expect(runIterm2Python).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('fails explicitly when the daemon snapshot is not ready', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runtime = createRuntime('darwin', {
      runIterm2Python,
      runMacosAppWindowCatalog,
    });

    await expect(runtime.listTargets({ requestId: 'read-missing' })).resolves.toMatchObject({
      requestId: 'read-missing',
      code: 'remote_window_catalog_not_ready',
    });
    expect(runIterm2Python).not.toHaveBeenCalled();
    expect(runMacosAppWindowCatalog).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('rewrites nested error request ids for non-default source set projections', async () => {
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog: vi.fn(async () => {
        throw new Error('app window catalog unavailable');
      }),
    });

    runtime.warm();
    await vi.waitFor(async () => {
      const projected = await runtime.listTargets({ requestId: 'read-errors', includeIterm2: false });
      expect(projected).toMatchObject({ requestId: 'read-errors' });
      if ('errors' in projected && projected.errors) {
        expect(projected.errors.every((error) => error.requestId === 'read-errors')).toBe(true);
      }
    });
    runtime.dispose();
  });

  it('does not resurrect the snapshot when dispose lands during an in-flight refresh', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.waitFor(() => {
      expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    });
    runtime.dispose();
    resolveCatalog(JSON.stringify({ windows: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(runtime.listTargets({ requestId: 'read-after-dispose' })).resolves.toMatchObject({
      requestId: 'read-after-dispose',
      code: 'remote_window_catalog_not_ready',
    });
  });

  it('projects non-default source sets from the single daemon snapshot without re-enumerating', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify({
      windows: [{
        windowId: 'window-1',
        ownerName: 'Example',
        appBundleId: 'com.example.app',
        pid: 42,
        title: 'Example',
        frame: { x: 0, y: 0, width: 800, height: 600 },
      }],
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python,
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.waitFor(() => {
      expect(runIterm2Python).toHaveBeenCalledTimes(1);
      expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    });

    const appsOnly = await runtime.listTargets({
      requestId: 'read-apps-only',
      includeIterm2: false,
    });
    expect(appsOnly).toMatchObject({ requestId: 'read-apps-only' });
    expect('targets' in appsOnly && appsOnly.targets.length).toBeGreaterThan(0);
    expect('targets' in appsOnly && appsOnly.targets.every((entry) => entry.videoTarget.kind === 'app-window')).toBe(true);

    const iterm2Only = await runtime.listTargets({
      requestId: 'read-iterm2-only',
      includeAppWindows: false,
    });
    expect(iterm2Only).toMatchObject({ requestId: 'read-iterm2-only', targets: [] });

    expect(runIterm2Python).toHaveBeenCalledTimes(1);
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('refreshes the daemon-owned snapshot on its own cadence', async () => {
    vi.useFakeTimers();
    const runIterm2Python = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify({ windows: [] }));
    const runtime = createRuntime('darwin', {
      targetCatalogRefreshIntervalMs: 1_000,
      runIterm2Python,
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(runIterm2Python).toHaveBeenCalledTimes(2);
      expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(2);
    });
    runtime.dispose();
  });

  it('surfaces a failed resident refresh instead of serving the old snapshot', async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    const runMacosAppWindowCatalog = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 2) {
        throw new Error('app window catalog unavailable');
      }
      return JSON.stringify({
        windows: [{
          windowId: 'window-1',
          ownerName: 'Example',
          appBundleId: 'com.example.app',
          pid: 42,
          title: 'Example',
          frame: { x: 0, y: 0, width: 800, height: 600 },
        }],
      });
    });
    const runtime = createRuntime('darwin', {
      targetCatalogRefreshIntervalMs: 1_000,
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.advanceTimersByTimeAsync(0);
    await expect(runtime.listTargets({ requestId: 'read-before-failure' })).resolves.toMatchObject({
      requestId: 'read-before-failure',
      targets: [expect.objectContaining({ streamTargetId: 'app-window:42:window-1' })],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runtime.listTargets({ requestId: 'read-after-failure' })).resolves.toMatchObject({
      requestId: 'read-after-failure',
      code: 'app_window_catalog_unavailable',
    });

    refreshCount = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    const recovered = await runtime.listTargets({ requestId: 'read-after-recovery' });
    expect(recovered).toMatchObject({
      requestId: 'read-after-recovery',
      targets: [expect.objectContaining({ streamTargetId: 'app-window:42:window-1' })],
    });
    runtime.dispose();
  });

  it('invalidates the resident snapshot when a refresh has source errors', async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    const runtime = createRuntime('darwin', {
      targetCatalogRefreshIntervalMs: 1_000,
      runIterm2Python: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 2) {
          throw new Error('iTerm2 Python API unavailable');
        }
        return JSON.stringify({ windows: [] });
      }),
      runMacosAppWindowCatalog: vi.fn(async () => {
        return JSON.stringify({
          windows: [{
            windowId: 'window-1',
            ownerName: 'Example',
            appBundleId: 'com.example.app',
            pid: 42,
            title: 'Example',
            frame: { x: 0, y: 0, width: 800, height: 600 },
          }],
        });
      }),
    });

    runtime.warm();
    await vi.advanceTimersByTimeAsync(0);
    await expect(runtime.listTargets({ requestId: 'read-before-source-error' })).resolves.toMatchObject({
      targets: [expect.objectContaining({ streamTargetId: 'app-window:42:window-1' })],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runtime.listTargets({ requestId: 'read-source-error' })).resolves.toMatchObject({
      requestId: 'read-source-error',
      code: 'iterm2_api_unavailable',
    });
    runtime.dispose();
  });

  it('keeps a first refresh failure as not ready', async () => {
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog: vi.fn(async () => {
        throw new Error('app window catalog unavailable');
      }),
    });

    runtime.warm();
    await expect(runtime.listTargets({ requestId: 'read-first-failure' })).resolves.toMatchObject({
      requestId: 'read-first-failure',
      code: 'remote_window_catalog_not_ready',
    });
    runtime.dispose();
  });

  it('settles an app window close waiter as closed on a qualifying empty app window refresh', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-gone',
      pid: 42,
      injectedAtMs: 0,
    });
    resolveCatalog(JSON.stringify({ windows: [] }));
    await expect(observed).resolves.toMatchObject({ status: 'closed' });
    runtime.dispose();
  });

  it('settles an app window close waiter as not_closed when the qualifying refresh still lists the window', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-1',
      pid: 42,
      injectedAtMs: 0,
    });
    resolveCatalog(JSON.stringify({
      windows: [{
        windowId: 'window-1',
        ownerName: 'Example',
        appBundleId: 'com.example.app',
        pid: 42,
        title: 'Example',
        frame: { x: 0, y: 0, width: 800, height: 600 },
      }],
    }));
    await expect(observed).resolves.toMatchObject({ status: 'not_closed' });
    runtime.dispose();
  });

  it('matches the canonical pid:windowId identity and ignores a same windowId owned by another pid', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-1',
      pid: 42,
      injectedAtMs: 0,
    });
    // Same windowId, different owning pid: a different canonical window target,
    // so the original target is treated as gone (closed), not not_closed.
    resolveCatalog(JSON.stringify({
      windows: [{
        windowId: 'window-1',
        ownerName: 'Example',
        appBundleId: 'com.example.app',
        pid: 7,
        title: 'Example',
        frame: { x: 0, y: 0, width: 800, height: 600 },
      }],
    }));
    await expect(observed).resolves.toMatchObject({ status: 'closed' });
    runtime.dispose();
  });

  it('does not settle a close waiter from a refresh that started before the injection marker', async () => {
    vi.useFakeTimers();
    let refreshCount = 0;
    const runMacosAppWindowCatalog = vi.fn(async () => {
      refreshCount += 1;
      return JSON.stringify({ windows: [] });
    });
    const runtime = createRuntime('darwin', {
      targetCatalogRefreshIntervalMs: 1_000,
      appWindowCatalogTimeoutMs: 1_000,
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    await vi.advanceTimersByTimeAsync(0);
    // The warm refresh already started before the injection marker.
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-late',
      pid: 42,
      injectedAtMs: Date.now() + 100_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // A post-marker refresh still never happens before the deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(observed).resolves.toMatchObject({ status: 'unverified' });
    runtime.dispose();
  });

  it('does not let an unrelated iTerm2 refresh error erase the app window outcome', async () => {
    let resolveCatalog: (value: string) => void = () => undefined;
    const runMacosAppWindowCatalog = vi.fn(() => new Promise<string>((resolve) => {
      resolveCatalog = resolve;
    }));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => {
        throw new Error('iTerm2 Python API unavailable');
      }),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-1',
      pid: 42,
      injectedAtMs: 0,
    });
    resolveCatalog(JSON.stringify({
      windows: [{
        windowId: 'window-1',
        ownerName: 'Example',
        appBundleId: 'com.example.app',
        pid: 42,
        title: 'Example',
        frame: { x: 0, y: 0, width: 800, height: 600 },
      }],
    }));
    await expect(observed).resolves.toMatchObject({ status: 'not_closed' });
    runtime.dispose();
  });

  it('fails pending close waiters on dispose', async () => {
    const runMacosAppWindowCatalog = vi.fn((): Promise<string> => new Promise(() => undefined));
    const runtime = createRuntime('darwin', {
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
    });

    runtime.warm();
    const observed = runtime.awaitAppWindowCloseObservation({
      windowId: 'window-x',
      pid: 42,
      injectedAtMs: 0,
    });
    runtime.dispose();
    await expect(observed).resolves.toMatchObject({ status: 'failed' });
  });

  it('fails a close waiter immediately on non-darwin hosts', async () => {
    const runtime = createRuntime('linux');
    await expect(runtime.awaitAppWindowCloseObservation({
      windowId: 'window-1',
      injectedAtMs: 0,
    })).resolves.toMatchObject({ status: 'failed' });
  });
});

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
      forceRefresh: true,
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
});

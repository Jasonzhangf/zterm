import { describe, expect, it, vi } from 'vitest';
import { createRemoteWindowCatalogRuntime } from './remote-window-catalog-runtime';

function createRuntime(platform: NodeJS.Platform = 'linux') {
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

  it('serves the daemon-owned snapshot without forcing a client-driven enumeration', async () => {
    vi.useFakeTimers();
    const runMacosAppWindowCatalog = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        windows: [{
          windowId: 'window-1',
          ownerName: 'Example',
          appBundleId: 'com.example.app',
          pid: 42,
          title: 'Example',
          frame: { x: 0, y: 0, width: 800, height: 600 },
        }],
      }))
      .mockResolvedValue(JSON.stringify({
        windows: [{
          windowId: 'window-2',
          ownerName: 'Example',
          appBundleId: 'com.example.app',
          pid: 42,
          title: 'Example',
          frame: { x: 0, y: 0, width: 1024, height: 768 },
        }],
      }));
    const runtime = createRemoteWindowCatalogRuntime({
      platform: 'darwin',
      pythonBinary: 'python3',
      swiftBinary: 'swift',
      iterm2PythonTimeoutMs: 5_000,
      appWindowCatalogTimeoutMs: 15_000,
      targetCatalogRefreshIntervalMs: 5_000,
      now: () => '2026-08-19T00:00:00.000Z',
      nowMs: () => 1_000,
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runMacosAppWindowCatalog,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const first = await runtime.listTargets({ requestId: 'request-1' });
    expect(first).toMatchObject({
      requestId: 'request-1',
      targets: [expect.objectContaining({ streamTargetId: expect.stringContaining('window-1') })],
    });
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    const second = await runtime.listTargets({ requestId: 'request-2', forceRefresh: true });
    expect(second).toMatchObject({
      requestId: 'request-2',
      targets: [expect.objectContaining({ streamTargetId: expect.stringContaining('window-2') })],
    });
    expect(runMacosAppWindowCatalog.mock.calls.length).toBeGreaterThanOrEqual(2);
    runtime.dispose();
    vi.useRealTimers();
  });
});

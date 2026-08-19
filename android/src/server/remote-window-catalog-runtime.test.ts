import { describe, expect, it, vi } from 'vitest';
import { createRemoteWindowCatalogRuntime } from './remote-window-catalog-runtime';

function createRuntime(platform: NodeJS.Platform = 'linux') {
  return createRemoteWindowCatalogRuntime({
    platform,
    pythonBinary: 'python3',
    swiftBinary: 'swift',
    iterm2PythonTimeoutMs: 5_000,
    appWindowCatalogTimeoutMs: 15_000,
    targetCatalogCacheTtlMs: 60_000,
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
});

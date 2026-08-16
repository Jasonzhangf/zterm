import { describe, expect, it } from 'vitest';

describe('Herdr daemon selection boundary', () => {
  it('selects the formal Herdr runtime without falling through to tmux', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => (
      readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    ));
    expect(source).toContain("TERMINAL_BACKEND_KIND === 'herdr'");
    expect(source).toContain('createHerdrBackendRuntime');
    expect(source).toContain("TERMINAL_BACKEND_KIND === 'herdr'");
    expect(source).toContain('terminalControlRuntime.writeToLiveMirror(sessionName, payload, appendEnter, backend)');
    expect(source).toContain('createDaemonInputQueueRuntime');
    expect(source).toContain('daemonInputQueueRuntime = createDaemonInputQueueRuntime({');
    expect(source).toContain('writeBackendInputGroup: (sessionName, payload, appendEnter, backendKind) =>');
    expect(source).toContain('terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter, backend)');
    const proxyIndex = source.indexOf('const daemonInputQueueRuntimeProxy: ReturnType<typeof createDaemonInputQueueRuntime> = {');
    const proxyUseIndex = source.indexOf('daemonInputQueue: daemonInputQueueRuntimeProxy');
    const runtimeCreateIndex = source.indexOf('daemonInputQueueRuntime = createDaemonInputQueueRuntime({');
    expect(proxyIndex).toBeGreaterThanOrEqual(0);
    expect(proxyUseIndex).toBeGreaterThan(proxyIndex);
    expect(runtimeCreateIndex).toBeGreaterThan(proxyUseIndex);
  });
});

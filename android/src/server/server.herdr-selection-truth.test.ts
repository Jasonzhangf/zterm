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
    expect(source).toContain('terminalControlRuntime.enqueueLiveMirrorInput(sessionName, payload, appendEnter, shouldWrite, backend)');
    expect(source).toContain('terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter, backend)');
  });
});

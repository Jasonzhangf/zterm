import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('architecture boundary truth gate', () => {
  it('keeps open-tab core intent policies explicit instead of fallback-named truth', () => {
    const source = read('src/lib/open-tab-intent.ts');

    expect(source).not.toContain('fallbackActiveSessionId');
    expect(source).not.toContain('fallbackSessionIds');
    expect(source).toContain('preserveActiveSessionId');
    expect(source).toContain('nextActiveCandidateSessionIds');
  });

  it('documents the boundary remediation plan as a required architecture input', () => {
    const agents = read('../AGENTS.md');
    const skill = read('../.agents/skills/terminal-buffer-truth/SKILL.md');
    const memory = read('MEMORY.md');

    const remediationPath = 'android/docs/audits/2026-07-02-architecture-boundary-remediation.md';
    expect(agents).toContain(remediationPath);
    expect(skill).toContain('android/docs/audits/2026-07-02-architecture-boundary-remediation.md');
    expect(memory).toContain('2026-07-02-architecture-boundary-remediation.md');
  });

  it('keeps session transport-mode rebuild lifecycle out of App page orchestration', () => {
    const source = read('src/App.tsx');

    expect(source).not.toContain('const handleForceRelaySession = useCallback');
    expect(source).not.toContain('const handleUseAutoSession = useCallback');
    expect(source).not.toContain('app.session.force-relay');
    expect(source).not.toContain('app.session.use-auto');
    expect(source).not.toMatch(/closeSession\(sessionId\)[\s\S]*createSession\([\s\S]*switchSession\(sessionId\)/);
  });

  it('keeps TerminalSessionDrawer from inventing host identity fallbacks', () => {
    const source = read('src/components/terminal/TerminalSessionDrawer.tsx');

    expect(source).not.toContain("fallbackKey = 'default'");
    expect(source).not.toContain("hostKey: 'default'");
    expect(source).not.toContain("hostLabel: session.hostLabel || '本机'");
    expect(source).not.toContain('hostLabel: session.hostLabel || "本机"');
    expect(source).toContain('UNSCOPED_HOST_GROUP_KEY');
  });
});

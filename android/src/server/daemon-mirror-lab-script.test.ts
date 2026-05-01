import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('daemon mirror lab isolation gate', () => {
  it('uses an isolated managed-daemon test port instead of the user configured service port', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('ZTERM_TEST_DAEMON_PORT');
    expect(script).toContain('MANAGED_DAEMON_TEST_PORT');
    expect(script).not.toContain("process.env.ZTERM_PORT || config.port || 45761");
    expect(script).toContain("String(daemonController?.getPort() || MANAGED_DAEMON_TEST_PORT || config.port)");
  });

  it('spawns tsx directly instead of asking node to execute the shell shim', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("spawn(tsxBin, ['src/server/server.ts']");
    expect(script).not.toContain("spawn(process.execPath, [tsxBin, 'src/server/server.ts']");
  });

  it('replays client mirror history with revision-reset aware helper', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'client-mirror-replay.ts'), 'utf8');
    expect(script).toContain("import { replayBufferSyncHistory } from '../src/lib/terminal-buffer-replay'");
    expect(script).toContain('replayBufferSyncHistory({');
    expect(script).not.toContain('buffer = applyBufferSyncToSessionBuffer(buffer, item.payload');
  });

  it('waits for codex shell payload to settle to tmux truth instead of comparing the first marker frame', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain('async function waitForPayloadToMatchOracle(');
    expect(script).toContain("'codex shell marker settled payload'");
    expect(script).toContain("'codex shell tail settled payload'");
  });

  it('waits for daemon-restart command payload to settle after the marker echo appears', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'daemon restart before settled payload'");
    expect(script).toContain("'daemon restart after settled payload'");
    expect(script).toContain("'daemon restart after marker reflects'");
  });

  it('waits for external-input payloads to settle to tmux truth instead of sampling the first marker frame', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'external-input-a settled payload'");
    expect(script).toContain("'external-input-b settled payload'");
    expect(script).toContain("'external-input-tail settled payload'");
  });

  it('does not skip direct daemon payload comparison for shell-return frames with sparse visible windows', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    const buildStepBlock = script.slice(
      script.indexOf('function buildStepResult('),
      script.indexOf('function finalizeCase('),
    );
    expect(buildStepBlock).toContain('const compare = compareTail(oracle, daemonPayload);');
    expect(buildStepBlock).not.toContain('payloadCoversVisibleViewport');
  });

  it('waits for top/vim exit payloads to settle to tmux truth after alternate-screen returns to shell', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'daemon-mirror-lab.ts'), 'utf8');
    expect(script).toContain("'top exit settled payload'");
    expect(script).toContain("'vim exit settled payload'");
  });
});

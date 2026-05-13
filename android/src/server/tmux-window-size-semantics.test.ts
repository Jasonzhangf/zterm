import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as pty from 'node-pty';

function hasTmux() {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmux(args: string[]) {
  return execFileSync('tmux', args, { encoding: 'utf8' }).trim();
}

function readMetrics(sessionName: string) {
  const [windowWidth, windowHeight, paneWidth, paneHeight] = tmux([
    'display-message',
    '-p',
    '-t',
    sessionName,
    '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}',
  ]).split('\t').map((value) => Number.parseInt(value, 10));
  const windowSizeMode = tmux(['show-window-options', '-v', '-t', sessionName, 'window-size']);
  return {
    windowSizeMode,
    windowWidth,
    windowHeight,
    paneWidth,
    paneHeight,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnAttachedClient(sessionName: string, cols: number, rows: number) {
  const client = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env,
  });
  await wait(700);
  return client;
}

async function closeAttachedClient(client: pty.IPty) {
  try {
    client.kill();
  } catch {
    // ignore
  }
  await wait(400);
}

const SCRATCH_SESSIONS = new Set<string>();

async function cleanupScratchSessions() {
  for (const sessionName of Array.from(SCRATCH_SESSIONS)) {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    SCRATCH_SESSIONS.delete(sessionName);
  }
}

describe.skipIf(!hasTmux())('tmux window-size semantics for adaptive width', () => {
  afterEach(async () => {
    await cleanupScratchSessions();
  });

  it('proves resize-window -x switches tmux to manual and freezes height until latest is restored', async () => {
    const sessionName = `zterm-height-${Date.now()}`;
    SCRATCH_SESSIONS.add(sessionName);
    tmux(['new-session', '-d', '-s', sessionName]);

    const client1 = await spawnAttachedClient(sessionName, 80, 20);
    const initialMetrics = readMetrics(sessionName);
    expect(initialMetrics.windowHeight).toBeGreaterThan(0);

    tmux(['resize-window', '-t', sessionName, '-x', '56']);
    await wait(250);
    const manualMetrics = readMetrics(sessionName);
    expect(manualMetrics.windowSizeMode).toBe('manual');
    expect(manualMetrics.windowWidth).toBe(56);
    expect(manualMetrics.windowHeight).toBe(initialMetrics.windowHeight);

    await closeAttachedClient(client1);
    const client2 = await spawnAttachedClient(sessionName, 80, 40);
    const frozenMetrics = readMetrics(sessionName);
    expect(frozenMetrics.windowSizeMode).toBe('manual');
    expect(frozenMetrics.windowWidth).toBe(56);
    expect(frozenMetrics.windowHeight).toBe(initialMetrics.windowHeight);

    tmux(['set-window-option', '-t', sessionName, 'window-size', 'latest']);
    await wait(250);
    const releasedMetrics = readMetrics(sessionName);
    expect(releasedMetrics.windowSizeMode).toBe('latest');
    expect(releasedMetrics.windowWidth).toBeGreaterThan(frozenMetrics.windowWidth);
    expect(releasedMetrics.windowHeight).toBeGreaterThan(frozenMetrics.windowHeight);

    await closeAttachedClient(client2);
  });
});

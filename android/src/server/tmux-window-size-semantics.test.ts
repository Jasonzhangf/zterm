import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as pty from 'node-pty';

function hasTmux() {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmux(socketName: string, args: string[]) {
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' }).trim();
}

function readMetrics(socketName: string, sessionName: string) {
  const windowTarget = `${sessionName}:0`;
  const [windowWidth, windowHeight, paneWidth, paneHeight] = tmux(socketName, [
    'display-message',
    '-p',
    '-t',
    windowTarget,
    '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}',
  ]).split('\t').map((value) => Number.parseInt(value, 10));
  const windowSizeMode = tmux(socketName, ['show-window-options', '-v', '-t', windowTarget, 'window-size']);
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

async function spawnAttachedClient(socketName: string, sessionName: string, cols: number, rows: number) {
  const { TMUX: _tmux, ...ptyEnv } = process.env;
  const client = pty.spawn('tmux', ['-L', socketName, 'attach-session', '-t', `${sessionName}:0`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: ptyEnv,
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

const SCRATCH_SESSIONS = new Map<string, string>();

async function cleanupScratchSessions() {
  for (const [sessionName, socketName] of Array.from(SCRATCH_SESSIONS)) {
    spawnSync('tmux', ['-L', socketName, 'kill-session', '-t', sessionName], { stdio: 'ignore' });
    SCRATCH_SESSIONS.delete(sessionName);
  }
}

async function waitForSessionWindow(socketName: string, sessionName: string) {
  const windowTarget = `${sessionName}:0`;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'tmux',
      ['-L', socketName, 'display-message', '-p', '-t', windowTarget, '#{window_id}'],
      { encoding: 'utf8' },
    );
    if (result.status === 0 && result.stdout.trim()) {
      return;
    }
    await wait(50);
  }
  throw new Error(`tmux test session window did not become ready: ${windowTarget}`);
}

describe.skipIf(!hasTmux())('tmux window-size semantics for adaptive width', () => {
  afterEach(async () => {
    await cleanupScratchSessions();
  });

  it('proves resize-window -x switches tmux to manual and freezes height until latest is restored', async () => {
    const sessionName = `zterm-height-${Date.now()}`;
    const socketName = `zterm-height-test-${Date.now()}`;
    SCRATCH_SESSIONS.set(sessionName, socketName);
    tmux(socketName, ['new-session', '-d', '-s', sessionName, '/bin/sleep 3600']);
    await waitForSessionWindow(socketName, sessionName);

    const client1 = await spawnAttachedClient(socketName, sessionName, 80, 20);
    const initialMetrics = readMetrics(socketName, sessionName);
    expect(initialMetrics.windowHeight).toBeGreaterThan(0);

    tmux(socketName, ['resize-window', '-t', `${sessionName}:0`, '-x', '56']);
    await wait(250);
    const manualMetrics = readMetrics(socketName, sessionName);
    expect(manualMetrics.windowSizeMode).toBe('manual');
    expect(manualMetrics.windowWidth).toBe(56);
    expect(manualMetrics.windowHeight).toBe(initialMetrics.windowHeight);

    await closeAttachedClient(client1);
    const client2 = await spawnAttachedClient(socketName, sessionName, 80, 40);
    const frozenMetrics = readMetrics(socketName, sessionName);
    expect(frozenMetrics.windowSizeMode).toBe('manual');
    expect(frozenMetrics.windowWidth).toBe(56);
    expect(frozenMetrics.windowHeight).toBe(initialMetrics.windowHeight);

    tmux(socketName, ['set-window-option', '-t', `${sessionName}:0`, 'window-size', 'latest']);
    await wait(250);
    const releasedMetrics = readMetrics(socketName, sessionName);
    expect(releasedMetrics.windowSizeMode).toBe('latest');
    expect(releasedMetrics.windowWidth).toBeGreaterThan(frozenMetrics.windowWidth);
    expect(releasedMetrics.windowHeight).toBeGreaterThan(frozenMetrics.windowHeight);

    await closeAttachedClient(client2);
  });
});

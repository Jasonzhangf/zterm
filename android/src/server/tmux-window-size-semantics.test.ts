import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { createAdaptiveWidthOwnershipStore } from './adaptive-width-ownership-store';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type { TerminalSession } from './terminal-runtime-types';

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
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

function makeScratchAdaptiveStore() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-iterm-width-store-'));
  const storePath = join(dir, 'adaptive-width.json');
  writeFileSync(
    storePath,
    '{\n  "schemaVersion": 1,\n  "records": [],\n  "updatedAt": "2026-10-12T00:00:00.000Z"\n}\n',
    'utf8',
  );
  return {
    dir,
    store: createAdaptiveWidthOwnershipStore(storePath),
  };
}

function makeRuntime(
  socketName: string,
  sessionName: string,
  initialCols: number,
  initialRows: number,
  store: ReturnType<typeof makeScratchAdaptiveStore>['store'],
  { failReleaseResize = false } = {},
) {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, any>();
  let releaseResizeCalls = 0;

  return {
    runtime: createTerminalMirrorRuntime({
      defaultViewport: { cols: initialCols, rows: initialRows },
      sessions,
      mirrors,
      sendMessage: () => {},
      sendText: () => {},
      sendScheduleStateToSession: () => {},
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: (sessionId: string, mirror: any) => ({
        sessionId,
        revision: mirror.revision,
        latestEndIndex: 0,
        availableStartIndex: 0,
        availableEndIndex: 0,
        cursor: null,
      }),
      buildChangedRangesBufferSyncPayload: () => null,
      sanitizeSessionName: (input?: string) => input?.trim() || sessionName,
      buildExactTmuxSessionTarget: () => `${sessionName}:0`,
      getMirrorKey: () => sessionName,
      normalizeTerminalCols: (cols?: number) => cols || initialCols,
      normalizeTerminalRows: (rows?: number) => rows || initialRows,
      resolveAttachGeometry: ({ existingTmuxGeometry }) =>
        existingTmuxGeometry || { cols: initialCols, rows: initialRows },
      readTmuxPaneMetrics: () => {
        const [width, height, paneId] = tmux(socketName, [
          'display-message',
          '-p',
          '-t',
          `${sessionName}:0`,
          '#{window_width}\t#{window_height}\t#{pane_id}',
        ]).split('\t');
        return {
          paneId,
          tmuxAvailableLineCountHint: 0,
          paneRows: Number.parseInt(height, 10),
          paneCols: Number.parseInt(width, 10),
          alternateOn: false,
        };
      },
      assertTmuxSessionExists: () => {},
      resolveTerminalSessionBackend: () => 'tmux',
      captureMirrorAuthoritativeBufferFromTmux: async () => true,
      mirrorBufferChanged: () => [],
      mirrorCursorEqual: () => true,
      daemonInputQueue: {
        handleInputMessage: async () => {},
        enqueueBackendInput: async () => true,
        enqueueLiveMirrorInput: async (
          _sessionName: string,
          _payload: string,
          _appendEnter: boolean,
          shouldWrite?: () => boolean,
        ) => (shouldWrite ? shouldWrite() : true),
        disposeLiveMirrorInputBatch: () => 0,
      } as any,
      autoCommandDelayMs: 0,
      waitMs: wait,
      logTimePrefix: () => '2026-10-12 00:00:00',
      runTmuxForSession: (args: string[], tmuxSessionName: string) => {
        if (args[0] === 'resize-window' && failReleaseResize && releaseResizeCalls === 1) {
          throw new Error(`tmux ${tmuxSessionName}: simulated release failure`);
        }
        if (args[0] === 'resize-window') {
          releaseResizeCalls += 1;
        }
        tmux(socketName, args);
        return { ok: true as const, stdout: '' };
      },
      adaptiveWidthOwnershipStore: store,
      closeTransportSubscriber: () => {},
      getSessionMirror: (session: TerminalSession) =>
        (session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null),
    }),
    sessions,
  };
}

function makeSubscriberSession(id: string, sessionName: string) {
  return {
    id,
    transportId: `transport-${id}`,
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: 'http://127.0.0.1:3333',
      connectedSent: false,
      sendText: () => {},
      close: () => {},
    },
    closeTransport: () => {},
    sessionName,
    mirrorKey: null,
    sessionAttachHeartbeatAt: Date.now(),
    pendingPasteImage: null,
    pendingAttachFile: null,
  } as TerminalSession;
}

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

  it('proves final release must restore baseline before unsetting window-size', async () => {
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

    tmux(socketName, [
      'resize-window',
      '-t',
      `${sessionName}:0`,
      '-x',
      String(initialMetrics.windowWidth),
      '-y',
      String(initialMetrics.windowHeight),
    ]);
    tmux(socketName, ['set-window-option', '-u', '-t', `${sessionName}:0`, 'window-size']);
    await wait(250);
    const releasedMetrics = readMetrics(socketName, sessionName);
    expect(releasedMetrics.windowSizeMode).toBe('');
    expect(releasedMetrics.windowWidth).toBeGreaterThan(frozenMetrics.windowWidth);
    expect(releasedMetrics.windowHeight).toBeGreaterThan(frozenMetrics.windowHeight);

    await closeAttachedClient(client2);
  });

  it('releases real tmux width ownership through the adaptive width owner', async () => {
    const socketName = `zterm-runtime-iterm-${Date.now()}`;
    const sessionName = `zterm-runtime-iterm-${Date.now()}`;
    SCRATCH_SESSIONS.set(sessionName, socketName);
    const scratchStore = makeScratchAdaptiveStore();

    try {
      tmux(socketName, ['new-session', '-d', '-s', sessionName, '-x', '120', '-y', '50', '/bin/sleep 3600']);
      await waitForSessionWindow(socketName, sessionName);
      await spawnAttachedClient(socketName, sessionName, 120, 50);
      const baseline = readMetrics(socketName, sessionName);
      expect(baseline.windowWidth).toBeGreaterThanOrEqual(120);

      const { runtime, sessions } = makeRuntime(
        socketName,
        sessionName,
        baseline.windowWidth,
        baseline.windowHeight,
        scratchStore.store,
      );
      const subscriber = makeSubscriberSession('subscriber-1', sessionName);
      sessions.set(subscriber.id, subscriber);
      await runtime.attachTmux(subscriber, {
        sessionName,
        backend: 'tmux',
        cols: 56,
        rows: 40,
        widthMode: 'adaptive-phone',
      });

      const leased = readMetrics(socketName, sessionName);
      expect(leased.windowSizeMode).toBe('manual');
      expect(leased.windowWidth).toBe(56);
      expect(leased.windowHeight).toBe(baseline.windowHeight);
      expect(subscriber.adaptiveWidthCols).toBe(56);

      runtime.handleAdaptiveResize(subscriber, {
        cols: 56,
        widthMode: 'mirror-fixed',
      });
      await wait(250);

      const released = readMetrics(socketName, sessionName);
      expect(released.windowSizeMode).toBe('');
      expect(released.windowWidth).toBeGreaterThanOrEqual(120);
      expect(released.windowHeight).toBeGreaterThanOrEqual(baseline.windowHeight - 1);
      expect(subscriber.adaptiveWidthCols).toBeNull();

      // The next real client now controls the shared window again. That is the
      // iTerm2 symptom: ownership must be returned, not just the width.
      const reflowClient = await spawnAttachedClient(socketName, sessionName, 140, 56);
      await wait(400);
      const reflowed = readMetrics(socketName, sessionName);
      expect(reflowed.windowSizeMode).toBe('');
      expect(reflowed.windowWidth).toBeGreaterThanOrEqual(140);
      expect(reflowed.windowHeight).toBeGreaterThan(leased.windowHeight);
      await closeAttachedClient(reflowClient);
    } finally {
      rmSync(scratchStore.dir, { recursive: true, force: true });
    }
  });

  it('unsets real tmux window-size even when the daemon baseline restore fails', async () => {
    const socketName = `zterm-runtime-iterm-fail-${Date.now()}`;
    const sessionName = `zterm-runtime-iterm-fail-${Date.now()}`;
    SCRATCH_SESSIONS.set(sessionName, socketName);
    const scratchStore = makeScratchAdaptiveStore();

    try {
      tmux(socketName, ['new-session', '-d', '-s', sessionName, '-x', '120', '-y', '50', '/bin/sleep 3600']);
      await waitForSessionWindow(socketName, sessionName);
      const baseline = readMetrics(socketName, sessionName);

      const { runtime, sessions } = makeRuntime(
        socketName,
        sessionName,
        baseline.windowWidth,
        baseline.windowHeight,
        scratchStore.store,
        { failReleaseResize: true },
      );
      const subscriber = makeSubscriberSession('subscriber-1', sessionName);
      sessions.set(subscriber.id, subscriber);
      await runtime.attachTmux(subscriber, {
        sessionName,
        backend: 'tmux',
        cols: 56,
        rows: 40,
        widthMode: 'adaptive-phone',
      });
      expect(readMetrics(socketName, sessionName).windowSizeMode).toBe('manual');

      const releaseError = runtime.handleAdaptiveResize(subscriber, {
        cols: 56,
        widthMode: 'mirror-fixed',
      });
      expect(releaseError).toEqual({ ok: true });

      const reflowClient = await spawnAttachedClient(socketName, sessionName, 140, 56);
      await wait(400);
      const reflowed = readMetrics(socketName, sessionName);
      expect(reflowed.windowSizeMode).toBe('');
      expect(reflowed.windowWidth).toBeGreaterThanOrEqual(140);
      await closeAttachedClient(reflowClient);
    } finally {
      rmSync(scratchStore.dir, { recursive: true, force: true });
    }
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TerminalCell } from '@zterm/shared/types';
import type {
  TerminalSnapshotRequestPayload,
  TerminalSnapshotResultPayload,
} from '@zterm/shared/protocol';
import {
  buildBufferHeadPayload,
  buildRequestedRangeBufferPayload,
} from '../src/server/buffer-sync-contract';
import { createTerminalControlRuntime } from '../src/server/terminal-control-runtime';
import { createTerminalSnapshotReadRuntime } from '../src/server/terminal-snapshot-read-runtime';
import {
  buildTmuxSessionStableId,
  parseTerminalSessionStableId,
} from '../src/server/terminal-source-adapter';
import type { ResolvedTerminalSession } from '../src/server/terminal-source-adapter';
import type { SessionMirror } from '../src/server/terminal-runtime-types';

const ARTIFACT_DIR = process.env.ZTERM_IDENTITY_R2_ART
  || '/Volumes/extension/codex/projects/g-p-6a82ba0c561881919039d12d78708a8e/artifacts/daemon-cli-20261020';
const RESULT_PATH = join(ARTIFACT_DIR, 'identity-r2-native-result.json');
const TMUX_BINARY = process.env.TMUX_BINARY || 'tmux';
const SHARED_NAME = 'zterm_identity_r2_shared';
const MARKER = 'ZTERM_IDENTITY_R2_MARKER';
const FIXTURE_ROOT = join(tmpdir(), `zterm-identity-r2-${process.pid}-${Date.now().toString(36)}`);
const SOCKET_A = join(FIXTURE_ROOT, 'a', 'default');
const SOCKET_B = join(FIXTURE_ROOT, 'b', 'default');

type NativeResult = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

type Check = {
  name: string;
  ok: boolean;
  detail: unknown;
};

type NativeIdentity = {
  socketPath: string;
  serverPid: string;
  sessionId: string;
  createdAt: number;
  stableId: string;
  raw: string;
};

type AvailableSnapshot = Extract<TerminalSnapshotResultPayload, { status: 'available' }>;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TMUX_TMPDIR;
  env.TERM = 'xterm-256color';
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_CTYPE = env.LC_CTYPE || env.LANG;
  return env;
}

function runNativeTmux(socketPath: string, args: string[]): NativeResult {
  const result = spawnSync(TMUX_BINARY, ['-S', socketPath, ...args], {
    encoding: 'utf-8',
    cwd: process.env.HOME || tmpdir(),
    env: cleanEnv(),
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForOwnedSession(socketPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (runNativeTmux(socketPath, ['has-session', '-t', `=${SHARED_NAME}`]).ok) {
      return true;
    }
    await delay(50);
  }
  return false;
}

function nativeIdentity(socketPath: string): NativeIdentity {
  const result = runNativeTmux(socketPath, [
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_id}\t#{session_created}\t#{pid}',
  ]);
  if (!result.ok) {
    throw new Error(`native identity read failed for ${socketPath}: ${result.stderr.trim()}`);
  }
  const line = result.stdout
    .split('\n')
    .map((value) => value.trimEnd())
    .find((value) => value.startsWith(`${SHARED_NAME}\t`));
  if (!line) {
    throw new Error(`owned session ${SHARED_NAME} missing from native identity output`);
  }
  const [sessionName, sessionId, createdAtRaw, serverPid] = line.split('\t');
  const createdAt = Number.parseInt(createdAtRaw || '', 10);
  if (
    sessionName !== SHARED_NAME
    || !sessionId
    || !serverPid
    || !Number.isFinite(createdAt)
  ) {
    throw new Error(`native identity output is incomplete: ${line}`);
  }
  const stableId = buildTmuxSessionStableId({
    socketPath,
    serverPid,
    sessionId,
    createdAt,
  });
  return {
    socketPath,
    serverPid,
    sessionId,
    createdAt,
    stableId,
    raw: line,
  };
}

function cellsForLine(text: string): TerminalCell[] {
  const cells = Array.from(text).map((character) => ({
    char: character.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
  return cells.length > 0
    ? cells
    : [{ char: 32, fg: 256, bg: 256, flags: 0, width: 1 }];
}

function mirrorFromNativeCapture(
  capture: string,
  resolved: ResolvedTerminalSession,
): SessionMirror {
  const textLines = capture.replace(/\n$/u, '').split('\n');
  const bufferLines = textLines.map(cellsForLine);
  const lastLine = textLines[textLines.length - 1] || '';
  return {
    key: 'tmux:zterm-identity-r2-a',
    sessionName: SHARED_NAME,
    backend: 'tmux',
    sessionIdentity: resolved.identity.stableId,
    sessionTarget: resolved.target,
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 80,
    rows: 24,
    baselineCols: 80,
    baselineRows: 24,
    consecutiveFailures: 0,
    cursorKeysApp: false,
    revision: 1,
    lastScrollbackCount: 0,
    bufferStartIndex: 0,
    bufferLines,
    cursor: {
      rowIndex: Math.max(0, bufferLines.length - 1),
      col: Math.min(79, Array.from(lastLine).length),
      visible: true,
    },
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
    lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    quietFlushStreak: 0,
    lastFlushHadContentChanges: false,
    pendingStableCaptureSnapshot: null,
    pendingPerformanceTraceCapture: null,
    adaptiveWidthBaselineGeometry: null,
    adaptiveWidthAppliedCols: null,
    adaptiveWidthAppliedRows: null,
    adaptiveWidthLeaseTimer: null,
    liveSyncTimer: null,
    subscribers: new Set(),
  };
}

function snapshotText(result: AvailableSnapshot): string {
  return result.body.lines.map((line) => {
    const record = line as unknown as Record<string, unknown>;
    if (typeof record.t === 'string') {
      return record.t;
    }
    if (Array.isArray(record.cells)) {
      return record.cells.map((cell) => {
        const value = cell as { char?: number };
        return String.fromCodePoint(value.char || 32);
      }).join('');
    }
    return '';
  }).join('\n');
}

function stableIdSocketPath(stableId: string | undefined): string | undefined {
  if (!stableId) {
    return undefined;
  }
  const parsed = parseTerminalSessionStableId(stableId);
  return parsed?.backend === 'tmux' ? parsed.socketPath : undefined;
}

async function closeOwnedFixture() {
  const sockets: Array<{
    socketPath: string;
    kill: NativeResult;
    serverGone: boolean;
    socketGone: boolean;
  }> = [];
  for (const socketPath of [SOCKET_A, SOCKET_B]) {
    const kill = runNativeTmux(socketPath, ['kill-session', '-t', `=${SHARED_NAME}`]);
    let serverGone = !runNativeTmux(socketPath, ['list-sessions']).ok;
    for (let attempt = 0; attempt < 100 && !serverGone; attempt += 1) {
      await delay(50);
      serverGone = !runNativeTmux(socketPath, ['list-sessions']).ok;
    }
    sockets.push({
      socketPath,
      kill,
      serverGone,
      socketGone: false,
    });
  }
  for (const socketPath of [SOCKET_A, SOCKET_B]) {
    rmSync(dirname(socketPath), { recursive: true, force: true });
  }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  for (const socket of sockets) {
    socket.socketGone = !existsSync(socket.socketPath);
  }
  return {
    sockets,
    fixtureRootRemoved: !existsSync(FIXTURE_ROOT),
    serverExit: 'kill-session exact owned name per socket; no kill-server or bulk cleanup',
  };
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(dirname(SOCKET_A), { recursive: true });
  mkdirSync(dirname(SOCKET_B), { recursive: true });

  const checks: Check[] = [];
  const rawErrors: string[] = [];
  let cleanup: Awaited<ReturnType<typeof closeOwnedFixture>> | null = null;
  let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';
  let nativeA: NativeIdentity | null = null;
  let nativeB: NativeIdentity | null = null;
  let catalog: unknown = null;
  let conflict: unknown = null;
  let captures: unknown = null;
  let snapshot: unknown = null;

  const record = (name: string, ok: boolean, detail: unknown) => {
    checks.push({ name, ok, detail });
  };

  try {
    for (const socketPath of [SOCKET_A, SOCKET_B]) {
      const created = runNativeTmux(socketPath, [
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        SHARED_NAME,
        '-x',
        '80',
        '-y',
        '24',
        'cat',
      ]);
      if (!created.ok) {
        throw new Error(`native session create failed for ${socketPath}: ${created.stderr.trim()}`);
      }
      if (!(await waitForOwnedSession(socketPath))) {
        throw new Error(`native session did not become reachable: ${socketPath}`);
      }
    }

    nativeA = nativeIdentity(SOCKET_A);
    nativeB = nativeIdentity(SOCKET_B);
    if (!nativeA || !nativeB) {
      throw new Error('native identity was not captured for both owned sessions');
    }
    const identityA = nativeA;
    const identityB = nativeB;
    record('native_sessions_have_distinct_stable_ids', identityA.stableId !== identityB.stableId, {
      a: identityA,
      b: identityB,
    });

    const control = createTerminalControlRuntime({
      tmuxBinary: TMUX_BINARY,
      defaultSessionName: SHARED_NAME,
      hiddenTmuxSessions: new Set<string>(),
      tmuxSocketPaths: () => [SOCKET_A, SOCKET_B],
      sanitizeSessionName: (input?: string) => input?.trim() || SHARED_NAME,
      defaultBackend: 'tmux',
    });

    const sharedCatalog = control.listTerminalSessionCatalog()
      .filter((entry) => entry.backend === 'tmux' && entry.name === SHARED_NAME);
    catalog = sharedCatalog;
    const catalogStableIds = new Set(
      sharedCatalog
        .map((entry) => entry.stableId)
        .filter((value): value is string => Boolean(value)),
    );
    const catalogSockets = new Set(
      [...catalogStableIds].map((stableId) => stableIdSocketPath(stableId)).filter(Boolean),
    );
    record(
      'public_catalog_exposes_both_same_name_stable_ids',
      catalogStableIds.has(identityA.stableId)
        && catalogStableIds.has(identityB.stableId)
        && catalogSockets.has(SOCKET_A)
        && catalogSockets.has(SOCKET_B),
      {
        entryCount: sharedCatalog.length,
        stableIds: [...catalogStableIds],
        sockets: [...catalogSockets],
      },
    );

    const resolvedA = control.resolveExistingSession(identityA.stableId, 'tmux', SHARED_NAME);
    if (!resolvedA.ok) {
      throw new Error(`public owner rejected A: ${resolvedA.code}: ${resolvedA.message}`);
    }
    control.bindResolvedSession(resolvedA.session);
    const afterBindA = control.readSessionIdentity({
      backend: 'tmux',
      sessionName: SHARED_NAME,
    });
    record('public_owner_binds_a', afterBindA?.stableId === identityA.stableId, afterBindA);

    let resolveB: ReturnType<typeof control.resolveExistingSession> | null = null;
    let resolveBError: string | null = null;
    let bindBError: string | null = null;
    try {
      resolveB = control.resolveExistingSession(identityB.stableId, 'tmux', SHARED_NAME);
      if (resolveB.ok) {
        try {
          control.bindResolvedSession(resolveB.session);
        } catch (error) {
          bindBError = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      resolveBError = error instanceof Error ? error.message : String(error);
    }
    conflict = { resolveB, resolveBError, bindBError };
    const conflictBlocked = Boolean(
      resolveBError
      || bindBError
      || (resolveB && !resolveB.ok),
    );
    const afterConflict = control.readSessionIdentity({
      backend: 'tmux',
      sessionName: SHARED_NAME,
    });
    record(
      'conflicting_b_request_fails_without_changing_a',
      conflictBlocked && afterConflict?.stableId === identityA.stableId,
      { conflict, afterConflict },
    );

    await control.writeBackendInputGroup(SHARED_NAME, MARKER, true, 'tmux');
    await delay(300);
    const capturedA = runNativeTmux(SOCKET_A, [
      'capture-pane',
      '-p',
      '-t',
      `=${SHARED_NAME}:.{top-left}`,
    ]);
    const capturedB = runNativeTmux(SOCKET_B, [
      'capture-pane',
      '-p',
      '-t',
      `=${SHARED_NAME}:.{top-left}`,
    ]);
    captures = {
      a: capturedA,
      b: capturedB,
      aHasMarker: capturedA.stdout.includes(MARKER),
      bHasMarker: capturedB.stdout.includes(MARKER),
    };
    record(
      'native_marker_reaches_only_bound_a',
      capturedA.ok
        && capturedB.ok
        && capturedA.stdout.includes(MARKER)
        && !capturedB.stdout.includes(MARKER),
      {
        aHasMarker: capturedA.stdout.includes(MARKER),
        bHasMarker: capturedB.stdout.includes(MARKER),
      },
    );

    const mirrorA = mirrorFromNativeCapture(capturedA.stdout, resolvedA.session);
    const snapshotResults: TerminalSnapshotResultPayload[] = [];
    const snapshotRuntime = createTerminalSnapshotReadRuntime({
      resolveExistingSession: (request: TerminalSnapshotRequestPayload) =>
        control.resolveExistingSession(request.stableId, request.backend, SHARED_NAME),
      readExistingMirror: () => mirrorA,
      buildBufferHeadPayload,
      buildRequestedRangeBufferPayload,
      sendSnapshotResult: (result) => {
        snapshotResults.push(result);
      },
    });
    const requestA: TerminalSnapshotRequestPayload = {
      version: 1,
      backend: 'tmux',
      stableId: identityA.stableId,
      maxLines: 500,
    };
    const requestB: TerminalSnapshotRequestPayload = {
      version: 1,
      backend: 'tmux',
      stableId: identityB.stableId,
      maxLines: 500,
    };
    const resultA = snapshotRuntime.handleRequest(requestA);
    const resultB = snapshotRuntime.handleRequest(requestB);
    snapshot = { requestA, resultA, requestB, resultB, sentCount: snapshotResults.length };

    const aBodyText = resultA.status === 'available' ? snapshotText(resultA) : '';
    const aReady = resultA.status === 'available'
      && resultA.stableId === identityA.stableId
      && resultA.head.sessionId === identityA.stableId
      && resultA.body.lines.length > 0
      && (!capturedA.stdout.includes(MARKER) || aBodyText.includes(MARKER));
    record('snapshot_matching_a_returns_ready_a_body', aReady, resultA);

    const bLeaksA = resultB.status === 'available';
    record(
      'snapshot_for_b_cannot_label_a_body_as_b',
      !bLeaksA,
      {
        resultB,
        injectedMirrorStableId: identityA.stableId,
        leaked: bLeaksA,
      },
    );

    status = checks.every((check) => check.ok) ? 'PASS' : 'FAIL';
  } catch (error) {
    rawErrors.push(error instanceof Error ? (error.stack || error.message) : String(error));
    status = 'FAIL';
  } finally {
    try {
      cleanup = await closeOwnedFixture();
    } catch (error) {
      rawErrors.push(`cleanup: ${error instanceof Error ? (error.stack || error.message) : String(error)}`);
      status = 'FAIL';
    }
  }

  const result = {
    status,
    generatedAt: new Date().toISOString(),
    scope: 'native tmux sessions through declared public runtime consumers',
    fixture: {
      sharedName: SHARED_NAME,
      marker: MARKER,
      socketA: SOCKET_A,
      socketB: SOCKET_B,
    },
    testedEntrypoints: [
      'terminal-control-runtime:createTerminalControlRuntime',
      'TerminalControlRuntime.listTerminalSessionCatalog',
      'TerminalControlRuntime.resolveExistingSession',
      'TerminalControlRuntime.bindResolvedSession',
      'TerminalControlRuntime.readSessionIdentity',
      'TerminalControlRuntime.writeBackendInputGroup',
      'terminal-snapshot-read-runtime:createTerminalSnapshotReadRuntime',
    ],
    native: { a: nativeA, b: nativeB, captures },
    catalog,
    conflict,
    snapshot,
    checks,
    cleanup,
    rawErrors,
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    status,
    resultPath: RESULT_PATH,
    failedChecks: checks.filter((check) => !check.ok).map((check) => check.name),
    rawErrors: rawErrors.map((error) => error.split('\n')[0]),
    cleanup,
  }, null, 2));
  if (status !== 'PASS') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  writeFileSync(RESULT_PATH, `${JSON.stringify({
    status: 'BLOCKED',
    generatedAt: new Date().toISOString(),
    rawErrors: [message],
  }, null, 2)}\n`);
  console.error(message);
  process.exitCode = 1;
});

import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
} from '../src/lib/types';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  type RemoteWindowInputHelper,
  type RemoteWindowInputStreamReleaseResult,
} from '../src/server/remote-window-input-helper';

type ProbeChild = ChildProcessByStdio<null, Readable, Readable>;
type ReleaseResult = RemoteWindowInputStreamReleaseResult;

const PROBE_TITLE = 'zterm-helper-lifecycle-fixture';
const BUNDLE_ID = 'com.local.zterm-helper-lifecycle-fixture';
const TARGET_ID = 'helper-lifecycle-probe';

interface FixtureIdentity {
  pid: number;
  windowId: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  cgCenter: { x: number; y: number };
}

interface PointSample {
  atStart: number | null;
  atEnd: number | null;
  epochMs: number;
  lines: string[];
}


function usage() {
  return [
    'remote-window-helper-lifecycle-probe [options]',
    '',
    '  --fixture-dir <dir>   directory containing owned fixture SOURCES (.swift/.m)',
    '  --work-dir <dir>      compile + run dir (default: mkdtemp in tmp)',
    '  --out-dir <dir>       where case/<name>/result.json is written (default: work dir)',
    '  --case-only <names>   comma-separated case names to run',
    '  --keep                keep the work dir after run',
    '  --help                show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      out.help = '1';
    } else if (arg === '--keep') {
      out.keep = '1';
    } else if (arg === '--case-only') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--case-only requires a comma-separated list');
      }
      out['case-only'] = next;
      i += 1;
    } else if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined) {
        out[arg.slice(2)] = next;
        i += 1;
      }
    }
  }
  return out;
}

function requireSource(fixtureDir: string, name: string): string {
  const src = join(fixtureDir, name);
  if (!existsSync(src)) {
    throw new Error(`missing owned fixture source: ${src}`);
  }
  return src;
}

function compileFixtures(fixtureDir: string, workDir: string): Record<string, string> {
  const out: Record<string, string> = {};

  const buttonSampler = join(workDir, 'button-sampler');
  const buttonRc = spawnSync(
    'clang',
    ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'Foundation', requireSource(fixtureDir, 'button-sampler.m'), '-o', buttonSampler],
    { stdio: 'inherit' },
  );
  if (buttonRc.status !== 0) {
    throw new Error('button-sampler compile failed');
  }
  out.buttonSampler = buttonSampler;

  const keySampler = join(workDir, 'key-carrier-sampler');
  const keyRc = spawnSync(
    'clang',
    ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'Foundation', requireSource(fixtureDir, 'key-carrier-sampler.m'), '-o', keySampler],
    { stdio: 'inherit' },
  );
  if (keyRc.status !== 0) {
    throw new Error('key-carrier-sampler compile failed');
  }
  out.keySampler = keySampler;

  const upOnly = join(workDir, 'up-only');
  const upOnlyRc = spawnSync(
    'swiftc',
    ['-O', '-framework', 'AppKit', '-framework', 'CoreGraphics', requireSource(fixtureDir, 'up-only.swift'), '-o', upOnly],
    { stdio: 'inherit' },
  );
  if (upOnlyRc.status !== 0) {
    throw new Error('up-only compile failed');
  }
  out.upOnly = upOnly;

  const appRoot = join(workDir, `${PROBE_TITLE}.app`);
  const macosDir = join(appRoot, 'Contents', 'MacOS');
  mkdirSync(macosDir, { recursive: true });
  const exe = join(macosDir, PROBE_TITLE);
  const targetRc = spawnSync(
    'swiftc',
    ['-O', '-framework', 'AppKit', '-framework', 'CoreGraphics', requireSource(fixtureDir, 'target-fixture.swift'), '-o', exe],
    { stdio: 'inherit' },
  );
  if (targetRc.status !== 0) {
    throw new Error('target-fixture compile failed');
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${PROBE_TITLE}</string>
  <key>CFBundleExecutable</key><string>${PROBE_TITLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
`;
  writeFileSync(join(appRoot, 'Contents', 'Info.plist'), plist);
  out.targetExecutable = exe;
  return out;
}

function pointSample(binary: string, kind: 'button' | 'key0', seconds = 1): PointSample {
  const epochMs = Date.now();
  const res = spawnSync(binary, [String(seconds)], { encoding: 'utf8', timeout: 10_000 });
  const lines = String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const read = (line: string) => {
    const match = kind === 'button' ? line.match(/cgLeft=(-?\d+)/) : line.match(/key0=(-?\d+)/);
    return match ? Number(match[1]) : null;
  };
  return {
    atStart: lines.length > 0 ? read(lines[0]) : null,
    atEnd: lines.length > 0 ? read(lines[lines.length - 1]) : null,
    epochMs,
    lines,
  };
}

function runUpOnly(binary: string, mode: 'button' | 'key0'): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const res = spawnSync(binary, [mode], { encoding: 'utf8', timeout: 8_000 });
  return { ok: res.status === 0, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), code: res.status };
}

function launchFixture(exe: string): Promise<{ child: ProbeChild; identity: FixtureIdentity }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        reject(new Error(`fixture identity timeout${err ? `: ${err}` : ''}`));
      }
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const idx = out.indexOf('\n');
      if (idx >= 0 && !settled) {
        const line = out.slice(0, idx).trim();
        try {
          const identity = JSON.parse(line) as FixtureIdentity;
          if (identity && identity.pid > 0) {
            settled = true;
            clearTimeout(timer);
            resolve({ child, identity });
          }
        } catch {
          // not the identity line yet
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { err += chunk; });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function terminateFixture(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (!done) {
        done = true;
        resolve(code);
      }
    };
    child.once('exit', finish);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      finish(child.exitCode);
    }, 4_000);
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
    if (child.exitCode !== null) {
      clearTimeout(timer);
      finish(child.exitCode);
    }
  });
}

function makeTarget(identity: FixtureIdentity): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: TARGET_ID,
    geometryPolicy: 'preserve',
    videoTarget: {
      kind: 'app-window',
      appBundleId: BUNDLE_ID,
      pid: identity.pid,
      windowId: String(identity.windowId),
      title: identity.title,
      windowBoundsTopLeftPx: identity.bounds,
    },
    inputTarget: { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

function pointerPayload(streamId: string, phase: 'down' | 'up', point: { x: number; y: number }): RemoteWindowInputEventPayload {
  return {
    streamId,
    targetId: TARGET_ID,
    event: {
      kind: 'pointer',
      phase,
      pointerId: 1,
      button: 'left',
      buttons: phase === 'down' ? 1 : 0,
      x: point.x,
      y: point.y,
      normalizedX: 0.5,
      normalizedY: 0.5,
    },
  };
}

function keyPayload(
  streamId: string,
  phase: 'down' | 'up',
  key: string,
  code: string,
  text: string,
  mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): RemoteWindowInputEventPayload {
  return {
    streamId,
    targetId: TARGET_ID,
    event: {
      kind: 'key',
      phase,
      key,
      code,
      text,
      shiftKey: mods.shiftKey,
      altKey: mods.altKey,
      ctrlKey: mods.ctrlKey,
      metaKey: mods.metaKey,
    },
  };
}

/** Transport fault wrapper around the REAL swift child: keeps ready, drops per-request replies on demand. */
function wrapChildWithReplyDrop(real: ReturnType<typeof spawn>, dropReply: () => boolean): any {
  const stdout = new PassThrough();
  let buf = '';
  const pump = () => {
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        idx = buf.indexOf('\n');
        continue;
      }
      if (dropReply() && !trimmed.includes('"ready"')) {
        idx = buf.indexOf('\n');
        continue;
      }
      stdout.write(trimmed + '\n');
      idx = buf.indexOf('\n');
    }
  };
  real.stdout?.setEncoding('utf8');
  real.stdout?.on('data', (chunk: string) => { buf += chunk; pump(); });
  real.stdout?.on('end', () => { pump(); stdout.end(); });
  const proxy: any = {
    stdin: real.stdin,
    stdout,
    stderr: real.stderr,
    killed: real.killed,
    exitCode: real.exitCode,
    signalCode: real.signalCode,
    kill: (signal?: NodeJS.Signals | number) => {
      proxy.killed = true;
      return real.kill(signal);
    },
    on: (event: string, cb: (...args: any[]) => void) => { real.on(event as any, cb as any); return proxy; },
    once: (event: string, cb: (...args: any[]) => void) => { real.once(event as any, cb as any); return proxy; },
  };
  real.on('exit', (code, signal) => {
    proxy.exitCode = code;
    proxy.signalCode = signal;
    proxy.killed = true;
  });
  return proxy;
}

function readFrontmostPid(): number | null {
  const res = spawnSync(
    '/usr/bin/osascript',
    ['-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'],
    { encoding: 'utf8', timeout: 8_000 },
  );
  if (res.status !== 0) {
    return null;
  }
  const pid = Number.parseInt(String(res.stdout || '').trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function restoreFrontmost(pid: number | null): void {
  if (!pid) {
    return;
  }
  try {
    spawnSync(
      '/usr/bin/osascript',
      ['-e', `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`],
      { encoding: 'utf8', timeout: 6_000 },
    );
  } catch {
    // best-effort housekeeping only
  }
}

function ensureBaseline(sampler: string, upOnly: string, kind: 'button' | 'key0', what: string): PointSample {
  let sample = pointSample(sampler, kind);
  if (sample.atStart !== 0) {
    runUpOnly(upOnly, kind);
    sample = pointSample(sampler, kind);
  }
  if (sample.atStart !== 0) {
    throw new Error(`${what} OS ${kind} field not clear at case start: ${JSON.stringify(sample)}`);
  }
  return sample;
}

function makeHelper(dropReply?: () => boolean): RemoteWindowInputHelper {
  if (dropReply) {
    return createDefaultRemoteWindowInputHelper({
      swiftBinary: 'swift',
      processFactory: (command, args, options) => wrapChildWithReplyDrop(spawn(command, args, options), dropReply),
    });
  }
  return createDefaultRemoteWindowInputHelper({ swiftBinary: 'swift' });
}

interface Env {
  fixtures: Record<string, string>;
  workDir: string;
  outDir: string;
  keep: boolean;
  streamSeq: number;
  frontmostPid: number | null;
}

function nextStreamId(env: Env, tag: string) {
  env.streamSeq += 1;
  return `helper-lifecycle-${tag}-${env.streamSeq}-${process.pid}`;
}

async function runCaseHeldButtonRelease(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'heldbutton');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'held-button');
  let downAccepted = false;
  let downRejected: string | null = null;
  let heldAfterDown: PointSample | null = null;
  let release: ReleaseResult | null = null;
  let afterRelease: PointSample | null = null;
  let repeatRelease: ReleaseResult | null = null;
  let hasLeaseAfter: boolean | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch (error) {
      downRejected = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
    heldAfterDown = pointSample(env.fixtures.buttonSampler, 'button');
    release = await helper.releaseStream(streamId);
    await delay(300);
    afterRelease = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseAfter = helper.hasLease(streamId);
    repeatRelease = await helper.releaseStream(streamId);
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const releaseStatus = String((release as any)?.status ?? '');
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    osHeldAfterDown: (heldAfterDown?.atStart ?? null) === 1,
    releaseStatusReleased: releaseStatus === 'released',
    osReleasedAfterRelease: (afterRelease?.atStart ?? null) === 0,
    leaseClearedAfterRelease: hasLeaseAfter === false,
  };
  return {
    mode: 'held-button-release',
    streamId,
    identity,
    baseline,
    downAccepted,
    downRejected,
    heldAfterDown,
    release,
    afterRelease,
    repeatRelease,
    hasLeaseAfter,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      realButtonDownHeldOs: assertions.osHeldAfterDown,
      releaseStreamClearedOs: assertions.osReleasedAfterRelease,
      repeatReleaseHarmless: repeatRelease !== null,
    },
  };
}

async function runCaseHeldKey0Release(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'heldkey0');
  const baseline = ensureBaseline(env.fixtures.keySampler, env.fixtures.upOnly, 'key0', 'held-key0');
  let downAccepted = false;
  let downRejected: string | null = null;
  let heldAfterDown: PointSample | null = null;
  let release: ReleaseResult | null = null;
  let afterRelease: PointSample | null = null;
  let repeatRelease: ReleaseResult | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamId, 'down', 'z', 'KeyZ', 'z'), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch (error) {
      downRejected = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
    heldAfterDown = pointSample(env.fixtures.keySampler, 'key0');
    release = await helper.releaseStream(streamId);
    await delay(300);
    afterRelease = pointSample(env.fixtures.keySampler, 'key0');
    repeatRelease = await helper.releaseStream(streamId);
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const releaseStatus = String((release as any)?.status ?? '');
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    osKey0HeldAfterDown: (heldAfterDown?.atStart ?? null) === 1,
    releaseStatusReleased: releaseStatus === 'released',
    osKey0ReleasedAfterRelease: (afterRelease?.atStart ?? null) === 0,
  };
  return {
    mode: 'held-key0-release',
    streamId,
    identity,
    baseline,
    downAccepted,
    downRejected,
    heldAfterDown,
    release,
    afterRelease,
    repeatRelease,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      realKey0DownHeldOs: assertions.osKey0HeldAfterDown,
      releaseStreamClearedKey0: assertions.osKey0ReleasedAfterRelease,
      carrierIsUnicodeVirtualKey0: (heldAfterDown?.atStart ?? null) === 1,
    },
  };
}

async function runCaseTargetGoneNoFocus(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'targetgone');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'target-gone');
  let downAccepted = false;
  let downRejected: string | null = null;
  let heldAfterDown: PointSample | null = null;
  let targetExitCode: number | null = null;
  let targetExited = false;
  let heldWhileTargetGone: PointSample | null = null;
  let release: ReleaseResult | null = null;
  let afterRelease: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch (error) {
      downRejected = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
    heldAfterDown = pointSample(env.fixtures.buttonSampler, 'button');
    targetExitCode = await terminateFixture(child);
    targetExited = child.exitCode !== null || child.signalCode !== null;
    await delay(250);
    heldWhileTargetGone = pointSample(env.fixtures.buttonSampler, 'button');
    release = await helper.releaseStream(streamId);
    await delay(300);
    afterRelease = pointSample(env.fixtures.buttonSampler, 'button');
  } finally {
    await helper.dispose().catch(() => undefined);
    if (child.exitCode === null) {
      await terminateFixture(child);
    }
  }
  const releaseStatus = String((release as any)?.status ?? '');
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    osHeldAfterDown: (heldAfterDown?.atStart ?? null) === 1,
    targetGone: targetExited,
    osHeldWhileTargetGone: (heldWhileTargetGone?.atStart ?? null) === 1,
    releaseStatusReleased: releaseStatus === 'released',
    osReleasedAfterReleaseNoFocus: (afterRelease?.atStart ?? null) === 0,
  };
  return {
    mode: 'target-gone-nofocus',
    streamId,
    identity,
    baseline,
    downAccepted,
    downRejected,
    heldAfterDown,
    targetExitCode,
    targetExited,
    targetSignal: child.signalCode,
    heldWhileTargetGone,
    release,
    afterRelease,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      targetGoneBeforeRelease: assertions.targetGone,
      osStillHeldWhileTargetGone: assertions.osHeldWhileTargetGone,
      releaseWithoutFocusClearedOs: assertions.osReleasedAfterReleaseNoFocus,
    },
  };
}

async function runCaseReplyLostRecovery(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  let drop = false;
  const helper = makeHelper(() => drop);
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'replylost');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'reply-lost');
  let downAccepted = false;
  let downRejected: string | null = null;
  let heldAfterDown: PointSample | null = null;
  let hasLeaseAfterTimeout: boolean | null = null;
  let release: ReleaseResult | null = null;
  let afterRelease: PointSample | null = null;
  try {
    await helper.warm();
    drop = true;
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch (error) {
      downRejected = error instanceof Error ? error.message : String(error);
    }
    drop = false;
    await delay(400);
    heldAfterDown = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseAfterTimeout = helper.hasLease(streamId);
    release = await helper.releaseStream(streamId);
    await delay(300);
    afterRelease = pointSample(env.fixtures.buttonSampler, 'button');
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const releaseStatus = String((release as any)?.status ?? '');
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downReplyLost: downRejected !== null && downRejected.includes('timed out'),
    osRealPostHeldWhileReplyLost: (heldAfterDown?.atStart ?? null) === 1,
    leaseRetainedAfterTimeout: hasLeaseAfterTimeout === true,
    replacementReleaseReleased: releaseStatus === 'released',
    osReleasedAfterReplacement: (afterRelease?.atStart ?? null) === 0,
  };
  return {
    mode: 'reply-lost-recovery',
    streamId,
    identity,
    baseline,
    downAccepted,
    downRejected,
    heldAfterDown,
    hasLeaseAfterTimeout,
    release,
    afterRelease,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      realPostHeldWhileReplyLost: assertions.osRealPostHeldWhileReplyLost,
      replyLostToHelperTimeout: assertions.downReplyLost,
      leaseRetainedAfterTimeout: assertions.leaseRetainedAfterTimeout,
      replacementReleaseAfterQuiescenceClearedOs: assertions.osReleasedAfterReplacement,
    },
  };
}

async function runCaseSharedTwoStreams(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamA = nextStreamId(env, 'sharedA');
  const streamB = nextStreamId(env, 'sharedB');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'shared');
  let aAccepted = false;
  let bAccepted = false;
  let heldAfterBoth: PointSample | null = null;
  let releaseA: ReleaseResult | null = null;
  let osAfterReleaseA: PointSample | null = null;
  let hasLeaseA: boolean | null = null;
  let hasLeaseB: boolean | null = null;
  let releaseB: ReleaseResult | null = null;
  let osAfterReleaseB: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamA, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      aAccepted = true;
    } catch (error) {
      // aAccepted stays false; recorded
    }
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamB, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      bAccepted = true;
    } catch (error) {
      // bAccepted stays false
    }
    await delay(300);
    heldAfterBoth = pointSample(env.fixtures.buttonSampler, 'button');
    releaseA = await helper.releaseStream(streamA);
    await delay(300);
    osAfterReleaseA = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseA = helper.hasLease(streamA);
    hasLeaseB = helper.hasLease(streamB);
    releaseB = await helper.releaseStream(streamB);
    await delay(300);
    osAfterReleaseB = pointSample(env.fixtures.buttonSampler, 'button');
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const releaseAStatus = String((releaseA as any)?.status ?? '');
  const sharedReleased = (releaseA as any)?.sharedReleased ?? [];
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    bothDownsAccepted: aAccepted && bAccepted,
    osHeldAfterBoth: (heldAfterBoth?.atStart ?? null) === 1,
    releaseAReleased: releaseAStatus === 'released',
    releaseASharedNoNativeUp: (osAfterReleaseA?.atStart ?? null) === 1,
    leaseAClearedLeaseBKept: hasLeaseA === false && hasLeaseB === true,
    releaseBReleased: String((releaseB as any)?.status ?? '') === 'released',
    osReleasedAfterReleaseB: (osAfterReleaseB?.atStart ?? null) === 0,
  };
  return {
    mode: 'shared-two-streams',
    streamA,
    streamB,
    identity,
    baseline,
    aAccepted,
    bAccepted,
    heldAfterBoth,
    releaseA,
    osAfterReleaseA,
    hasLeaseA,
    hasLeaseB,
    releaseB,
    osAfterReleaseB,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      sharedCarrier: sharedReleased.length === 1,
      releaseAWithdrewWithoutNativeUp: assertions.releaseASharedNoNativeUp,
      releaseBLastHolderClearedOs: assertions.osReleasedAfterReleaseB,
    },
  };
}

async function runCaseSharedUpWithdraw(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamA = nextStreamId(env, 'sharedupA');
  const streamB = nextStreamId(env, 'sharedupB');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'shared-up');
  let aAccepted = false;
  let bAccepted = false;
  let heldAfterBoth: PointSample | null = null;
  let upA: string | null = null;
  let osAfterUpA: PointSample | null = null;
  let hasLeaseA: boolean | null = null;
  let hasLeaseB: boolean | null = null;
  let releaseB: ReleaseResult | null = null;
  let osAfterReleaseB: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamA, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      aAccepted = true;
    } catch { /* aAccepted stays false */ }
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamB, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      bAccepted = true;
    } catch { /* bAccepted stays false */ }
    await delay(300);
    heldAfterBoth = pointSample(env.fixtures.buttonSampler, 'button');
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamA, 'up', point), target, { daemonReceivedAtMs: Date.now() }));
      upA = 'ok';
    } catch (error) {
      upA = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
    osAfterUpA = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseA = helper.hasLease(streamA);
    hasLeaseB = helper.hasLease(streamB);
    releaseB = await helper.releaseStream(streamB);
    await delay(300);
    osAfterReleaseB = pointSample(env.fixtures.buttonSampler, 'button');
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    bothDownsAccepted: aAccepted && bAccepted,
    osHeldAfterBoth: (heldAfterBoth?.atStart ?? null) === 1,
    businessUpASucceeded: upA === 'ok',
    businessUpANoNativeUp: (osAfterUpA?.atStart ?? null) === 1,
    leaseAClearedLeaseBKept: hasLeaseA === false && hasLeaseB === true,
    releaseBReleased: String((releaseB as any)?.status ?? '') === 'released',
    osReleasedAfterReleaseB: (osAfterReleaseB?.atStart ?? null) === 0,
  };
  return {
    mode: 'shared-up-withdraw',
    streamA,
    streamB,
    identity,
    baseline,
    aAccepted,
    bAccepted,
    heldAfterBoth,
    upA,
    osAfterUpA,
    hasLeaseA,
    hasLeaseB,
    releaseB,
    osAfterReleaseB,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      businessUpSharesSerializedPath: assertions.businessUpANoNativeUp,
      lastHolderReleaseClearedOs: assertions.osReleasedAfterReleaseB,
    },
  };
}

async function runCaseReleaseFailureRetry(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  let drop = false;
  const helper = makeHelper(() => drop);
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'releaseretry');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'release-failure');
  let downAccepted = false;
  let heldAfterDown: PointSample | null = null;
  let firstRelease: ReleaseResult | null = null;
  let hasLeaseAfterFailure: boolean | null = null;
  let osAfterFirstRelease: PointSample | null = null;
  let retryRelease: ReleaseResult | null = null;
  let osAfterRetry: PointSample | null = null;
  let hasLeaseAfterRetry: boolean | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch { /* recorded below */ }
    await delay(300);
    heldAfterDown = pointSample(env.fixtures.buttonSampler, 'button');
    drop = true;
    firstRelease = await helper.releaseStream(streamId);
    drop = false;
    await delay(300);
    osAfterFirstRelease = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseAfterFailure = helper.hasLease(streamId);
    retryRelease = await helper.releaseStream(streamId);
    await delay(300);
    osAfterRetry = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseAfterRetry = helper.hasLease(streamId);
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const firstStatus = String((firstRelease as any)?.status ?? '');
  const retryStatus = String((retryRelease as any)?.status ?? '');
  const remaining = (firstRelease as any)?.remaining ?? [];
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    osHeldAfterDown: (heldAfterDown?.atStart ?? null) === 1,
    firstReleaseUnverifiedOrFailed: firstStatus === 'unverified' || firstStatus === 'failed',
    leaseRetainedAfterFailure: hasLeaseAfterFailure === true,
    retryReleased: retryStatus === 'released',
    osReleasedAfterRetry: (osAfterRetry?.atStart ?? null) === 0,
    leaseClearedAfterRetry: hasLeaseAfterRetry === false,
  };
  return {
    mode: 'release-failure-retry',
    streamId,
    identity,
    baseline,
    downAccepted,
    heldAfterDown,
    firstRelease,
    osAfterFirstRelease,
    hasLeaseAfterFailure,
    retryRelease,
    osAfterRetry,
    hasLeaseAfterRetry,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      releaseFailureRetainedResource: assertions.leaseRetainedAfterFailure,
      remainingExact: remaining.length === 1,
      retryClearedOs: assertions.osReleasedAfterRetry,
    },
  };
}

async function runCaseDisposeHoldsRelease(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  let drop = false;
  const helper = makeHelper(() => drop);
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'dispose');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'dispose');
  let downAccepted = false;
  let heldAfterDown: PointSample | null = null;
  let disposeError: string | null = null;
  let disposeElapsedMs: number | null = null;
  let osAfterDispose: PointSample | null = null;
  let hasLeaseAfterDispose: boolean | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch { /* recorded below */ }
    await delay(300);
    heldAfterDown = pointSample(env.fixtures.buttonSampler, 'button');
    drop = true;
    const t0 = Date.now();
    try {
      await helper.dispose();
    } catch (error) {
      disposeError = error instanceof Error ? error.message : String(error);
    }
    disposeElapsedMs = Date.now() - t0;
    drop = false;
    await delay(300);
    osAfterDispose = pointSample(env.fixtures.buttonSampler, 'button');
    hasLeaseAfterDispose = helper.hasLease(streamId);
  } finally {
    await terminateFixture(child);
  }
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    osHeldAfterDown: (heldAfterDown?.atStart ?? null) === 1,
    disposeSurfacedFailure: disposeError !== null,
    disposeHeldReleaseAttemptToTerminal: (disposeElapsedMs ?? 0) >= 2500,
    osReleasedByDisposal: (osAfterDispose?.atStart ?? null) === 0,
    // Design 1ce75b62 line 19/29: a failed or unconfirmed release keeps the
    // exact lease, and dispose must surface that failure instead of fabricating
    // a release. Retention is the truthful post-dispose state here.
    leaseRetainedAfterUnconfirmedDispose: hasLeaseAfterDispose === true,
  };
  return {
    mode: 'dispose-holds-release',
    streamId,
    identity,
    baseline,
    downAccepted,
    heldAfterDown,
    disposeError,
    disposeElapsedMs,
    osAfterDispose,
    hasLeaseAfterDispose,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      disposeAwaitedReleaseBeforeTerminal: assertions.disposeHeldReleaseAttemptToTerminal,
      disposeSurfacedUnconfirmedRelease: assertions.disposeSurfacedFailure,
      osClearedByDisposalRelease: assertions.osReleasedByDisposal,
    },
  };
}

async function runCaseModifierOverlap(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamA = nextStreamId(env, 'modA');
  const streamB = nextStreamId(env, 'modB');
  const baseline = ensureBaseline(env.fixtures.keySampler, env.fixtures.upOnly, 'key0', 'modifier-overlap');
  let aAccepted = false;
  let bAccepted = false;
  let heldAfterBoth: PointSample | null = null;
  let releaseA: ReleaseResult | null = null;
  let osAfterReleaseA: PointSample | null = null;
  let releaseB: ReleaseResult | null = null;
  let osAfterReleaseB: PointSample | null = null;
  let fixtureLog: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        fixtureLog.push(trimmed);
      }
    }
  });
  try {
    await helper.warm();
    // Stream A holds unicode 's' with command flag; stream B holds same 's' with control flag.
    // Same carrier identity key:u:s -> shared holder set; final up uses the lease-recorded carrier.
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamA, 'down', 's', 'KeyS', 's', { metaKey: true }), target, { daemonReceivedAtMs: Date.now() }));
      aAccepted = true;
    } catch { /* aAccepted stays false */ }
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamB, 'down', 's', 'KeyS', 's', { ctrlKey: true }), target, { daemonReceivedAtMs: Date.now() }));
      bAccepted = true;
    } catch { /* bAccepted stays false */ }
    await delay(300);
    heldAfterBoth = pointSample(env.fixtures.keySampler, 'key0');
    releaseA = await helper.releaseStream(streamA);
    await delay(300);
    osAfterReleaseA = pointSample(env.fixtures.keySampler, 'key0');
    releaseB = await helper.releaseStream(streamB);
    await delay(300);
    osAfterReleaseB = pointSample(env.fixtures.keySampler, 'key0');
    // Truthful flags observability: macOS coalesces repeated same-unicode-carrier
    // keyDown into a single event (see raw/modifier-os-diagnostics.log from a pure
    // two-post sequence). Per-stream modifier flags are therefore NOT independently
    // observable at the OS level, so this case does NOT claim flags-correct. It
    // verifies the shared-holder/final-release carrier semantics that ARE observable.
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const keyEvents = fixtureLog.filter((line) => line.startsWith('KEYEVENT'));
  const keyUps = keyEvents.filter((line) => line.includes('phase=up'));
  const releaseBStatus = String((releaseB as any)?.status ?? '');
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    bothDownsAccepted: aAccepted && bAccepted,
    osKey0HeldAfterBoth: (heldAfterBoth?.atStart ?? null) === 1,
    releaseAReleased: String((releaseA as any)?.status ?? '') === 'released',
    osKey0StillHeldAfterReleaseA: (osAfterReleaseA?.atStart ?? null) === 1,
    releaseBReleased: releaseBStatus === 'released',
    osKey0ReleasedAfterReleaseB: (osAfterReleaseB?.atStart ?? null) === 0,
  };
  return {
    mode: 'modifier-overlap',
    streamA,
    streamB,
    identity,
    baseline,
    aAccepted,
    bAccepted,
    heldAfterBoth,
    releaseA,
    osAfterReleaseA,
    releaseB,
    osAfterReleaseB,
    fixtureKeyEvents: keyEvents,
    keyUpCount: keyUps.length,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      sharedCarrierAcrossModifiers: String((releaseA as any)?.status ?? '') === 'released',
      finalUpClearedOs: (osAfterReleaseB?.atStart ?? null) === 0,
      modifierFlagsVerifiedAtOs: false,
      modifierFlagsNotClaimedReason: 'os coalesces repeated same-unicode carrier into one keyDown',
    },
    note: 'Cross-stream modifier overlap: two streams hold the same unicode carrier (key:u:s) with different flags. The lease is keyed by carrier (flags excluded), so releaseA withdraws a shared holder without a native up and releaseB posts the lease-recorded carrier up, which cleared the OS key0 state. macOS delivered only one keyDown for the repeated same-unicode carrier (raw/modifier-os-diagnostics.log), so per-stream flags are not independently observable and are not claimed.',
  };
}

/**
 * Two streams hold DIFFERENT unicode text on the same actual native resource
 * (unicode carriers post through virtualKey 0). The lease identity must equal the
 * physical resource: release A withdraws only stream A while B remains, and
 * release B issues the final native up.
 */
async function runCaseUnicodeCollisionLastHolder(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamA = nextStreamId(env, 'unicollideA');
  const streamB = nextStreamId(env, 'unicollideB');
  const baseline = ensureBaseline(env.fixtures.keySampler, env.fixtures.upOnly, 'key0', 'unicode-collision');
  let aAccepted = false;
  let bAccepted = false;
  let heldAfterBoth: PointSample | null = null;
  let releaseA: ReleaseResult | null = null;
  let osAfterReleaseA: PointSample | null = null;
  let releaseB: ReleaseResult | null = null;
  let osAfterReleaseB: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamA, 'down', '甲', '', '甲'), target, { daemonReceivedAtMs: Date.now() }));
      aAccepted = true;
    } catch { /* recorded below */ }
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamB, 'down', '乙', '', '乙'), target, { daemonReceivedAtMs: Date.now() }));
      bAccepted = true;
    } catch { /* recorded below */ }
    await delay(300);
    heldAfterBoth = pointSample(env.fixtures.keySampler, 'key0');
    releaseA = await helper.releaseStream(streamA);
    await delay(300);
    osAfterReleaseA = pointSample(env.fixtures.keySampler, 'key0');
    releaseB = await helper.releaseStream(streamB);
    await delay(300);
    osAfterReleaseB = pointSample(env.fixtures.keySampler, 'key0');
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    bothDownsAccepted: aAccepted && bAccepted,
    osKey0HeldAfterBoth: (heldAfterBoth?.atStart ?? null) === 1,
    releaseAReleased: String((releaseA as any)?.status ?? '') === 'released',
    osKey0StillHeldAfterReleaseA: (osAfterReleaseA?.atStart ?? null) === 1,
    releaseBReleased: String((releaseB as any)?.status ?? '') === 'released',
    osKey0ReleasedAfterReleaseB: (osAfterReleaseB?.atStart ?? null) === 0,
  };
  return {
    mode: 'unicode-collision-last-holder',
    streamA,
    streamB,
    identity,
    baseline,
    aAccepted,
    bAccepted,
    heldAfterBoth,
    releaseA,
    osAfterReleaseA,
    releaseB,
    osAfterReleaseB,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      differentUnicodeTextsShareActualKey0: assertions.osKey0HeldAfterBoth,
      releaseAWithdrewWithoutNativeUp: assertions.osKey0StillHeldAfterReleaseA,
      releaseBLastHolderClearedOs: assertions.osKey0ReleasedAfterReleaseB,
    },
    note: 'A holds unicode 甲 down, B holds unicode 乙 down. Both occupy virtualKey 0. releaseStream(A) must withdraw A only (OS stays 1); releaseStream(B) posts the final native up (OS reaches 0).',
  };
}

/**
 * Mixed resources: stream A holds a unicode carrier (native virtualKey 0) and
 * stream B holds the mapped physical KeyA carrier (nativeKeyCode 0). Both occupy
 * the same native key0 resource, so the lease table must arbitrate them as one.
 */
async function runCaseUnicodePhysicalKey0Collision(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamA = nextStreamId(env, 'unikeyA');
  const streamB = nextStreamId(env, 'unikeyB');
  const baseline = ensureBaseline(env.fixtures.keySampler, env.fixtures.upOnly, 'key0', 'unicode-physical-key0');
  let aAccepted = false;
  let bAccepted = false;
  let bNormalized: Record<string, unknown> | null = null;
  let heldAfterBoth: PointSample | null = null;
  let releaseA: ReleaseResult | null = null;
  let osAfterReleaseA: PointSample | null = null;
  let releaseB: ReleaseResult | null = null;
  let osAfterReleaseB: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(keyPayload(streamA, 'down', '甲', '', '甲'), target, { daemonReceivedAtMs: Date.now() }));
      aAccepted = true;
    } catch { /* recorded below */ }
    try {
      const bConfig = buildRemoteWindowInputConfig(keyPayload(streamB, 'down', 'a', 'KeyA', ''), target, { daemonReceivedAtMs: Date.now() });
      bNormalized = bConfig.native === undefined ? { native: null } : { native: bConfig.native };
      await helper.send(bConfig);
      bAccepted = true;
    } catch { /* recorded below */ }
    await delay(300);
    heldAfterBoth = pointSample(env.fixtures.keySampler, 'key0');
    releaseA = await helper.releaseStream(streamA);
    await delay(300);
    osAfterReleaseA = pointSample(env.fixtures.keySampler, 'key0');
    releaseB = await helper.releaseStream(streamB);
    await delay(300);
    osAfterReleaseB = pointSample(env.fixtures.keySampler, 'key0');
  } finally {
    await helper.dispose().catch(() => undefined);
    await terminateFixture(child);
  }
  const bNative = (bNormalized as any)?.native ?? null;
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    bothDownsAccepted: aAccepted && bAccepted,
    osKey0HeldAfterBoth: (heldAfterBoth?.atStart ?? null) === 1,
    releaseAReleased: String((releaseA as any)?.status ?? '') === 'released',
    osKey0StillHeldAfterReleaseA: (osAfterReleaseA?.atStart ?? null) === 1,
    releaseBReleased: String((releaseB as any)?.status ?? '') === 'released',
    osKey0ReleasedAfterReleaseB: (osAfterReleaseB?.atStart ?? null) === 0,
  };
  return {
    mode: 'unicode-physical-key0-collision',
    streamA,
    streamB,
    identity,
    baseline,
    aAccepted,
    bAccepted,
    bNormalized,
    bKeyAMappedToKey0: bNative?.nativeKeyCode === 0 && bNative?.nativeKeyText === null,
    heldAfterBoth,
    releaseA,
    osAfterReleaseA,
    releaseB,
    osAfterReleaseB,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true) && assertions.osKey0StillHeldAfterReleaseA,
    assertions: {
      ...assertions,
      unicodeAndMappedKeyAShareLeaseKey: String((releaseA as any)?.sharedReleased ?? '').includes('key:0'),
    },
    boundary: {
      mixedCarrierIdentity: bNative?.nativeKeyCode === 0 && bNative?.nativeKeyText === null,
      releaseAWithdrewOnly: assertions.osKey0StillHeldAfterReleaseA,
      finalReleaseClearedOs: assertions.osKey0ReleasedAfterReleaseB,
    },
    note: 'A holds unicode 甲 down, B holds mapped KeyA down. Both occupy native key0. releaseStream(A) must withdraw A only (OS stays 1); releaseStream(B) posts B\'s recorded KeyA up and clears OS.',
  };
}

async function runDisposeClean(env: Env): Promise<Record<string, unknown>> {
  const { child, identity } = await launchFixture(env.fixtures.targetExecutable);
  const helper = makeHelper();
  const target = makeTarget(identity);
  const streamId = nextStreamId(env, 'disposeclean');
  const point = identity.cgCenter;
  const baseline = ensureBaseline(env.fixtures.buttonSampler, env.fixtures.upOnly, 'button', 'dispose-clean');
  let downAccepted = false;
  let disposeError: string | null = null;
  let osAfterDispose: PointSample | null = null;
  try {
    await helper.warm();
    try {
      await helper.send(buildRemoteWindowInputConfig(pointerPayload(streamId, 'down', point), target, { daemonReceivedAtMs: Date.now() }));
      downAccepted = true;
    } catch { /* recorded below */ }
    await delay(300);
    try {
      await helper.dispose();
    } catch (error) {
      disposeError = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
    osAfterDispose = pointSample(env.fixtures.buttonSampler, 'button');
  } finally {
    await terminateFixture(child);
  }
  const assertions = {
    osBaselineClearBeforeDown: baseline.atStart === 0,
    downAccepted,
    disposeNoError: disposeError === null,
    osReleasedAfterDispose: (osAfterDispose?.atStart ?? null) === 0,
  };
  return {
    mode: 'dispose-clean',
    streamId,
    identity,
    baseline,
    downAccepted,
    disposeError,
    osAfterDispose,
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    ok: Object.values(assertions).every((value) => value === true),
    assertions,
    boundary: {
      disposeReleasedCleanly: assertions.osReleasedAfterDispose,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!args['fixture-dir']) {
    throw new Error('--fixture-dir is required\n\n' + usage());
  }
  const fixtureDir = args['fixture-dir'];
  const workDir = args['work-dir'] || mkdtempSync(join(tmpdir(), 'zterm-helper-lifecycle-probe-'));
  const outDir = args['out-dir'] || workDir;
  const keep = Boolean(args.keep);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
  mkdirSync(join(outDir, 'case'), { recursive: true });
  mkdirSync(join(outDir, 'raw'), { recursive: true });
  const caseOnly = args['case-only']
    ? new Set(args['case-only'].split(',').map((name) => name.trim()).filter(Boolean))
    : null;

  const frontmostPid = readFrontmostPid();
  const fixtures = compileFixtures(fixtureDir, workDir);
  const env: Env = { fixtures, workDir, outDir, keep, streamSeq: 0, frontmostPid };

  const startedAt = new Date().toISOString();
  const results: Record<string, Record<string, unknown>> = {};
  const allOrder: Array<{ name: string; fn: (env: Env) => Promise<Record<string, unknown>> }> = [
    { name: 'held-button-release', fn: runCaseHeldButtonRelease },
    { name: 'held-key0-release', fn: runCaseHeldKey0Release },
    { name: 'target-gone-nofocus', fn: runCaseTargetGoneNoFocus },
    { name: 'reply-lost-recovery', fn: runCaseReplyLostRecovery },
    { name: 'shared-two-streams', fn: runCaseSharedTwoStreams },
    { name: 'shared-up-withdraw', fn: runCaseSharedUpWithdraw },
    { name: 'release-failure-retry', fn: runCaseReleaseFailureRetry },
    { name: 'modifier-overlap', fn: runCaseModifierOverlap },
    { name: 'dispose-holds-release', fn: runCaseDisposeHoldsRelease },
    { name: 'dispose-clean', fn: runDisposeClean },
    { name: 'unicode-collision-last-holder', fn: runCaseUnicodeCollisionLastHolder },
    { name: 'unicode-physical-key0-collision', fn: runCaseUnicodePhysicalKey0Collision },
  ];
  const order = caseOnly ? allOrder.filter((o) => caseOnly.has(o.name)) : allOrder;
  const missing = caseOnly ? [...caseOnly].filter((name) => !allOrder.some((o) => o.name === name)) : [];

  const caseErrors: Record<string, string> = {};
  for (const { name, fn } of order) {
    try {
      results[name] = await fn(env);
    } catch (error) {
      results[name] = {
        mode: name,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        okSemantics: 'case-error (not a PASS)',
      };
      caseErrors[name] = error instanceof Error ? error.message : String(error);
    }
    const caseDir = join(outDir, 'case', name);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'result.json'), JSON.stringify(results[name], null, 2) + '\n');
  }

  // Final independent OS baseline before field handback.
  runUpOnly(fixtures.upOnly, 'button');
  runUpOnly(fixtures.upOnly, 'key0');
  const finalButton = pointSample(fixtures.buttonSampler, 'button');
  const finalKey0 = pointSample(fixtures.keySampler, 'key0');
  restoreFrontmost(frontmostPid);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    workDir,
    outDir,
    caseOnly: caseOnly ? [...caseOnly] : undefined,
    missingCases: missing.length > 0 ? missing : undefined,
    cases: order.map((o) => o.name),
    results,
    caseErrors,
    finalOsField: {
      buttonBaseline: finalButton.atStart,
      key0Baseline: finalKey0.atStart,
      buttonSample: finalButton,
      key0Sample: finalKey0,
      upOnlyCleanup: 'posted real button+key0 up-only for defensive cleanup',
    },
    okSemantics: 'procedural-completion-and-final-clear (not a capability/product PASS)',
    allCasesOk: order.every((o) => (results[o.name] as any)?.ok === true),
    allCaseErrors: Object.keys(caseErrors).length === 0 && missing.length === 0,
  };

  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (!report.allCasesOk || !report.allCaseErrors) {
    process.exitCode = 1;
  }

  if (!keep) {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

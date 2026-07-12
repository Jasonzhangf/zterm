#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractApkSmokeBridgeDebugTargetFromStorageDump } from '../src/lib/android-apk-smoke-device-bridge-target';
import { buildApkSmokeLevelDbListArgs, parseApkSmokeLevelDbFileList } from '../src/lib/android-apk-smoke-leveldb-files';
import {
  filterApkSmokeRuntimeSnapshot,
  resolveApkSmokeSnapshotActiveSessionId,
  selectFreshApkSmokeSnapshotRecord,
} from '../src/lib/android-apk-smoke-runtime-freshness';
import { extractApkSmokePrintableAsciiLines } from '../src/lib/android-apk-smoke-printable-dump';
import { resolveApkSmokeWebViewLevelDbDirFromRunAsListing } from '../src/lib/android-apk-smoke-webview-leveldb-path';
import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries } from '../src/lib/runtime-debug-sequence';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const APP_ID = 'com.zterm.android';
const ACTIVITY = 'com.zterm.android/.MainActivity';
const DEFAULT_APK_PATHS = [
  resolve(ROOT_DIR, 'update-dist', 'zterm-latest-debug.apk'),
  resolve(ROOT_DIR, 'native/android/app/build/outputs/apk/debug/app-debug.apk'),
];
const RUNTIME_DEBUG_REASON = 'terminal-real-device-evidence';
const INPUT_SAMPLE = 'rtkprobe';
const POLL_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 1_000;

type Command = 'build' | 'skip-build';

interface CliOptions {
  buildMode: Command;
  serial?: string;
  apkPath?: string;
}

function run(command: string, args: string[], cwd = ROOT_DIR, encoding: BufferEncoding | 'buffer' = 'utf8') {
  return execFileSync(command, args, {
    cwd,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runText(command: string, args: string[], cwd?: string) {
  return String(run(command, args, cwd, 'utf8')).trim();
}

function fail(message: string): never {
  throw new Error(message);
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    buildMode: 'skip-build',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--build') {
      options.buildMode = 'build';
      continue;
    }
    if (value === '--serial') {
      options.serial = argv[index + 1]?.trim() || undefined;
      index += 1;
      continue;
    }
    if (value === '--apk') {
      options.apkPath = argv[index + 1]?.trim() || undefined;
      index += 1;
    }
  }
  return options;
}

function resolveApkPath(cliApkPath?: string) {
  const candidates = cliApkPath ? [resolve(ROOT_DIR, cliApkPath)] : DEFAULT_APK_PATHS;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  fail(`apk not found; tried: ${candidates.join(', ')}`);
}

function listAuthorizedDevices() {
  const output = runText('adb', ['devices', '-l']);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 3);
      return { serial, state: state || '', raw: line };
    })
    .filter((entry) => entry.state === 'device');
}

function resolveSerial(requestedSerial?: string) {
  const devices = listAuthorizedDevices();
  if (devices.length === 0) {
    fail(`adb device not found\n${runText('adb', ['devices', '-l'])}`);
  }
  if (requestedSerial) {
    const matched = devices.find((device) => device.serial === requestedSerial);
    if (!matched) {
      fail(`requested device not found: ${requestedSerial}\n${devices.map((device) => device.raw).join('\n')}`);
    }
    return matched.serial;
  }
  if (devices.length > 1) {
    fail(`multiple adb devices found; pass --serial\n${devices.map((device) => device.raw).join('\n')}`);
  }
  return devices[0].serial;
}

function adb(serial: string, args: string[], encoding: BufferEncoding | 'buffer' = 'utf8') {
  return run('adb', ['-s', serial, ...args], ROOT_DIR, encoding);
}

function adbText(serial: string, args: string[]) {
  return String(adb(serial, args, 'utf8')).trim();
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function ensureInteractiveDevice(serial: string) {
  adbText(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adbText(serial, ['shell', 'wm', 'dismiss-keyguard']);
  adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
  adbText(serial, ['shell', 'input', 'keyevent', '82']);
  adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
  adbText(serial, ['shell', 'input', 'swipe', '600', '2200', '600', '800']);
  adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
  sleep(1000);
}

function waitForForeground(serial: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastDump = '';
  let lastWindowDump = '';
  while (Date.now() <= deadline) {
    adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
    lastDump = adbText(serial, ['shell', 'dumpsys', 'activity', 'activities']);
    const activityResumed = (
      /ResumedActivity: .*com\.zterm\.android\/\.MainActivity/m.test(lastDump)
      || /topResumedActivity=.*com\.zterm\.android\/\.MainActivity/m.test(lastDump)
      || /mFocusedApp=.*com\.zterm\.android\/\.MainActivity/m.test(lastDump)
    );
    const activityWindowFocused = (
      /mCurrentFocus=.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(lastDump)
      || /mFocusedWindow=.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(lastDump)
      || /mFocusedApp=.*com\.zterm\.android\/\.MainActivity/m.test(lastDump)
    );
    const windowDump = captureWindowDump(serial);
    lastWindowDump = windowDump;
    const notificationShadeFocused = (
      /mCurrentFocus=.*NotificationShade/m.test(windowDump)
      || /mCurrentFocus=.*NotificationShade/m.test(lastDump)
      || /mFocusedWindow=.*NotificationShade/m.test(windowDump)
      || /mFocusedWindow=.*NotificationShade/m.test(lastDump)
    );
    const windowFocused = (
      activityWindowFocused
      || /mCurrentFocus=.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(windowDump)
      || /mFocusedWindow=.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(windowDump)
      || /mFocusedApp=.*com\.zterm\.android\/\.MainActivity/m.test(windowDump)
      || /ime(?:Layering|Input|Control)Target.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(windowDump)
      || (/topApp=.*com\.zterm\.android\/\.MainActivity/m.test(windowDump) && !notificationShadeFocused)
    );
    if (activityResumed && windowFocused) {
      return `${lastDump}\n\n--- window ---\n${windowDump}`;
    }
    sleep(400);
  }
  const lockedOrSleeping = (
    /isSleeping=true/m.test(lastDump)
    || /KeyguardShowing=true/m.test(lastWindowDump)
    || /AodShowing=true/m.test(lastWindowDump)
    || /mCurrentFocus=.*NotificationShade/m.test(lastWindowDump)
  );
  if (lockedOrSleeping) {
    fail(`app not foreground within ${timeoutMs}ms: device is locked/sleeping or NotificationShade owns focus`);
  }
  fail(`app not foreground within ${timeoutMs}ms`);
}

function capturePng(serial: string) {
  return adb(serial, ['exec-out', 'screencap', '-p'], 'buffer') as Buffer;
}

function captureUiDump(serial: string) {
  const path = '/sdcard/Download/zterm-ui-dump.xml';
  adbText(serial, ['shell', 'uiautomator', 'dump', path]);
  return adbText(serial, ['shell', 'cat', path]);
}

function captureInputMethodDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'input_method']);
}

function captureWindowDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'window', 'windows']);
}

function resolveDisplayCenter(serial: string) {
  const dump = adbText(serial, ['shell', 'wm', 'size']);
  const match = dump.match(/Physical size:\s*(\d+)x(\d+)/);
  const width = match ? Number.parseInt(match[1], 10) : 1080;
  const height = match ? Number.parseInt(match[2], 10) : 2400;
  return {
    width,
    height,
    centerX: Math.floor(width / 2),
    centerY: Math.floor(height / 2),
  };
}

function safeShellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readWebViewStorageDump(serial: string) {
  const levelDbDirListing = adbText(serial, [
    'exec-out',
    'run-as',
    APP_ID,
    'sh',
    '-lc',
    'pwd; ls -la; find . -maxdepth 4 \\( -iname "*leveldb" -o -iname "*Local Storage" -o -iname "*app_webview" \\) 2>/dev/null | sed -n "1,200p"',
  ]);
  const levelDbDir = resolveApkSmokeWebViewLevelDbDirFromRunAsListing(levelDbDirListing);
  if (!levelDbDir) {
    fail(`could not discover Android WebView localStorage leveldb path\n${levelDbDirListing}`);
  }
  const filesOutput = adbText(serial, buildApkSmokeLevelDbListArgs(APP_ID, levelDbDir));
  const files = parseApkSmokeLevelDbFileList(filesOutput);
  if (files.length === 0) {
    fail(`no WebView localStorage files found under ${levelDbDir}`);
  }

  const dumpLines: string[] = [];
  for (const file of files) {
    const raw = adb(serial, ['exec-out', 'run-as', APP_ID, 'sh', '-lc', `cat ${safeShellSingleQuote(`${levelDbDir}/${file}`)}`], 'buffer') as Buffer;
    dumpLines.push(`__FILE__ ${file}`);
    dumpLines.push(...extractApkSmokePrintableAsciiLines(raw));
  }
  return dumpLines.join('\n');
}

function addToken(url: URL, token?: string) {
  if (token?.trim()) {
    url.searchParams.set('token', token.trim());
  }
}

async function fetchJson(url: URL) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    fail(`request failed (${response.status}) ${url.pathname}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid json from ${url.pathname}: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function filterRuntimeSnapshotForDevice(snapshot: Record<string, unknown>, deviceModel: string) {
  const records = Array.isArray(snapshot.clientDebugSnapshots) ? snapshot.clientDebugSnapshots : [];
  if (!deviceModel.trim()) {
    return snapshot;
  }
  return {
    ...snapshot,
    clientDebugSnapshots: records.filter((record) => (
      typeof record === 'object'
      && record !== null
      && JSON.stringify((record as { snapshot?: unknown }).snapshot || {}).includes(deviceModel)
    )),
  };
}

async function collectRuntime(remote: { bridgeHost: string; bridgePort: number; authToken?: string; sessionId?: string | null }) {
  const baseUrl = new URL(`http://${remote.bridgeHost}:${remote.bridgePort}`);
  const healthUrl = new URL('/health', baseUrl);
  addToken(healthUrl, remote.authToken);
  const controlUrl = new URL('/debug/runtime/control', baseUrl);
  addToken(controlUrl, remote.authToken);
  controlUrl.searchParams.set('enabled', '1');
  controlUrl.searchParams.set('reason', RUNTIME_DEBUG_REASON);
  if (remote.sessionId?.trim()) {
    controlUrl.searchParams.set('sessionId', remote.sessionId.trim());
  }

  const health = await fetchJson(healthUrl);
  const control = await fetchJson(controlUrl);
  const snapshotUrl = new URL('/debug/runtime', baseUrl);
  addToken(snapshotUrl, remote.authToken);
  const snapshot = await fetchJson(snapshotUrl);
  const logsUrl = new URL('/debug/runtime/logs', baseUrl);
  addToken(logsUrl, remote.authToken);
  logsUrl.searchParams.set('limit', '400');
  if (remote.sessionId?.trim()) {
    logsUrl.searchParams.set('sessionId', remote.sessionId.trim());
  }
  const logs = await fetchJson(logsUrl);
  return { health, control, snapshot, logs };
}

function extractInputEvidence(logs: unknown, sessionId: string | null) {
  const entries = Array.isArray((logs as { entries?: unknown[] })?.entries)
    ? ((logs as { entries?: unknown[] }).entries as Array<Record<string, unknown>>)
    : [];
  const parsed = parseRuntimeSequenceEntries(entries.map((entry) => ({
    seq: typeof entry.seq === 'number' ? entry.seq : undefined,
    ts: typeof entry.ts === 'string' ? entry.ts : undefined,
    scope: typeof entry.scope === 'string' ? entry.scope : undefined,
    payload: typeof entry.payload === 'string' ? entry.payload : null,
  })));
  const filtered = sessionId ? parsed.filter((entry) => entry.sessionId === sessionId) : parsed;
  const anomalies = detectRuntimeSequenceAnomalies(filtered);
  const latestScopes = filtered.slice(-30).map((entry) => entry.scope);
  return {
    parsed,
    filtered,
    anomalies,
    checks: {
      clientInputSend: filtered.some((entry) => entry.scope === 'session.input.send'),
      daemonInputReceive: filtered.some((entry) => entry.scope === 'input-receive'),
      daemonInputWrite: filtered.some((entry) => entry.scope === 'input-write'),
      bufferHead: filtered.some((entry) => entry.scope === 'session.buffer.head'),
      bufferApplied: filtered.some((entry) => entry.scope === 'session.buffer.applied'),
      renderCommit: filtered.some((entry) => entry.scope === 'session.render-gate.flush.inspect'),
      noLocalTruthAnomaly: anomalies.length === 0,
    },
    latestScopes,
  };
}

function inputMethodVisible(dump: string) {
  return /mInputShown=true/m.test(dump)
    || /showRequested=true/m.test(dump)
    || /mIsInputViewShown=true/m.test(dump);
}

function assertAppSurfaceVisible(uiDump: string, windowDump: string, stage: string) {
  const keyguardVisible = (
    /package="com\.android\.systemui"/m.test(uiDump)
    && /keyguard|kgd_|pinColorNumericKeyboard|设备已锁定|密码栏/u.test(uiDump)
  ) || /KeyguardShowing=true|AodShowing=true|mCurrentFocus=.*NotificationShade|mFocusedWindow=.*NotificationShade/m.test(windowDump);
  if (keyguardVisible) {
    fail(`app surface not visible at ${stage}: device keyguard/SystemUI owns the screen`);
  }
  const appVisible = (
    /package="com\.zterm\.android"/m.test(uiDump)
    || /com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(windowDump)
    || /ime(?:Layering|Input|Control)Target.*com\.zterm\.android\/com\.zterm\.android\.MainActivity/m.test(windowDump)
  );
  if (!appVisible) {
    fail(`app surface not visible at ${stage}: zterm package not found in UI/window evidence`);
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const serial = resolveSerial(options.serial);
  const apkPath = resolveApkPath(options.apkPath);
  const smokeStartedAt = new Date().toISOString();
  const deviceModel = adbText(serial, ['shell', 'getprop', 'ro.product.model']);
  const evidenceDir = resolve(ROOT_DIR, 'evidence', 'real-device', timestamp());
  mkdirSync(evidenceDir, { recursive: true });

  if (options.buildMode === 'build') {
    run('pnpm', ['run', 'build:android'], ROOT_DIR, 'utf8');
  }

  ensureInteractiveDevice(serial);
  adbText(serial, ['logcat', '-c']);
  adbText(serial, ['shell', 'am', 'force-stop', APP_ID]);

  const installOutput = adbText(serial, ['install', '-r', apkPath]);
  if (!installOutput.includes('Success')) {
    fail(`apk install failed\n${installOutput}`);
  }
  const startOutput = adbText(serial, ['shell', 'am', 'start', '-W', '-n', ACTIVITY]);
  if (/^Error:/m.test(startOutput) || !/Status:\s+ok/m.test(startOutput)) {
    fail(`apk start failed\n${startOutput}`);
  }
  adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
  const activityDump = waitForForeground(serial, 10_000);
  const center = resolveDisplayCenter(serial);

  const launchPng = capturePng(serial);
  const beforeImeUi = captureUiDump(serial);
  const beforeImeInputMethod = captureInputMethodDump(serial);
  const beforeImeWindow = captureWindowDump(serial);
  assertAppSurfaceVisible(beforeImeUi, beforeImeWindow, 'before-ime');

  adbText(serial, ['shell', 'input', 'tap', String(center.centerX), String(center.centerY)]);
  sleep(1200);
  const afterImePng = capturePng(serial);
  const afterImeUi = captureUiDump(serial);
  const afterImeInputMethod = captureInputMethodDump(serial);
  const afterImeWindow = captureWindowDump(serial);
  assertAppSurfaceVisible(afterImeUi, afterImeWindow, 'after-ime');

  adbText(serial, ['shell', 'input', 'text', INPUT_SAMPLE]);
  sleep(400);
  adbText(serial, ['shell', 'input', 'keyevent', '66']);

  const storageDump = readWebViewStorageDump(serial);
  const storageTarget = extractApkSmokeBridgeDebugTargetFromStorageDump(storageDump);
  if (!storageTarget.target) {
    fail('could not resolve bridge target from Android WebView localStorage truth');
  }

  const baselineRuntime = await collectRuntime(storageTarget.target);
  baselineRuntime.snapshot = filterRuntimeSnapshotForDevice(
    filterApkSmokeRuntimeSnapshot(baselineRuntime.snapshot, smokeStartedAt) as Record<string, unknown>,
    deviceModel,
  );
  const snapshotSessionId = resolveApkSmokeSnapshotActiveSessionId(
    selectFreshApkSmokeSnapshotRecord(baselineRuntime.snapshot, smokeStartedAt),
  );
  const evidenceSessionId = storageTarget.target.sessionId || snapshotSessionId || null;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let finalRuntime = baselineRuntime;
  let finalActiveSessionId = evidenceSessionId;
  let finalEvidence = extractInputEvidence(baselineRuntime.logs, evidenceSessionId);

  while (Date.now() <= deadline) {
    finalRuntime = await collectRuntime(storageTarget.target);
    finalRuntime.snapshot = filterRuntimeSnapshotForDevice(
      filterApkSmokeRuntimeSnapshot(finalRuntime.snapshot, smokeStartedAt) as Record<string, unknown>,
      deviceModel,
    );
    const currentSnapshotSessionId = resolveApkSmokeSnapshotActiveSessionId(
      selectFreshApkSmokeSnapshotRecord(finalRuntime.snapshot, smokeStartedAt),
    );
    finalActiveSessionId = storageTarget.target.sessionId || currentSnapshotSessionId || evidenceSessionId;
    finalEvidence = extractInputEvidence(finalRuntime.logs, finalActiveSessionId);
    if (
      finalActiveSessionId
      && finalEvidence.checks.clientInputSend
      && finalEvidence.checks.bufferApplied
      && finalEvidence.checks.renderCommit
    ) {
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }

  const logcat = adbText(serial, ['logcat', '-d', '-v', 'threadtime']);
  const timeline = logcat
    .split(/\r?\n/)
    .filter((line) => /session\.input|session\.buffer|session\.render-gate|input-(receive|write|drop)|ImeAnchor|Keyboard/u.test(line))
    .join('\n');

  writeFileSync(resolve(evidenceDir, 'apk-version.txt'), `${apkPath}\n`);
  writeFileSync(resolve(evidenceDir, 'install.txt'), `${installOutput}\n`);
  writeFileSync(resolve(evidenceDir, 'start.txt'), `${startOutput}\n`);
  writeFileSync(resolve(evidenceDir, 'activity-dump.txt'), `${activityDump}\n`);
  writeFileSync(resolve(evidenceDir, 'before-ime.png'), launchPng);
  writeFileSync(resolve(evidenceDir, 'after-ime.png'), afterImePng);
  writeFileSync(resolve(evidenceDir, 'before-ime-ui.xml'), `${beforeImeUi}\n`);
  writeFileSync(resolve(evidenceDir, 'after-ime-ui.xml'), `${afterImeUi}\n`);
  writeFileSync(resolve(evidenceDir, 'before-ime-input-method.txt'), `${beforeImeInputMethod}\n`);
  writeFileSync(resolve(evidenceDir, 'after-ime-input-method.txt'), `${afterImeInputMethod}\n`);
  writeFileSync(resolve(evidenceDir, 'before-ime-window.txt'), `${beforeImeWindow}\n`);
  writeFileSync(resolve(evidenceDir, 'after-ime-window.txt'), `${afterImeWindow}\n`);
  writeFileSync(resolve(evidenceDir, 'webview-local-storage-dump.txt'), `${storageDump}\n`);
  writeFileSync(resolve(evidenceDir, 'webview-bridge-target.json'), `${JSON.stringify(storageTarget, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-health.json'), `${JSON.stringify(finalRuntime.health, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-debug-control.json'), `${JSON.stringify(finalRuntime.control, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-snapshot.json'), `${JSON.stringify(finalRuntime.snapshot, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-logs.json'), `${JSON.stringify(finalRuntime.logs, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'timeline.txt'), `${timeline}\n`);

  finalActiveSessionId = storageTarget.target.sessionId || resolveApkSmokeSnapshotActiveSessionId(
    selectFreshApkSmokeSnapshotRecord(finalRuntime.snapshot, smokeStartedAt),
  ) || null;
  const summary = {
    ok: Boolean(finalActiveSessionId)
      && finalEvidence.checks.clientInputSend
      && finalEvidence.checks.bufferApplied
      && finalEvidence.checks.renderCommit
      && finalEvidence.checks.noLocalTruthAnomaly,
    serial,
    apkPath,
    activeSessionId: finalActiveSessionId,
    smokeStartedAt,
    deviceModel,
    bridgeHost: storageTarget.target.bridgeHost,
    bridgePort: storageTarget.target.bridgePort,
    inputSample: INPUT_SAMPLE,
    ime: {
      beforeVisible: inputMethodVisible(beforeImeInputMethod),
      afterVisible: inputMethodVisible(afterImeInputMethod),
      screenshotBefore: 'before-ime.png',
      screenshotAfter: 'after-ime.png',
    },
    runtimeChecks: finalEvidence.checks,
    anomalyCount: finalEvidence.anomalies.length,
    latestScopes: finalEvidence.latestScopes,
    evidenceDir,
  };

  writeFileSync(resolve(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) {
    fail(`terminal real-device evidence failed: activeSessionId=${summary.activeSessionId || 'null'} checks=${JSON.stringify(summary.runtimeChecks)}`);
  }
}

main().catch((error) => {
  process.stderr.write(`[terminal-real-device-evidence] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

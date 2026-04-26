#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const APK_PATH = resolve(ROOT_DIR, 'native/android/app/build/outputs/apk/debug/app-debug.apk');
const APP_ID = 'com.zterm.android';
const ACTIVITY = 'com.zterm.android/.MainActivity';
const TAG = 'ZTermMainActivity';

function run(command: string, args: string[], options?: { cwd?: string; encoding?: BufferEncoding | 'buffer' }) {
  return execFileSync(command, args, {
    cwd: options?.cwd ?? ROOT_DIR,
    encoding: options?.encoding === 'buffer' ? undefined : (options?.encoding ?? 'utf8'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runText(command: string, args: string[], cwd?: string) {
  return String(run(command, args, { cwd, encoding: 'utf8' })).trim();
}

function ensureCommand(command: string) {
  try {
    runText('bash', ['-lc', `command -v ${command}`]);
  } catch {
    throw new Error(`${command} not found`);
  }
}

function listAuthorizedDevices() {
  const output = runText('adb', ['devices', '-l']);
  const lines = output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
  return lines
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 3);
      return { serial, state: state ?? '', raw: line };
    })
    .filter((entry) => entry.state === 'device');
}

function resolveSerial() {
  const cliSerialArg = process.argv.find((value) => value.startsWith('--serial='));
  const requestedSerial = cliSerialArg ? cliSerialArg.slice('--serial='.length) : process.env.ANDROID_SERIAL?.trim();
  const devices = listAuthorizedDevices();
  if (devices.length === 0) {
    const raw = runText('adb', ['devices', '-l']);
    throw new Error(`adb device not found\n${raw}`);
  }
  if (requestedSerial) {
    const matched = devices.find((device) => device.serial === requestedSerial);
    if (!matched) {
      throw new Error(`requested device not found: ${requestedSerial}\n${devices.map((device) => device.raw).join('\n')}`);
    }
    return matched.serial;
  }
  if (devices.length > 1) {
    throw new Error(`multiple adb devices found; set ANDROID_SERIAL or pass --serial=<serial>\n${devices.map((device) => device.raw).join('\n')}`);
  }
  return devices[0].serial;
}

function adb(serial: string, args: string[], options?: { encoding?: BufferEncoding | 'buffer' }) {
  return run('adb', ['-s', serial, ...args], { encoding: options?.encoding ?? 'utf8' });
}

function adbText(serial: string, args: string[]) {
  return String(adb(serial, args, { encoding: 'utf8' })).trim();
}

function ensureFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`required file not found: ${path}`);
  }
}

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function collectRawLogcat(serial: string) {
  return adbText(serial, ['logcat', '-d', '-v', 'time']);
}

function collectStartupLogLines(logcat: string) {
  return logcat
    .split(/\r?\n/)
    .filter((line) => (
      line.includes('com.zterm.android')
      || line.includes('com.zterm.android/.MainActivity')
      || line.includes('com.zterm.android/com.zterm.android.MainActivity')
      || line.includes('Splash Screen com.zterm.android')
    ))
    .slice(-400);
}

function summarizeStartupLog(lines: string[]) {
  const joined = lines.join('\n');
  return {
    activityStart: /ActivityTaskManager: START u0 .*cmp=com\.zterm\.android\/\.MainActivity/u.test(joined),
    windowFocus: /Changing focus .*com\.zterm\.android\/com\.zterm\.android\.MainActivity/u.test(joined),
    firstWindowDrawn: /first real window is shown/u.test(joined),
    splashRemoved: /Splash Screen com\.zterm\.android EXITING/u.test(joined),
    nativeLifecycle: {
      onCreate: joined.includes(`${TAG}: onCreate()`),
      onStart: joined.includes(`${TAG}: onStart()`),
      onResume: joined.includes(`${TAG}: onResume()`),
    },
  };
}

function collectStartupLog(serial: string) {
  const raw = collectRawLogcat(serial);
  const lines = collectStartupLogLines(raw);
  return {
    raw,
    lines,
    summary: summarizeStartupLog(lines),
  };
}

function captureActivityDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'activity', 'activities']);
}

function captureWindowDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'window', 'windows']);
}

function capturePolicyDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'window', 'policy']);
}

function capturePowerDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'power']);
}

function ensureInteractiveDevice(serial: string) {
  adbText(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adbText(serial, ['shell', 'wm', 'dismiss-keyguard']);
  adbText(serial, ['shell', 'input', 'keyevent', '82']);
  adbText(serial, ['shell', 'input', 'swipe', '600', '2200', '600', '800']);
  sleep(1000);

  const powerDump = capturePowerDump(serial);
  const policyDump = capturePolicyDump(serial);
  const awake = /mWakefulness=Awake/m.test(powerDump) || /interactiveState=INTERACTIVE_STATE_AWAKE/m.test(policyDump);
  const keyguardShowing = /showing=true/m.test(policyDump) || /mKeyguardShowing=true/m.test(captureActivityDump(serial));
  if (!awake || keyguardShowing) {
    throw new Error(
      `device not ready for apk smoke; unlock the phone and keep screen on, then rerun\n--- power ---\n${powerDump}\n--- policy ---\n${policyDump}`,
    );
  }
}

function waitForForeground(serial: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastActivityDump = '';
  while (Date.now() < deadline) {
    lastActivityDump = captureActivityDump(serial);
    const resumed = /ResumedActivity: .*com\.zterm\.android\/\.MainActivity/m.test(lastActivityDump);
    const topResumed = /topResumedActivity=.*com\.zterm\.android\/\.MainActivity/m.test(lastActivityDump);
    const focused = /mFocusedApp=.*com\.zterm\.android\/\.MainActivity/m.test(lastActivityDump);
    if (resumed || topResumed || focused) {
      return lastActivityDump;
    }
    sleep(500);
  }
  throw new Error(`apk smoke app not in foreground within ${timeoutMs}ms\n${lastActivityDump}`);
}

let currentEvidenceDir = '';
let currentSerial = '';

function main() {
  ensureCommand('adb');
  ensureCommand('pnpm');
  const serial = resolveSerial();
  const evidenceDir = resolve(ROOT_DIR, 'evidence', 'android-apk-smoke', timestamp());
  currentSerial = serial;
  currentEvidenceDir = evidenceDir;
  mkdirSync(evidenceDir, { recursive: true });

  console.log(`[android-apk-smoke] serial=${serial}`);
  console.log('[android-apk-smoke] ensure device interactive');
  ensureInteractiveDevice(serial);

  console.log('[android-apk-smoke] build debug apk');
  run('pnpm', ['run', 'build:android'], { cwd: ROOT_DIR, encoding: 'utf8' });
  ensureFile(APK_PATH);

  console.log('[android-apk-smoke] clear logcat');
  adbText(serial, ['logcat', '-c']);

  console.log('[android-apk-smoke] force-stop previous app instance');
  adbText(serial, ['shell', 'am', 'force-stop', APP_ID]);

  console.log('[android-apk-smoke] install apk');
  const installOutput = adbText(serial, ['install', '-r', APK_PATH]);
  if (!installOutput.includes('Success')) {
    throw new Error(`apk install failed\n${installOutput}`);
  }

  console.log('[android-apk-smoke] start activity');
  const startOutput = adbText(serial, ['shell', 'am', 'start', '-W', '-n', ACTIVITY]);
  if (/^Error:/m.test(startOutput) || !/Status:\s+ok/m.test(startOutput)) {
    throw new Error(`apk start failed\n${startOutput}`);
  }

  const activityDump = waitForForeground(serial, 10000);
  const windowDump = captureWindowDump(serial);
  const policyDump = capturePolicyDump(serial);
  const powerDump = capturePowerDump(serial);
  const startupLog = collectStartupLog(serial);
  const pidOutput = adbText(serial, ['shell', 'pidof', APP_ID]);
  if (!pidOutput) {
    throw new Error('apk smoke pidof returned empty result');
  }

  console.log('[android-apk-smoke] capture screenshot');
  const screenshot = adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' }) as Buffer;
  if (!Buffer.isBuffer(screenshot) || screenshot.length === 0) {
    throw new Error('apk smoke screenshot capture failed');
  }

  const deviceInfo = adbText(serial, ['shell', 'getprop', 'ro.product.model']);
  const androidRelease = adbText(serial, ['shell', 'getprop', 'ro.build.version.release']);
  const installPath = adbText(serial, ['shell', 'pm', 'path', APP_ID]);

  writeFileSync(resolve(evidenceDir, 'install.txt'), `${installOutput}\n`);
  writeFileSync(resolve(evidenceDir, 'start.txt'), `${startOutput}\n`);
  writeFileSync(resolve(evidenceDir, 'startup-logcat.txt'), `${startupLog.lines.join('\n')}\n`);
  writeFileSync(resolve(evidenceDir, 'activity-dump.txt'), `${activityDump}\n`);
  writeFileSync(resolve(evidenceDir, 'window-dump.txt'), `${windowDump}\n`);
  writeFileSync(resolve(evidenceDir, 'policy-dump.txt'), `${policyDump}\n`);
  writeFileSync(resolve(evidenceDir, 'power-dump.txt'), `${powerDump}\n`);
  writeFileSync(resolve(evidenceDir, 'pid.txt'), `${pidOutput}\n`);
  writeFileSync(resolve(evidenceDir, 'device.txt'), `serial=${serial}\nmodel=${deviceInfo}\nandroid=${androidRelease}\n${installPath}\n`);
  writeFileSync(resolve(evidenceDir, 'launch.png'), screenshot);
  writeFileSync(
    resolve(evidenceDir, 'summary.json'),
    JSON.stringify(
      {
        ok: true,
        serial,
        model: deviceInfo,
        androidRelease,
        apkPath: APK_PATH,
        installPath,
        pid: pidOutput,
        startupMarkers: startupLog.summary,
        evidenceDir,
      },
      null,
      2,
    ),
  );

  console.log(`[android-apk-smoke] PASS evidence=${evidenceDir}`);
}

try {
  main();
} catch (error) {
  if (currentEvidenceDir && currentSerial) {
    try {
      const startupLog = collectStartupLog(currentSerial);
      writeFileSync(resolve(currentEvidenceDir, 'failure-logcat.txt'), `${startupLog.lines.join('\n')}\n`);
      writeFileSync(resolve(currentEvidenceDir, 'failure-activity-dump.txt'), `${captureActivityDump(currentSerial)}\n`);
      writeFileSync(resolve(currentEvidenceDir, 'failure-window-dump.txt'), `${captureWindowDump(currentSerial)}\n`);
      writeFileSync(resolve(currentEvidenceDir, 'failure-policy-dump.txt'), `${capturePolicyDump(currentSerial)}\n`);
      writeFileSync(resolve(currentEvidenceDir, 'failure-power-dump.txt'), `${capturePowerDump(currentSerial)}\n`);
      writeFileSync(
        resolve(currentEvidenceDir, 'failure-summary.json'),
        JSON.stringify({
          ok: false,
          serial: currentSerial,
          error: error instanceof Error ? error.message : String(error),
          startupMarkers: startupLog.summary,
        }, null, 2),
      );
    } catch (artifactError) {
      console.error(`[android-apk-smoke] FAIL evidence capture: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`);
    }
  }
  console.error(`[android-apk-smoke] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

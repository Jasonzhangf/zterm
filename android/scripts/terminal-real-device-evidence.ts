#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';
import { extractApkSmokeBridgeDebugTargetFromLocalStorageSnapshot } from '../src/lib/android-apk-smoke-device-bridge-target';
import {
  filterApkSmokeRuntimeSnapshot,
  resolveApkSmokeDaemonSessionId,
  resolveApkSmokeSnapshotActiveSessionId,
  selectFreshApkSmokeSnapshotRecord,
} from '../src/lib/android-apk-smoke-runtime-freshness';
import { isApkSmokeClientInputSendScope } from '../src/lib/android-apk-smoke-runtime-verifier';
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
const WEBVIEW_DEVTOOLS_FORWARD_PORT = 19222;
const WEBVIEW_CDP_RETRY_COUNT = 8;
const WEBVIEW_CDP_RETRY_DELAY_MS = 300;
const RUNTIME_FETCH_RETRY_COUNT = 4;
const RUNTIME_FETCH_RETRY_DELAY_MS = 500;

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

function resolveDaemonAuthToken() {
  const fromEnvironment = process.env.ZTERM_DAEMON_AUTH_TOKEN?.trim();
  if (fromEnvironment) {
    return fromEnvironment;
  }
  try {
    const config = JSON.parse(readFileSync(resolve(homedir(), '.zterm/config.json'), 'utf8')) as {
      mobile?: { daemon?: { authToken?: unknown } };
    };
    const fromConfig = config.mobile?.daemon?.authToken;
    return typeof fromConfig === 'string' ? fromConfig.trim() : '';
  } catch {
    return '';
  }
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
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      adbText(serial, ['shell', 'uiautomator', 'dump', path]);
      return adbText(serial, ['shell', 'cat', path]);
    } catch (error) {
      lastError = error;
      sleep(500 * attempt);
    }
  }
  throw lastError;
}

function captureInputMethodDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'input_method']);
}

function captureWindowDump(serial: string) {
  return adbText(serial, ['shell', 'dumpsys', 'window', 'windows']);
}

function resolveWebViewDevtoolsSocket(serial: string) {
  const unixSockets = adbText(serial, ['shell', 'cat', '/proc/net/unix']);
  const match = unixSockets.match(/@webview_devtools_remote_\d+/u);
  return match?.[0] || '';
}

async function fetchWebViewDevtoolsPages() {
  try {
    const response = await fetch(`http://127.0.0.1:${WEBVIEW_DEVTOOLS_FORWARD_PORT}/json/list`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  } catch (error) {
    throw new Error(`CDP target discovery fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function evaluateWebViewExpressionOnce(serial: string, expression: string) {
  const socketName = resolveWebViewDevtoolsSocket(serial);
  if (!socketName) {
    fail('could not find the running Android WebView DevTools socket');
  }
  adbText(serial, ['forward', `tcp:${WEBVIEW_DEVTOOLS_FORWARD_PORT}`, `localabstract:${socketName.slice(1)}`]);
  const pages = await fetchWebViewDevtoolsPages();
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  const webSocketDebuggerUrl = page?.webSocketDebuggerUrl;
  if (!webSocketDebuggerUrl) {
    fail('running Android WebView has no debuggable page target');
  }

  return await new Promise<unknown>((resolveResult, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const requestId = 1;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('timed out evaluating the current Android WebView through CDP'));
    }, 5_000);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('message', (raw) => {
      let message: {
        id?: number;
        error?: unknown;
        result?: { result?: { value?: unknown } };
      };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`CDP returned malformed message: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (message.id !== requestId) {
        return;
      }
      clearTimeout(timeout);
      if (message.error) {
        socket.close();
        reject(new Error(`CDP Runtime.evaluate failed: ${JSON.stringify(message.error)}`));
        return;
      }
      const value = message.result?.result?.value;
      if (value === undefined) {
        socket.close();
        reject(new Error('CDP Runtime.evaluate returned no value'));
        return;
      }
      socket.close();
      resolveResult(value);
    });
    socket.once('open', () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
        },
      }));
    });
  });
}

async function evaluateWebViewExpression(serial: string, expression: string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= WEBVIEW_CDP_RETRY_COUNT; attempt += 1) {
    try {
      return await evaluateWebViewExpressionOnce(serial, expression);
    } catch (error) {
      lastError = error;
      if (attempt < WEBVIEW_CDP_RETRY_COUNT) {
        sleep(WEBVIEW_CDP_RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(
    `CDP Runtime.evaluate failed after ${WEBVIEW_CDP_RETRY_COUNT} target rediscovery attempts: `
      + `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function readWebViewLocalStorageSnapshot(serial: string) {
  const snapshotValue = await evaluateWebViewExpression(
    serial,
    'Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))',
  );
  let snapshot: Record<string, unknown>;
  if (!snapshotValue || typeof snapshotValue !== 'object' || Array.isArray(snapshotValue)) {
    fail('CDP Runtime.evaluate returned no localStorage snapshot');
  }
  snapshot = snapshotValue as Record<string, unknown>;
  return { snapshot };
}

async function inspectWebViewTerminalFocus(serial: string) {
  const value = await evaluateWebViewExpression(
    serial,
    `(() => {
      const quickBar = document.querySelector('[data-testid="terminal-quickbar-shell"]');
      const keyboardButton = document.querySelector('button[aria-label="键盘"]');
      const activeElement = document.activeElement;
      return {
        keyboardButton: Boolean(keyboardButton),
        keyboardVisible: quickBar?.getAttribute('data-keyboard-visible') === 'true',
        activeElement: activeElement?.tagName || '',
        activeElementTerminalSessionId: activeElement?.getAttribute?.('data-terminal-input-session-id') || '',
      };
    })()`,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('could not inspect terminal focus state through the current Android WebView');
  }
  return value as Record<string, unknown>;
}

function inspectNativeTerminalIme(serial: string) {
  const dump = captureInputMethodDump(serial);
  const servedView = dump
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('mServedView=') && /ImeAnchor(?:EditText|Plugin)/u.test(line))
    ?.slice('mServedView='.length)
    .trim() || '';
  return {
    shown: /mInputShown=true/m.test(dump),
    servedImeAnchor: /mServedView=.*ImeAnchor(?:EditText|Plugin)/m.test(dump),
    servedView,
  };
}

async function clickWebViewKeyboardButton(serial: string) {
  const value = await evaluateWebViewExpression(
    serial,
    `(() => {
      const button = document.querySelector('button[aria-label="键盘"]');
      if (!(button instanceof HTMLButtonElement)) {
        return { clicked: false, keyboardButton: false };
      }
      const rect = button.getBoundingClientRect();
      return {
        clicked: true,
        keyboardButton: true,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    })()`,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).clicked !== true) {
    fail('current Android WebView has no clickable terminal keyboard button');
  }
  const centerX = Number((value as Record<string, unknown>).centerX);
  const centerY = Number((value as Record<string, unknown>).centerY);
  const viewportWidth = Number((value as Record<string, unknown>).viewportWidth);
  const viewportHeight = Number((value as Record<string, unknown>).viewportHeight);
  if (
    !Number.isFinite(centerX)
    || !Number.isFinite(centerY)
    || !Number.isFinite(viewportWidth)
    || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) {
    fail(`terminal keyboard button has invalid bounds: ${JSON.stringify(value)}`);
  }
  const displaySize = adbText(serial, ['shell', 'wm', 'size']).match(/Physical size:\s*(\d+)x(\d+)/);
  const displayWidth = displaySize ? Number.parseInt(displaySize[1]!, 10) : viewportWidth;
  const displayHeight = displaySize ? Number.parseInt(displaySize[2]!, 10) : viewportHeight;
  adbText(serial, [
    'shell',
    'input',
    'tap',
    String(Math.round((centerX / viewportWidth) * displayWidth)),
    String(Math.round((centerY / viewportHeight) * displayHeight)),
  ]);
  return true;
}

async function ensureWebViewTerminalPage(serial: string, sessionName?: string, bridgeHost?: string) {
  let resumeRequested = false;
  let connectionRequested = false;
  const deadline = Date.now() + 12_000;
  while (Date.now() <= deadline) {
    try {
      const connectionClick = bridgeHost && !connectionRequested
        ? `const ariaLabel = 'Open ' + ${JSON.stringify(bridgeHost)};
           const connection = buttons.find((candidate) => (
             candidate.getAttribute('aria-label') === ariaLabel
             || candidate.getAttribute('data-testid') === 'saved-connection-open'
           ));
           if (connection) {
             connection.click();
             return { terminalPage: false, resumed: false, connectionRequested: true, button: ariaLabel };
           }`
        : '';
      const value = await evaluateWebViewExpression(
        serial,
        `(() => {
          const terminal = document.querySelector('[data-testid="terminal-quickbar-shell"]');
          if (terminal) {
            return { terminalPage: true, resumed: false, button: '' };
          }
          const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
          const button = buttons.find((candidate) => (
            candidate.getAttribute('aria-label')?.startsWith('Resume ')
          ));
          if (button instanceof HTMLButtonElement) {
            button.click();
            return { terminalPage: false, resumed: true, button: button.getAttribute('aria-label') || '' };
          }
          ${connectionClick}
          return { terminalPage: false, resumed: false, connectionRequested: false, button: '' };
        })()`,
      );
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('could not inspect the current Android WebView page before terminal resume');
      }
      const state = value as Record<string, unknown>;
      if (state.terminalPage === true) {
        return;
      }
      if (state.resumed === true) {
        resumeRequested = true;
      } else if (state.connectionRequested === true) {
        connectionRequested = true;
      } else if (!resumeRequested && !connectionRequested) {
        fail(`current Android WebView is not Terminal and has no Resume button for ${sessionName || 'the active session'}`);
      }
    } catch (error) {
      if (!resumeRequested) {
        throw error;
      }
    }
    sleep(250);
  }
  fail('Resume/connection button did not open the Terminal page before the bounded verifier deadline');
}

async function establishAuthenticatedBridgeSettings(serial: string) {
  const authToken = resolveDaemonAuthToken();
  if (!authToken) {
    fail('live-gate fixture could not resolve the daemon auth token from ZTERM_DAEMON_AUTH_TOKEN or ~/.zterm/config.json');
  }
  const value = await evaluateWebViewExpression(
    serial,
    `(() => {
      const key = 'zterm:bridge-settings';
      const settings = JSON.parse(localStorage.getItem(key) || '{}');
      const authToken = ${JSON.stringify(authToken)};
      settings.targetHost = '127.0.0.1';
      settings.targetPort = 3333;
      settings.targetAuthToken = authToken;
      settings.servers = (Array.isArray(settings.servers) ? settings.servers : []).map((server) => (
        server.id === '127.0.0.1:3333'
          ? { ...server, targetHost: '127.0.0.1', targetPort: 3333, authToken }
          : server
      ));
      localStorage.setItem(key, JSON.stringify(settings));
      return { configured: true, serverCount: settings.servers.length };
    })()`,
  );
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).configured !== true) {
    fail(`live-gate fixture could not establish authenticated bridge settings: ${JSON.stringify(value)}`);
  }
  await evaluateWebViewExpression(serial, 'location.reload(); true');
  sleep(1_000);
}

async function ensureWebViewTerminalImeFocus(serial: string) {
  const initialState = await inspectWebViewTerminalFocus(serial);
  if (initialState.keyboardVisible === true) {
    await clickWebViewKeyboardButton(serial);
    const hideDeadline = Date.now() + 5_000;
    while (Date.now() <= hideDeadline) {
      sleep(250);
      const state = await inspectWebViewTerminalFocus(serial);
      if (state.keyboardVisible !== true) {
        break;
      }
    }
  }

  await clickWebViewKeyboardButton(serial);
  const showDeadline = Date.now() + 8_000;
  let finalState = await inspectWebViewTerminalFocus(serial);
  let nativeState = inspectNativeTerminalIme(serial);
  while (Date.now() <= showDeadline) {
    nativeState = inspectNativeTerminalIme(serial);
    if (nativeState.shown && nativeState.servedImeAnchor) {
      break;
    }
    sleep(250);
    finalState = await inspectWebViewTerminalFocus(serial);
  }
  if (!nativeState.shown || !nativeState.servedImeAnchor) {
    fail(`terminal keyboard button did not establish native IME focus: ${JSON.stringify({ dom: finalState, native: nativeState })}`);
  }
  return {
    ...finalState,
    nativeImeShown: nativeState.shown,
    nativeImeServedView: nativeState.servedImeAnchor,
    nativeImeServedViewText: nativeState.servedView,
    keyboardButtonTapped: true,
  };
}

function addToken(url: URL, token?: string) {
  if (token?.trim()) {
    url.searchParams.set('token', token.trim());
  }
}

async function fetchJson(url: URL, init?: RequestInit) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= RUNTIME_FETCH_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      if (!response.ok) {
        fail(`request failed (${response.status}) ${url.href}: ${text}`);
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        fail(`invalid json from ${url.href}: ${error instanceof Error ? error.message : String(error)}\n${text}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < RUNTIME_FETCH_RETRY_COUNT) {
        sleep(RUNTIME_FETCH_RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(
    `runtime evidence request failed after ${RUNTIME_FETCH_RETRY_COUNT} attempts (${url.href}): `
      + `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
  const initialSnapshotUrl = new URL('/debug/runtime', baseUrl);
  addToken(initialSnapshotUrl, remote.authToken);
  const controlUrl = new URL('/debug/runtime/control', baseUrl);
  addToken(controlUrl, remote.authToken);
  const initialSnapshot = await fetchJson(initialSnapshotUrl) as Record<string, unknown>;
  const daemonSessionId = remote.sessionId
    ? resolveApkSmokeDaemonSessionId(initialSnapshot, remote.sessionId)
    : null;
  const health = await fetchJson(healthUrl);
  const control = await fetchJson(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      reason: RUNTIME_DEBUG_REASON,
      sessionId: daemonSessionId || remote.sessionId || undefined,
    }),
  });
  const snapshot = await fetchJson(initialSnapshotUrl);
  const logsUrl = new URL('/debug/runtime/logs', baseUrl);
  addToken(logsUrl, remote.authToken);
  logsUrl.searchParams.set('limit', '400');
  const logs = await fetchJson(logsUrl);
  return { health, control, snapshot, logs, daemonSessionId };
}

function safeParseRuntimePayload(payload: unknown) {
  if (typeof payload !== 'string' || !payload.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function entryEpochMs(entry: Record<string, unknown>) {
  const candidates = [entry.ingestedAt, entry.ts];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function readLogEntries(logs: unknown, key: 'entries' | 'daemonEntries') {
  return Array.isArray((logs as Record<string, unknown> | null)?.[key])
    ? ((logs as Record<string, unknown>)[key] as Array<Record<string, unknown>>)
    : [];
}

function payloadMentionsSession(entry: Record<string, unknown>, sessionId: string | null) {
  if (!sessionId) {
    return true;
  }
  const payload = typeof entry.payload === 'string' ? entry.payload : '';
  return payload.includes(`"sessionId":"${sessionId}"`);
}

function extractInputEvidence(
  logs: unknown,
  sessionId: string | null,
  daemonSessionId: string | null,
  minimumTimestamp: string,
) {
  const minimumEpochMs = Date.parse(minimumTimestamp);
  const entries = readLogEntries(logs, 'entries')
    .filter((entry) => !Number.isFinite(minimumEpochMs) || entryEpochMs(entry) >= minimumEpochMs);
  const daemonEntries = readLogEntries(logs, 'daemonEntries')
    .filter((entry) => !Number.isFinite(minimumEpochMs) || entryEpochMs(entry) >= minimumEpochMs);
  const parsed = parseRuntimeSequenceEntries(entries.map((entry) => ({
    seq: typeof entry.seq === 'number' ? entry.seq : undefined,
    ts: typeof entry.ts === 'string' ? entry.ts : undefined,
    scope: typeof entry.scope === 'string' ? entry.scope : undefined,
    payload: typeof entry.payload === 'string' ? entry.payload : null,
  })));
  const filtered = sessionId ? parsed.filter((entry) => entry.sessionId === sessionId) : parsed;
  const rawSessionEntries = sessionId
    ? entries.filter((entry) => payloadMentionsSession(entry, sessionId))
    : entries;
  const physicalSessionIds = new Set<string>();
  for (const entry of entries) {
    const payload = safeParseRuntimePayload(entry.payload);
    if (sessionId && payload?.sessionId !== sessionId) {
      continue;
    }
    if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
      physicalSessionIds.add(entry.sessionId.trim());
    }
  }
  const daemonFiltered = daemonEntries.filter((entry) => {
    const entrySessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
    return Boolean(entrySessionId) && (
      Boolean(daemonSessionId && entrySessionId === daemonSessionId)
      || physicalSessionIds.has(entrySessionId)
    );
  });
  const anomalyInputsByPhysicalSession = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of rawSessionEntries) {
    const physicalSessionId = typeof entry.sessionId === 'string' && entry.sessionId.trim()
      ? entry.sessionId.trim()
      : '__unknown__';
    const current = anomalyInputsByPhysicalSession.get(physicalSessionId) || [];
    current.push(entry);
    anomalyInputsByPhysicalSession.set(physicalSessionId, current);
  }
  const anomalies = Array.from(anomalyInputsByPhysicalSession.values()).flatMap((sessionEntries) => (
    detectRuntimeSequenceAnomalies(parseRuntimeSequenceEntries(sessionEntries.map((entry) => ({
      seq: typeof entry.seq === 'number' ? entry.seq : undefined,
      ts: typeof entry.ts === 'string' ? entry.ts : undefined,
      scope: typeof entry.scope === 'string' ? entry.scope : undefined,
      payload: typeof entry.payload === 'string' ? entry.payload : null,
    }))))
  ));
  const latestScopes = filtered.slice(-30).map((entry) => entry.scope);
  return {
    parsed,
    filtered,
    physicalSessionIds: Array.from(physicalSessionIds),
    daemonFiltered,
    anomalies,
    checks: {
      clientInputSend: filtered.some((entry) => isApkSmokeClientInputSendScope(entry.scope)),
      daemonInputReceive: daemonFiltered.some((entry) => entry.scope === 'input-receive'),
      daemonInputWrite: daemonFiltered.some((entry) => entry.scope === 'input-write'),
      bufferHead: filtered.some((entry) => entry.scope === 'session.buffer.head'),
      bufferApplied: filtered.some((entry) => entry.scope === 'session.buffer.applied'),
      renderCommit: rawSessionEntries.some((entry) => entry.scope === 'session.render-gate.flush.inspect'),
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
  ensureInteractiveDevice(serial);
  adbText(serial, ['shell', 'cmd', 'statusbar', 'collapse']);
  const activityDump = waitForForeground(serial, 10_000);
  await establishAuthenticatedBridgeSettings(serial);
  const launchPng = capturePng(serial);
  const beforeImeUi = captureUiDump(serial);
  const beforeImeInputMethod = captureInputMethodDump(serial);
  const beforeImeWindow = captureWindowDump(serial);
  assertAppSurfaceVisible(beforeImeUi, beforeImeWindow, 'before-ime');

  const webViewStorage = await readWebViewLocalStorageSnapshot(serial);
  let storageTarget = extractApkSmokeBridgeDebugTargetFromLocalStorageSnapshot(webViewStorage.snapshot);
  if (!storageTarget.target) {
    fail(`could not resolve active bridge target from current Android WebView localStorage truth (activeSessionId=${storageTarget.activeSessionId || 'null'})`);
  }

  await ensureWebViewTerminalPage(serial, storageTarget.target.sessionName, storageTarget.target.bridgeHost);
  const navigatedStorage = await readWebViewLocalStorageSnapshot(serial);
  const navigatedTarget = extractApkSmokeBridgeDebugTargetFromLocalStorageSnapshot(navigatedStorage.snapshot);
  if (navigatedTarget.target) {
    storageTarget = navigatedTarget;
  }

  const initialTarget = storageTarget.target;
  if (!initialTarget) {
    fail(`could not resolve active bridge target after opening terminal (activeSessionId=${storageTarget.activeSessionId || 'null'})`);
  }
  let bridgeTarget: NonNullable<typeof storageTarget.target> = initialTarget;
  let runtimeClientSessionId = bridgeTarget.sessionId || null;
  let baselineRuntime = await collectRuntime({
    ...bridgeTarget,
    sessionId: runtimeClientSessionId,
  });
  const startupReadyDeadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() <= startupReadyDeadline) {
    const refreshedStorage = await readWebViewLocalStorageSnapshot(serial);
    const refreshedTarget = extractApkSmokeBridgeDebugTargetFromLocalStorageSnapshot(refreshedStorage.snapshot);
    if (refreshedTarget.target && (refreshedTarget.activeSessionId || refreshedTarget.target.sessionId)) {
      storageTarget = refreshedTarget;
      bridgeTarget = refreshedTarget.target;
      runtimeClientSessionId = refreshedTarget.activeSessionId || refreshedTarget.target.sessionId || null;
    }
    baselineRuntime = await collectRuntime({
      ...bridgeTarget,
      sessionId: runtimeClientSessionId,
    });
    baselineRuntime.snapshot = filterRuntimeSnapshotForDevice(
      filterApkSmokeRuntimeSnapshot(baselineRuntime.snapshot, smokeStartedAt) as Record<string, unknown>,
      deviceModel,
    );
    const currentSnapshotSessionId = resolveApkSmokeSnapshotActiveSessionId(
      selectFreshApkSmokeSnapshotRecord(baselineRuntime.snapshot, smokeStartedAt),
    );
    if (currentSnapshotSessionId && currentSnapshotSessionId !== runtimeClientSessionId) {
      runtimeClientSessionId = currentSnapshotSessionId;
      baselineRuntime = await collectRuntime({
        ...bridgeTarget,
        sessionId: runtimeClientSessionId,
      });
      continue;
    }
    const currentDaemonSessionId = resolveApkSmokeDaemonSessionId(
      baselineRuntime.snapshot,
      runtimeClientSessionId,
    );
    const currentRecord = selectFreshApkSmokeSnapshotRecord(baselineRuntime.snapshot, smokeStartedAt);
    const currentSnapshot = currentRecord?.snapshot as Record<string, unknown> | undefined;
    const currentTerminalPage = (
      currentSnapshot
      && typeof currentSnapshot === 'object'
      && typeof currentSnapshot.sources === 'object'
      && currentSnapshot.sources
      && typeof (currentSnapshot.sources as Record<string, unknown>)['terminal-page'] === 'object'
    )
      ? (currentSnapshot.sources as Record<string, unknown>)['terminal-page'] as Record<string, unknown>
      : null;
    if (
      currentDaemonSessionId
      && currentTerminalPage?.activeSessionState === 'connected'
      && currentTerminalPage.activeSessionId === runtimeClientSessionId
    ) {
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }
  baselineRuntime.snapshot = filterRuntimeSnapshotForDevice(
    filterApkSmokeRuntimeSnapshot(baselineRuntime.snapshot, smokeStartedAt) as Record<string, unknown>,
    deviceModel,
  );
  const snapshotSessionId = resolveApkSmokeSnapshotActiveSessionId(
    selectFreshApkSmokeSnapshotRecord(baselineRuntime.snapshot, smokeStartedAt),
  );
  const evidenceSessionId = runtimeClientSessionId || snapshotSessionId || null;
  const baselineDaemonSessionId = resolveApkSmokeDaemonSessionId(
    baselineRuntime.snapshot,
    evidenceSessionId,
  );
  if (evidenceSessionId && !baselineDaemonSessionId) {
    fail(`daemon subscriber for client session ${evidenceSessionId} was not found after startup stabilization`);
  }
  if (!evidenceSessionId) {
    fail('current active client session was not resolved after startup stabilization');
  }

  await ensureWebViewTerminalPage(serial, bridgeTarget.sessionName, bridgeTarget.bridgeHost);
  const terminalFocusState = await ensureWebViewTerminalImeFocus(serial);
  sleep(500);
  const afterImePng = capturePng(serial);
  const afterImeUi = captureUiDump(serial);
  const afterImeInputMethod = captureInputMethodDump(serial);
  const afterImeWindow = captureWindowDump(serial);
  assertAppSurfaceVisible(afterImeUi, afterImeWindow, 'after-ime');

  adbText(serial, ['shell', 'input', 'text', INPUT_SAMPLE]);
  sleep(400);
  adbText(serial, ['shell', 'input', 'keyevent', '66']);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let finalRuntime = baselineRuntime;
  let finalActiveSessionId = evidenceSessionId;
  let finalEvidence = extractInputEvidence(
    baselineRuntime.logs,
    evidenceSessionId,
    baselineRuntime.daemonSessionId,
    smokeStartedAt,
  );

  while (Date.now() <= deadline) {
    finalRuntime = await collectRuntime({
      ...bridgeTarget,
      sessionId: runtimeClientSessionId,
    });
    finalRuntime.snapshot = filterRuntimeSnapshotForDevice(
      filterApkSmokeRuntimeSnapshot(finalRuntime.snapshot, smokeStartedAt) as Record<string, unknown>,
      deviceModel,
    );
    const currentSnapshotSessionId = resolveApkSmokeSnapshotActiveSessionId(
      selectFreshApkSmokeSnapshotRecord(finalRuntime.snapshot, smokeStartedAt),
    );
    if (currentSnapshotSessionId && currentSnapshotSessionId !== runtimeClientSessionId) {
      runtimeClientSessionId = currentSnapshotSessionId;
      continue;
    }
    finalActiveSessionId = runtimeClientSessionId || currentSnapshotSessionId || evidenceSessionId;
    finalEvidence = extractInputEvidence(
      finalRuntime.logs,
      finalActiveSessionId,
      finalRuntime.daemonSessionId,
      smokeStartedAt,
    );
    if (
      finalActiveSessionId
      && finalEvidence.checks.clientInputSend
      && finalEvidence.checks.daemonInputReceive
      && finalEvidence.checks.daemonInputWrite
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
  writeFileSync(resolve(evidenceDir, 'terminal-focus-state.json'), `${JSON.stringify(terminalFocusState, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'webview-local-storage.json'), `${JSON.stringify(webViewStorage, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'webview-bridge-target.json'), `${JSON.stringify(storageTarget, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-health.json'), `${JSON.stringify(finalRuntime.health, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-debug-control.json'), `${JSON.stringify(finalRuntime.control, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-snapshot.json'), `${JSON.stringify(finalRuntime.snapshot, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'runtime-logs.json'), `${JSON.stringify(finalRuntime.logs, null, 2)}\n`);
  writeFileSync(resolve(evidenceDir, 'timeline.txt'), `${timeline}\n`);

  finalActiveSessionId = runtimeClientSessionId || resolveApkSmokeSnapshotActiveSessionId(
    selectFreshApkSmokeSnapshotRecord(finalRuntime.snapshot, smokeStartedAt),
  ) || evidenceSessionId;
  const summary = {
    ok: Boolean(finalActiveSessionId)
      && finalEvidence.checks.clientInputSend
      && finalEvidence.checks.daemonInputReceive
      && finalEvidence.checks.daemonInputWrite
      && finalEvidence.checks.bufferApplied
      && finalEvidence.checks.renderCommit
      && finalEvidence.checks.noLocalTruthAnomaly,
    serial,
    apkPath,
    activeSessionId: finalActiveSessionId,
    daemonSessionId: finalRuntime.daemonSessionId || null,
    smokeStartedAt,
    deviceModel,
    bridgeHost: bridgeTarget.bridgeHost,
    bridgePort: bridgeTarget.bridgePort,
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

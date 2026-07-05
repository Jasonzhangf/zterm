#!/usr/bin/env node
/**
 * Mac alpha P0 packaged smoke.
 *
 * Current cases:
 * - header-restore: packaged cold restore + active-only eager connect + terminal
 *   header disconnect/reconnect controls.
 *
 * This script uses only dedicated tmux sessions with a marker option and cleans
 * them up by explicit name at the end. It does not write to user sessions.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const ROOT = resolve(new URL('..', import.meta.url).pathname, '..');
const MAC_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DATE = new Date().toISOString().slice(0, 10);
const DEFAULT_PORT = 9363;
const SMOKE_OWNER = 'alpha-p0-header-restore';
const SMOKE_OWNER_OPTION = '@zterm_mac_smoke_owner';
const SMOKE_CASE_OPTION = '@zterm_mac_smoke_case';
const ACTIVE_SESSION = 'zterm_mac_alpha_active';
const HIDDEN_SESSION = 'zterm_mac_alpha_hidden';
const PANE_ID = 'pane-alpha-p0';
const ACTIVE_TAB_ID = 'tab-alpha-active';
const HIDDEN_TAB_ID = 'tab-alpha-hidden';

function parseArgs(argv) {
  const out = {
    caseName: 'header-restore',
    port: DEFAULT_PORT,
    evidenceDir: join(MAC_ROOT, 'evidence', `${DATE}-mac-alpha-p0-closeout`, 'header-restore'),
    appPath: join(MAC_ROOT, 'out', 'mac-arm64', 'ZTerm.app'),
    keepApp: false,
    cleanupSessions: true,
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--case=')) out.caseName = arg.slice('--case='.length);
    else if (arg.startsWith('--port=')) out.port = Number.parseInt(arg.slice('--port='.length), 10);
    else if (arg.startsWith('--evidence=')) out.evidenceDir = resolve(ROOT, arg.slice('--evidence='.length));
    else if (arg.startsWith('--app=')) out.appPath = resolve(ROOT, arg.slice('--app='.length));
    else if (arg === '--keep-app') out.keepApp = true;
    else if (arg === '--keep-sessions') out.cleanupSessions = false;
    else if (arg === '--cleanup-sessions') out.cleanupSessions = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.caseName !== 'header-restore') {
    throw new Error(`Unsupported --case=${out.caseName}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port=${out.port}`);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.evidenceDir, { recursive: true });
rmSync(join(options.evidenceDir, 'failure.txt'), { force: true });

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout || '';
}

function runTmux(args, opts) {
  return run('tmux', args, opts);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sessionExists(sessionName) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return result.status === 0;
}

function tmuxSessionOption(sessionName, optionName) {
  return runTmux(['show-option', '-qv', '-t', sessionName, optionName], { allowFailure: true }).trim();
}

function assertSmokeSession(sessionName) {
  const owner = tmuxSessionOption(sessionName, SMOKE_OWNER_OPTION);
  const caseName = tmuxSessionOption(sessionName, SMOKE_CASE_OPTION);
  if (owner !== SMOKE_OWNER || caseName !== options.caseName) {
    throw new Error([
      `Refusing to touch tmux session ${sessionName}: it is not this smoke fixture.`,
      `Expected ${SMOKE_OWNER_OPTION}=${SMOKE_OWNER} and ${SMOKE_CASE_OPTION}=${options.caseName}; got owner=${owner || '<unset>'}, case=${caseName || '<unset>'}.`,
    ].join('\n'));
  }
}

function markSmokeSession(sessionName) {
  runTmux(['set-option', '-q', '-t', sessionName, SMOKE_OWNER_OPTION, SMOKE_OWNER]);
  runTmux(['set-option', '-q', '-t', sessionName, SMOKE_CASE_OPTION, options.caseName]);
}

function ensureSmokeSession(sessionName, label) {
  const command = `sh -lc ${shellQuote(`printf '${label}\\n'; while :; do sleep 3600; done`)}`;
  if (sessionExists(sessionName)) {
    assertSmokeSession(sessionName);
    runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0.0`, command]);
  } else {
    runTmux(['new-session', '-d', '-s', sessionName, command]);
  }
  markSmokeSession(sessionName);
  runTmux(['resize-pane', '-t', sessionName, '-x', '100', '-y', '30'], { allowFailure: true });
  runTmux(['clear-history', '-t', sessionName], { allowFailure: true });
}

function cleanupSmokeSession(sessionName) {
  if (!sessionExists(sessionName)) return;
  assertSmokeSession(sessionName);
  runTmux(['kill-session', '-t', sessionName], { allowFailure: true });
}

function listTmuxSessions() {
  return runTmux([
    'list-sessions',
    '-F',
    '#{session_name} #{?@zterm_mac_smoke_owner,owner=#{@zterm_mac_smoke_owner},owner=-} #{?@zterm_mac_smoke_case,case=#{@zterm_mac_smoke_case},case=-} #{?@zterm_mac_gate_owner,gate=#{@zterm_mac_gate_owner},gate=-}',
  ], { allowFailure: true });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForCdp(port, timeoutMs = 12000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`CDP did not start on ${port}: ${lastError?.message || 'timeout'}`);
}

function psForPort(port) {
  return run('ps', ['-axo', 'pid,ppid,pgid,%cpu,rss,vsz,etime,comm,args'])
    .split('\n')
    .filter((line) => line.includes(`--remote-debugging-port=${port}`))
    .join('\n');
}

function firstPidForPort(port) {
  const line = psForPort(port).split('\n').find(Boolean);
  if (!line) return null;
  const pid = Number.parseInt(line.trim().split(/\s+/u)[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

function captureResourceSample(name) {
  const pid = firstPidForPort(options.port);
  if (!pid) {
    writeFileSync(join(options.evidenceDir, `${name}-process.txt`), '');
    return null;
  }
  const ps = run('ps', ['-p', String(pid), '-o', 'pid,ppid,pgid,%cpu,rss,vsz,etime,comm,args'], { allowFailure: true });
  const top = run('top', ['-pid', String(pid), '-stats', 'pid,cpu,mem,threads,state,time', '-l', '2'], { allowFailure: true });
  writeFileSync(join(options.evidenceDir, `${name}-ps-${pid}.txt`), ps);
  writeFileSync(join(options.evidenceDir, `${name}-top-${pid}.txt`), top);
  return pid;
}

function assertNoExistingCdpOwner(port) {
  const owner = psForPort(port);
  if (owner.trim()) {
    throw new Error(`Refusing to start packaged smoke while CDP port ${port} is already owned:\n${owner}`);
  }
}

async function connectSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const current = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) current.reject(new Error(JSON.stringify(message.error)));
      else current.resolve(message.result);
    }
  });
  const rejectPending = (error) => {
    for (const current of pending.values()) {
      current.reject(error);
    }
    pending.clear();
  };
  ws.on('close', () => rejectPending(new Error('CDP socket closed')));
  ws.on('error', (error) => rejectPending(error));
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen);
    ws.once('error', rejectOpen);
  });
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    id += 1;
    const requestId = id;
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      rejectCall(new Error(`CDP ${method} timed out after 15000ms`));
    }, 15000);
    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolveCall(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        rejectCall(error);
      },
    });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { ws, call };
}

async function connectPage() {
  const targets = await fetchJson(`http://127.0.0.1:${options.port}/json/list`);
  const page = targets.find((target) => target.type === 'page' && /ZTerm Mac/u.test(target.title || ''))
    || targets.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('No ZTerm page target found');
  }
  const socket = await connectSocket(page.webSocketDebuggerUrl);
  await socket.call('Runtime.enable');
  await socket.call('Page.enable');
  return { page, ...socket };
}

async function evalPage(call, expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

function buildNewDocumentScript({ seedWorkspace }) {
  return `(() => {
    const activeSession = ${JSON.stringify(ACTIVE_SESSION)};
    const hiddenSession = ${JSON.stringify(HIDDEN_SESSION)};
    const paneId = ${JSON.stringify(PANE_ID)};
    const activeTabId = ${JSON.stringify(ACTIVE_TAB_ID)};
    const hiddenTabId = ${JSON.stringify(HIDDEN_TAB_ID)};
    window.__ztermAlphaSmoke = {
      runtimeEnsureCalls: [],
      runtimeConnectCalls: [],
      runtimeDisconnectCalls: [],
      seedApplied: false,
      windowId: null,
    };
    const resolveWindowId = () => {
      const id = new URLSearchParams(window.location.search).get('windowId') || 'browser-dev-window';
      window.__ztermAlphaSmoke.windowId = id;
      return id;
    };
    if (${seedWorkspace ? 'true' : 'false'}) {
      const windowId = resolveWindowId();
      const record = {
        workspaceId: 'workspace:' + windowId,
        windowId,
        paneTree: { kind: 'row', paneIds: [paneId] },
        panes: [{
          id: paneId,
          size: 1,
          tabs: [
            {
              id: hiddenTabId,
              kind: 'local-tmux',
              title: hiddenSession,
              localSessionName: hiddenSession,
              runtimeKey: 'local-tmux:' + hiddenSession,
            },
            {
              id: activeTabId,
              kind: 'local-tmux',
              title: activeSession,
              localSessionName: activeSession,
              runtimeKey: 'local-tmux:' + activeSession,
            },
          ],
          activeTabId,
        }],
        activePaneId: paneId,
        updatedAt: Date.now(),
      };
      localStorage.setItem('zterm:mac:workspace:v1:' + windowId, JSON.stringify(record));
      window.__ztermAlphaSmoke.seedApplied = true;
    } else {
      resolveWindowId();
    }
  })();`;
}

async function installSmokeScriptAndReload(call, optionsForScript) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: buildNewDocumentScript(optionsForScript),
  });
  await call('Page.reload', { ignoreCache: true });
  await sleep(1400);
}

async function readState(call) {
  return evalPage(call, `(() => {
    const root = document.querySelector('.mac-shell-root');
    const windowId = root ? root.getAttribute('data-window-id') : new URLSearchParams(location.search).get('windowId');
    const meta = [...document.querySelectorAll('.mac-terminal-meta')].map((node) => node.innerText || node.textContent || '');
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map((node) => ({
      id: node.getAttribute('data-tab-id'),
      active: node.getAttribute('data-tab-active') === 'true',
      text: node.innerText || node.textContent || '',
    }));
    const buttons = [...document.querySelectorAll('button')].map((node) => ({
      testid: node.getAttribute('data-testid') || '',
      text: node.innerText || node.textContent || '',
      disabled: Boolean(node.disabled),
    }));
    const storageKeys = Object.keys(localStorage).filter((key) => key.startsWith('zterm:mac:workspace:v1:')).sort();
    const smoke = window.__ztermAlphaSmoke || null;
    const scroll = (() => {
      const node = document.querySelector('[data-mac-terminal-scroll="true"]');
      return node ? {
        top: node.scrollTop,
        height: node.scrollHeight,
        client: node.clientHeight,
        atBottom: node.scrollTop >= node.scrollHeight - node.clientHeight - 2,
      } : null;
    })();
    return {
      url: location.href,
      windowId,
      bodyText: document.body.innerText || document.body.textContent || '',
      meta,
      tabs,
      buttons,
      storageKeys,
      smoke,
      scroll,
    };
  })()`);
}

async function waitForState(call, label, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readState(call);
    if (predicate(last)) {
      return last;
    }
    await sleep(350);
  }
  throw new Error(`${label} timed out. Last state:\n${JSON.stringify(last, null, 2)}`);
}

function assertActiveOnlyRuntimeEnsure(state, label) {
  const calls = state.smoke?.runtimeEnsureCalls || [];
  const activeConnects = calls.filter((item) => item.sessionName === ACTIVE_SESSION && item.connect === true);
  const hiddenConnects = calls.filter((item) => item.sessionName === HIDDEN_SESSION && item.connect === true);
  const hiddenPrepared = calls.filter((item) => item.sessionName === HIDDEN_SESSION && item.connect === false);
  if (!Array.isArray(state.smoke?.runtimeEnsureCalls)) {
    throw new Error(`${label}: smoke instrumentation did not expose runtimeEnsureCalls`);
  }
  if (activeConnects.length < 1 || hiddenPrepared.length < 1 || hiddenConnects.length !== 0) {
    throw new Error(`${label}: expected active eager connect and hidden prepare-only, got ${JSON.stringify(calls, null, 2)}`);
  }
}

function assertActualConnectsOnlyActive(state, label, assertOptions = {}) {
  const minActiveConnects = Math.max(1, Math.floor(assertOptions.minActiveConnects || 1));
  const calls = state.smoke?.runtimeConnectCalls || [];
  const activeConnects = calls.filter((item) => item.sessionName === ACTIVE_SESSION);
  const hiddenConnects = calls.filter((item) => item.sessionName === HIDDEN_SESSION);
  if (!Array.isArray(state.smoke?.runtimeConnectCalls)) {
    throw new Error(`${label}: smoke instrumentation did not expose runtimeConnectCalls`);
  }
  if (activeConnects.length < minActiveConnects || hiddenConnects.length !== 0) {
    throw new Error(`${label}: expected actual active connects >= ${minActiveConnects} and hidden connects 0, got ${JSON.stringify(calls, null, 2)}`);
  }
}

function assertActualDisconnectsOnlyActive(state, label) {
  const calls = state.smoke?.runtimeDisconnectCalls || [];
  const activeDisconnects = calls.filter((item) => item.sessionName === ACTIVE_SESSION);
  const hiddenDisconnects = calls.filter((item) => item.sessionName === HIDDEN_SESSION);
  if (!Array.isArray(state.smoke?.runtimeDisconnectCalls)) {
    throw new Error(`${label}: smoke instrumentation did not expose runtimeDisconnectCalls`);
  }
  if (activeDisconnects.length < 1 || hiddenDisconnects.length !== 0) {
    throw new Error(`${label}: expected actual active disconnect >= 1 and hidden disconnect 0, got ${JSON.stringify(calls, null, 2)}`);
  }
}

function assertRestoredUiState(state, label) {
  const metaText = state.meta.join('\n');
  if (!metaText.includes('connected') || !metaText.includes(`Local tmux · ${ACTIVE_SESSION}`)) {
    throw new Error(`${label}: active terminal meta is not connected to ${ACTIVE_SESSION}: ${metaText}`);
  }
  if (!state.tabs.some((tab) => tab.id === ACTIVE_TAB_ID && tab.active)) {
    throw new Error(`${label}: active restored tab missing`);
  }
  if (!state.tabs.some((tab) => tab.id === HIDDEN_TAB_ID && !tab.active)) {
    throw new Error(`${label}: hidden restored tab missing`);
  }
  if (!state.buttons.some((button) => button.testid === `mac-terminal-reconnect-${PANE_ID}` && !button.disabled)) {
    throw new Error(`${label}: reconnect control missing or disabled`);
  }
  if (!state.buttons.some((button) => button.testid === `mac-terminal-disconnect-${PANE_ID}` && !button.disabled)) {
    throw new Error(`${label}: disconnect control missing or disabled`);
  }
}

async function clickButton(call, testId) {
  const result = await evalPage(call, `(() => {
    const button = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    if (!button) return { ok: false, reason: 'missing' };
    button.click();
    return { ok: true };
  })()`);
  if (!result.ok) {
    throw new Error(`Failed to click ${testId}: ${JSON.stringify(result)}`);
  }
}

async function captureScreenshot(call, name) {
  try {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(options.evidenceDir, name), Buffer.from(result.data, 'base64'));
    return { ok: true, name };
  } catch (error) {
    writeFileSync(join(options.evidenceDir, `${name}.error.txt`), error instanceof Error ? error.message : String(error));
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function startPackagedApp() {
  if (!existsSync(options.appPath)) {
    throw new Error(`Packaged app missing: ${options.appPath}. Run pnpm --dir mac run package first.`);
  }
  assertNoExistingCdpOwner(options.port);
  const userDataDir = join(options.evidenceDir, 'user-data');
  mkdirSync(userDataDir, { recursive: true });
  const result = spawnSync('open', [
    '-n',
    options.appPath,
    '--args',
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
  ], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'open packaged app failed');
  }
  const version = await waitForCdp(options.port);
  writeFileSync(join(options.evidenceDir, `cdp-version-${Date.now()}.json`), JSON.stringify(version, null, 2));
  await sleep(700);
  writeFileSync(join(options.evidenceDir, `process-after-open-${Date.now()}.txt`), psForPort(options.port) || '');
}

async function closePackagedApp(reason) {
  if (options.keepApp) return;
  try {
    const version = await fetchJson(`http://127.0.0.1:${options.port}/json/version`);
    if (version.webSocketDebuggerUrl) {
      const browser = await connectSocket(version.webSocketDebuggerUrl);
      await browser.call('Browser.close').catch(() => undefined);
      browser.ws.close();
    }
  } catch {
    // Explicit PID scoped shutdown below records any remaining process.
  }
  await sleep(1200);
  const pid = firstPidForPort(options.port);
  if (pid) {
    process.kill(pid, 'TERM');
    await sleep(800);
  }
  writeFileSync(join(options.evidenceDir, `process-after-close-${reason}.txt`), psForPort(options.port) || '');
}

async function runHeaderRestoreCase() {
  const summary = {
    caseName: options.caseName,
    evidenceDir: options.evidenceDir,
    port: options.port,
    appPath: options.appPath,
    activeSession: ACTIVE_SESSION,
    hiddenSession: HIDDEN_SESSION,
    lifecycle: {
      tmuxBefore: listTmuxSessions(),
      tmuxAfterCreate: '',
      tmuxAfterCleanup: '',
    },
    firstOpen: null,
    coldReopen: null,
    persistedReload: null,
    afterDisconnect: null,
    afterReconnect: null,
    screenshot: null,
    resourcePid: null,
  };

  ensureSmokeSession(ACTIVE_SESSION, 'ZTERM_ALPHA_ACTIVE_READY');
  ensureSmokeSession(HIDDEN_SESSION, 'ZTERM_ALPHA_HIDDEN_READY');
  summary.lifecycle.tmuxAfterCreate = listTmuxSessions();

  try {
    await startPackagedApp();
    let pageSocket = await connectPage();
    await installSmokeScriptAndReload(pageSocket.call, { seedWorkspace: true });
    summary.firstOpen = await waitForState(pageSocket.call, 'first seeded restore', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${ACTIVE_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.smoke?.runtimeEnsureCalls?.some((item) => item.sessionName === ACTIVE_SESSION && item.connect === true),
    );
    assertRestoredUiState(summary.firstOpen, 'first seeded restore');
    assertActiveOnlyRuntimeEnsure(summary.firstOpen, 'first seeded restore');
    assertActualConnectsOnlyActive(summary.firstOpen, 'first seeded restore');
    pageSocket.ws.close();
    await closePackagedApp('first');

    await startPackagedApp();
    pageSocket = await connectPage();
    summary.coldReopen = await waitForState(pageSocket.call, 'cold reopen restore', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${ACTIVE_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.tabs.some((tab) => tab.id === ACTIVE_TAB_ID && tab.active)
      && state.tabs.some((tab) => tab.id === HIDDEN_TAB_ID && !tab.active),
    );
    assertRestoredUiState(summary.coldReopen, 'cold reopen restore');

    await installSmokeScriptAndReload(pageSocket.call, { seedWorkspace: false });
    summary.persistedReload = await waitForState(pageSocket.call, 'persisted active-only reload', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${ACTIVE_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.smoke?.runtimeEnsureCalls?.some((item) => item.sessionName === ACTIVE_SESSION && item.connect === true),
    );
    assertRestoredUiState(summary.persistedReload, 'persisted active-only reload');
    assertActiveOnlyRuntimeEnsure(summary.persistedReload, 'persisted active-only reload');
    assertActualConnectsOnlyActive(summary.persistedReload, 'persisted active-only reload');

    await clickButton(pageSocket.call, `mac-terminal-disconnect-${PANE_ID}`);
    summary.afterDisconnect = await waitForState(pageSocket.call, 'terminal disconnect control', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${ACTIVE_SESSION}`)
      && state.meta.join('\n').includes('idle'),
    );
    assertActualDisconnectsOnlyActive(summary.afterDisconnect, 'terminal disconnect control');

    await clickButton(pageSocket.call, `mac-terminal-reconnect-${PANE_ID}`);
    summary.afterReconnect = await waitForState(pageSocket.call, 'terminal reconnect control', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${ACTIVE_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.smoke?.runtimeEnsureCalls?.some((item) => item.sessionName === ACTIVE_SESSION && item.connect === true),
    );
    assertActualConnectsOnlyActive(summary.afterReconnect, 'terminal reconnect control', { minActiveConnects: 2 });
    const hiddenAfterReconnect = (summary.afterReconnect.smoke?.runtimeEnsureCalls || [])
      .filter((item) => item.sessionName === HIDDEN_SESSION && item.connect === true);
    if (hiddenAfterReconnect.length > 0) {
      throw new Error(`reconnect touched hidden runtime: ${JSON.stringify(summary.afterReconnect.smoke.runtimeEnsureCalls, null, 2)}`);
    }

    summary.screenshot = await captureScreenshot(pageSocket.call, 'header-restore.png');
    summary.resourcePid = captureResourceSample('header-restore-before-close');
    pageSocket.ws.close();
    await closePackagedApp('final');
    summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    return summary;
  } finally {
    await closePackagedApp('finally');
    if (options.cleanupSessions) {
      cleanupSmokeSession(ACTIVE_SESSION);
      cleanupSmokeSession(HIDDEN_SESSION);
      summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    }
    writeFileSync(join(options.evidenceDir, 'header-restore-summary.json'), JSON.stringify(summary, null, 2));
  }
}

async function main() {
  const summary = await runHeaderRestoreCase();
  writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    ok: true,
    caseName: summary.caseName,
    evidenceDir: summary.evidenceDir,
    firstWindowId: summary.firstOpen?.windowId,
    reopenedWindowId: summary.coldReopen?.windowId,
    activeEnsureConnects: summary.afterReconnect?.smoke?.runtimeEnsureCalls?.filter((item) => item.sessionName === ACTIVE_SESSION && item.connect === true).length,
    hiddenEnsureConnects: summary.afterReconnect?.smoke?.runtimeEnsureCalls?.filter((item) => item.sessionName === HIDDEN_SESSION && item.connect === true).length,
    activeRuntimeConnects: summary.afterReconnect?.smoke?.runtimeConnectCalls?.filter((item) => item.sessionName === ACTIVE_SESSION).length,
    hiddenRuntimeConnects: summary.afterReconnect?.smoke?.runtimeConnectCalls?.filter((item) => item.sessionName === HIDDEN_SESSION).length,
  }, null, 2));
}

main().catch((error) => {
  writeFileSync(join(options.evidenceDir, 'failure.txt'), error instanceof Error ? error.stack || error.message : String(error));
  console.error(error);
  process.exit(1);
});

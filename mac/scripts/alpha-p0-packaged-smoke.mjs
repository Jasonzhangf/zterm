#!/usr/bin/env node
/**
 * Mac alpha P0 packaged smoke.
 *
 * Current cases:
 * - header-restore: packaged cold restore + active-only eager connect + terminal
 *   header disconnect/reconnect controls.
 * - server-rail-remote-open: packaged server rail live refresh stays read-only,
 *   then explicit rail session click opens a real remote runtime.
 * - quick-connect-discovery: packaged QuickConnect discovery against the real
 *   daemon list-sessions path, then explicit Save & connect remote open.
 * - disconnect-reconnect: packaged local transport error projection and
 *   reconnect recovery through the terminal header control.
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
const SUPPORTED_CASES = new Set(['header-restore', 'server-rail-remote-open', 'quick-connect-discovery', 'disconnect-reconnect']);
const SMOKE_OWNER = 'alpha-p0-header-restore';
const SERVER_OPEN_SMOKE_OWNER = 'alpha-p0-server-rail-open';
const QUICK_SMOKE_OWNER = 'alpha-p0-quick-connect';
const RECONNECT_SMOKE_OWNER = 'alpha-p0-disconnect-reconnect';
const SMOKE_OWNER_OPTION = '@zterm_mac_smoke_owner';
const SMOKE_CASE_OPTION = '@zterm_mac_smoke_case';
const ACTIVE_SESSION = 'zterm_mac_alpha_active';
const HIDDEN_SESSION = 'zterm_mac_alpha_hidden';
const SERVER_OPEN_SESSION = 'zterm_mac_alpha_remote_open';
const SERVER_OPEN_READY_TEXT = 'ZTERM_ALPHA_REMOTE_OPEN_READY';
const QUICK_SESSION = 'zterm_mac_alpha_quick';
const QUICK_READY_TEXT = 'ZTERM_ALPHA_QUICK_READY';
const RECONNECT_SESSION = 'zterm_mac_alpha_reconnect';
const RECONNECT_HIDDEN_SESSION = 'zterm_mac_alpha_reconnect_hidden';
const RECONNECT_READY_TEXT = 'ZTERM_ALPHA_RECONNECT_READY';
const RECONNECT_HIDDEN_READY_TEXT = 'ZTERM_ALPHA_RECONNECT_HIDDEN_READY';
const PANE_ID = 'pane-alpha-p0';
const ACTIVE_TAB_ID = 'tab-alpha-active';
const HIDDEN_TAB_ID = 'tab-alpha-hidden';

function parseArgs(argv) {
  const out = {
    caseName: 'header-restore',
    port: DEFAULT_PORT,
    evidenceDir: '',
    evidenceProvided: false,
    appPath: join(MAC_ROOT, 'out', 'mac-arm64', 'ZTerm.app'),
    keepApp: false,
    cleanupSessions: true,
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--case=')) out.caseName = arg.slice('--case='.length);
    else if (arg.startsWith('--port=')) out.port = Number.parseInt(arg.slice('--port='.length), 10);
    else if (arg.startsWith('--evidence=')) {
      out.evidenceDir = resolve(ROOT, arg.slice('--evidence='.length));
      out.evidenceProvided = true;
    }
    else if (arg.startsWith('--app=')) out.appPath = resolve(ROOT, arg.slice('--app='.length));
    else if (arg === '--keep-app') out.keepApp = true;
    else if (arg === '--keep-sessions') out.cleanupSessions = false;
    else if (arg === '--cleanup-sessions') out.cleanupSessions = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!SUPPORTED_CASES.has(out.caseName)) {
    throw new Error(`Unsupported --case=${out.caseName}`);
  }
  if (!out.evidenceProvided) {
    out.evidenceDir = join(MAC_ROOT, 'evidence', `${DATE}-mac-alpha-p0-closeout`, out.caseName);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port=${out.port}`);
  }
  delete out.evidenceProvided;
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

function assertSmokeSession(sessionName, expectedOwner = SMOKE_OWNER) {
  const owner = tmuxSessionOption(sessionName, SMOKE_OWNER_OPTION);
  const caseName = tmuxSessionOption(sessionName, SMOKE_CASE_OPTION);
  if (owner !== expectedOwner || caseName !== options.caseName) {
    throw new Error([
      `Refusing to touch tmux session ${sessionName}: it is not this smoke fixture.`,
      `Expected ${SMOKE_OWNER_OPTION}=${expectedOwner} and ${SMOKE_CASE_OPTION}=${options.caseName}; got owner=${owner || '<unset>'}, case=${caseName || '<unset>'}.`,
    ].join('\n'));
  }
}

function markSmokeSession(sessionName, owner = SMOKE_OWNER) {
  runTmux(['set-option', '-q', '-t', sessionName, SMOKE_OWNER_OPTION, owner]);
  runTmux(['set-option', '-q', '-t', sessionName, SMOKE_CASE_OPTION, options.caseName]);
}

function ensureSmokeSession(sessionName, label, owner = SMOKE_OWNER) {
  const command = `sh -lc ${shellQuote(`printf '${label}\\n'; while :; do sleep 3600; done`)}`;
  if (sessionExists(sessionName)) {
    assertSmokeSession(sessionName, owner);
    runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0.0`, command]);
  } else {
    runTmux(['new-session', '-d', '-s', sessionName, command]);
  }
  markSmokeSession(sessionName, owner);
  runTmux(['resize-pane', '-t', sessionName, '-x', '100', '-y', '30'], { allowFailure: true });
  runTmux(['clear-history', '-t', sessionName], { allowFailure: true });
}

function cleanupSmokeSession(sessionName, owner = SMOKE_OWNER) {
  if (!sessionExists(sessionName)) return;
  assertSmokeSession(sessionName, owner);
  runTmux(['kill-session', '-t', sessionName], { allowFailure: true });
}

function forceKillSmokeSession(sessionName, owner = SMOKE_OWNER) {
  assertSmokeSession(sessionName, owner);
  runTmux(['kill-session', '-t', sessionName], { allowFailure: true });
}

function listTmuxSessions() {
  return runTmux([
    'list-sessions',
    '-F',
    '#{session_name} #{?@zterm_mac_smoke_owner,owner=#{@zterm_mac_smoke_owner},owner=-} #{?@zterm_mac_smoke_case,case=#{@zterm_mac_smoke_case},case=-} #{?@zterm_mac_gate_owner,gate=#{@zterm_mac_gate_owner},gate=-}',
  ], { allowFailure: true });
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function readDaemonConfig() {
  const configPath = resolve(process.env.HOME || '', '.zterm', 'config.json');
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const daemon = parsed?.mobile?.daemon;
  const host = String(daemon?.host || '127.0.0.1').trim();
  const port = Number.parseInt(String(daemon?.port || 3333), 10);
  const authToken = String(daemon?.authToken || '').trim();
  if (!authToken) {
    throw new Error(`${configPath} mobile.daemon.authToken is required for QuickConnect packaged smoke`);
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`${configPath} mobile.daemon.port is invalid`);
  }
  return {
    configPath,
    bridgeHost: host === '0.0.0.0' ? '127.0.0.1' : host,
    bridgePort: port,
    authToken,
    authTokenMasked: maskToken(authToken),
  };
}

function requestTmuxSessions(target) {
  return new Promise((resolveRequest, rejectRequest) => {
    const url = new URL(`ws://${target.bridgeHost}:${target.bridgePort}`);
    url.searchParams.set('token', target.authToken);
    const ws = new WebSocket(url.toString());
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore close failure after timeout
      }
      rejectRequest(new Error(`Timed out reading daemon sessions from ${target.bridgeHost}:${target.bridgePort}`));
    }, 8000);
    const finish = (fn, value) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore close failure after response
      }
      fn(value);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'list-sessions' }));
    });
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'sessions') {
          finish(resolveRequest, message.payload?.sessions || []);
          return;
        }
        if (message.type === 'error') {
          finish(rejectRequest, new Error(message.payload?.message || 'Daemon list-sessions failed'));
        }
      } catch (error) {
        finish(rejectRequest, error);
      }
    });
    ws.on('error', (error) => {
      finish(rejectRequest, error);
    });
  });
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

function buildQuickConnectNewDocumentScript({ target, sessionName }) {
  const serverId = `bridge:${target.bridgeHost}::${target.bridgePort}`;
  const oldSessionName = `${sessionName}-old`;
  return `(() => {
    const target = ${JSON.stringify({
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
    })};
    const sessionName = ${JSON.stringify(sessionName)};
    const oldSessionName = ${JSON.stringify(oldSessionName)};
    const serverId = ${JSON.stringify(serverId)};
    window.__ztermAlphaSmoke = {
      runtimeEnsureCalls: [],
      runtimeConnectCalls: [],
      runtimeDisconnectCalls: [],
      seedApplied: false,
      windowId: null,
    };
    const windowId = new URLSearchParams(window.location.search).get('windowId') || 'browser-dev-window';
    window.__ztermAlphaSmoke.windowId = windowId;
    localStorage.removeItem('zterm:mac:workspace:v1:' + windowId);
    localStorage.setItem('zterm:bridge-settings', JSON.stringify({
      targetHost: target.bridgeHost,
      targetPort: target.bridgePort,
      targetAuthToken: target.authToken,
      signalUrl: '',
      turnServerUrl: '',
      turnUsername: '',
      turnCredential: '',
      transportMode: 'auto',
      terminalCacheLines: 3000,
      terminalThemeId: 'default',
      terminalWidthMode: 'mirror-fixed',
      terminalSessionGroupLayoutMode: 'auto',
      shortcutSmartSort: true,
      servers: [{
        id: serverId,
        name: 'Alpha P0 daemon',
        targetHost: target.bridgeHost,
        targetPort: target.bridgePort,
        authToken: target.authToken,
      }],
      defaultServerId: serverId,
    }));
    localStorage.setItem('zterm:hosts', JSON.stringify([
      {
        id: 'alpha-old',
        createdAt: 1,
        name: oldSessionName,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        sessionName: oldSessionName,
        authToken: target.authToken,
        authType: 'password',
        tags: [],
        pinned: false,
        lastConnected: 10
      },
      {
        id: 'alpha-quick-saved',
        createdAt: 2,
        name: sessionName,
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        sessionName,
        authToken: target.authToken,
        authType: 'password',
        tags: [],
        pinned: false,
        lastConnected: 20
      }
    ]));
    window.__ztermAlphaSmoke.seedApplied = true;
  })();`;
}

function buildServerRailOpenNewDocumentScript({ target, sessionName }) {
  const serverId = `${target.bridgeHost}:${target.bridgePort}`.toLowerCase();
  return `(() => {
    const target = ${JSON.stringify({
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
    })};
    const sessionName = ${JSON.stringify(sessionName)};
    const serverId = ${JSON.stringify(serverId)};
    window.__ztermAlphaSmoke = {
      runtimeEnsureCalls: [],
      runtimeConnectCalls: [],
      runtimeDisconnectCalls: [],
      seedApplied: false,
      windowId: null,
    };
    const windowId = new URLSearchParams(window.location.search).get('windowId') || 'browser-dev-window';
    window.__ztermAlphaSmoke.windowId = windowId;
    localStorage.removeItem('zterm:mac:workspace:v1:' + windowId);
    localStorage.setItem('zterm:bridge-settings', JSON.stringify({
      targetHost: target.bridgeHost,
      targetPort: target.bridgePort,
      targetAuthToken: target.authToken,
      signalUrl: '',
      turnServerUrl: '',
      turnUsername: '',
      turnCredential: '',
      transportMode: 'auto',
      terminalCacheLines: 3000,
      terminalThemeId: 'default',
      terminalWidthMode: 'mirror-fixed',
      terminalSessionGroupLayoutMode: 'auto',
      shortcutSmartSort: true,
      servers: [{
        id: serverId,
        name: 'Alpha P0 daemon',
        targetHost: target.bridgeHost,
        targetPort: target.bridgePort,
        authToken: target.authToken,
      }],
      defaultServerId: serverId,
    }));
    localStorage.setItem('zterm:hosts', JSON.stringify([]));
    window.__ztermAlphaSmoke.seedApplied = true;
  })();`;
}

function buildDisconnectReconnectNewDocumentScript() {
  return `(() => {
    const activeSession = ${JSON.stringify(RECONNECT_SESSION)};
    const hiddenSession = ${JSON.stringify(RECONNECT_HIDDEN_SESSION)};
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
    const windowId = new URLSearchParams(window.location.search).get('windowId') || 'browser-dev-window';
    window.__ztermAlphaSmoke.windowId = windowId;
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
  })();`;
}

async function installSmokeScriptAndReload(call, optionsForScript) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: buildNewDocumentScript(optionsForScript),
  });
  await call('Page.reload', { ignoreCache: true });
  await sleep(1400);
}

async function installQuickConnectScriptAndReload(call, optionsForScript) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: buildQuickConnectNewDocumentScript(optionsForScript),
  });
  await call('Page.reload', { ignoreCache: true });
  await sleep(1400);
}

async function installServerRailOpenScriptAndReload(call, optionsForScript) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: buildServerRailOpenNewDocumentScript(optionsForScript),
  });
  await call('Page.reload', { ignoreCache: true });
  await sleep(1400);
}

async function installDisconnectReconnectScriptAndReload(call) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: buildDisconnectReconnectNewDocumentScript(),
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
    const workspaceRecords = {};
    for (const key of storageKeys) {
      try {
        const record = JSON.parse(localStorage.getItem(key) || 'null');
        workspaceRecords[key] = record ? {
          windowId: record.windowId,
          activePaneId: record.activePaneId,
          paneIds: Array.isArray(record.panes) ? record.panes.map((pane) => pane.id) : [],
          tabs: Array.isArray(record.panes)
            ? record.panes.flatMap((pane) => (pane.tabs || []).map((tab) => ({
              paneId: pane.id,
              tabId: tab.id,
              runtimeKey: tab.runtimeKey,
              localSessionName: tab.localSessionName,
              active: pane.activeTabId === tab.id,
            })))
            : [],
        } : null;
      } catch {
        workspaceRecords[key] = 'unparseable';
      }
    }
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
      workspaceRecords,
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

async function waitForQuickConnectState(call, label, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readQuickConnectState(call);
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

async function clickButtonByText(call, text) {
  const result = await evalPage(call, `(() => {
    const expected = ${JSON.stringify(text)};
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.innerText || node.textContent || '').includes(expected));
    if (!button) return { ok: false, reason: 'missing', expected };
    button.click();
    return { ok: true };
  })()`);
  if (!result.ok) {
    throw new Error(`Failed to click button containing ${text}: ${JSON.stringify(result)}`);
  }
}

async function setInputByLabel(call, label, value) {
  const selectorResult = await evalPage(call, `(() => {
    const label = [...document.querySelectorAll('label')].find((node) =>
      (node.innerText || node.textContent || '').includes(${JSON.stringify(label)})
    );
    const input = label?.querySelector('input');
    if (!input) return { ok: false, reason: 'missing-input' };
    input.setAttribute('data-alpha-smoke-input', ${JSON.stringify(label)});
    input.focus();
    input.select();
    return { ok: true };
  })()`);
  if (!selectorResult.ok) {
    throw new Error(`Failed to locate input ${label}: ${JSON.stringify(selectorResult)}`);
  }
  await call('Input.insertText', { text: String(value) });
  await sleep(120);
}

async function readQuickConnectState(call) {
  return evalPage(call, `(() => {
    const redact = (value) => {
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = key === 'authToken' || key === 'targetAuthToken'
          ? '<redacted>'
          : redact(entry);
      }
      return out;
    };
    const root = document.querySelector('.mac-shell-root');
    const meta = [...document.querySelectorAll('.mac-terminal-meta')].map((node) => node.innerText || node.textContent || '');
    const radioInputs = [...document.querySelectorAll('input[type="radio"][name^="mac-quick-session-"]')].map((node) => ({
      name: node.getAttribute('name') || '',
      checked: Boolean(node.checked),
      text: node.closest('label')?.innerText || node.closest('label')?.textContent || '',
    }));
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map((node) => ({
      id: node.getAttribute('data-tab-id'),
      active: node.getAttribute('data-tab-active') === 'true',
      text: node.innerText || node.textContent || '',
    }));
    const storage = {};
    for (const key of ['zterm:hosts', 'zterm:bridge-settings']) {
      try {
        storage[key] = redact(JSON.parse(localStorage.getItem(key) || 'null'));
      } catch {
        storage[key] = localStorage.getItem(key);
      }
    }
    const smoke = window.__ztermAlphaSmoke || null;
    return {
      url: location.href,
      windowId: root?.getAttribute('data-window-id') || new URLSearchParams(location.search).get('windowId'),
      bodyText: document.body.innerText || document.body.textContent || '',
      meta,
      radioInputs,
      tabs,
      storage,
      smoke,
    };
  })()`);
}

async function readServerRailOpenState(call) {
  return evalPage(call, `(() => {
    const redact = (value) => {
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = key === 'authToken' || key === 'targetAuthToken'
          ? '<redacted>'
          : redact(entry);
      }
      return out;
    };
    const root = document.querySelector('.mac-shell-root');
    const meta = [...document.querySelectorAll('.mac-terminal-meta')].map((node) => node.innerText || node.textContent || '');
    const rows = [...document.querySelectorAll('[data-terminal-row-text]')].map((node) =>
      node.getAttribute('data-terminal-row-text') || node.innerText || node.textContent || ''
    );
    const serverGroups = [...document.querySelectorAll('.mac-server-group')].map((node) => ({
      serverId: node.getAttribute('data-server-id') || '',
      text: node.innerText || node.textContent || '',
      sessions: [...node.querySelectorAll('.mac-server-session-row')].map((row) => ({
        sessionName: row.getAttribute('data-session-name') || '',
        text: row.innerText || row.textContent || '',
      })),
    }));
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map((node) => ({
      id: node.getAttribute('data-tab-id'),
      active: node.getAttribute('data-tab-active') === 'true',
      text: node.innerText || node.textContent || '',
    }));
    const storage = {};
    for (const key of ['zterm:hosts', 'zterm:bridge-settings']) {
      try {
        storage[key] = redact(JSON.parse(localStorage.getItem(key) || 'null'));
      } catch {
        storage[key] = localStorage.getItem(key);
      }
    }
    const smoke = window.__ztermAlphaSmoke || null;
    return {
      url: location.href,
      windowId: root?.getAttribute('data-window-id') || new URLSearchParams(location.search).get('windowId'),
      bodyText: document.body.innerText || document.body.textContent || '',
      meta,
      rows,
      serverGroups,
      tabs,
      storage,
      smoke,
    };
  })()`);
}

async function waitForServerRailOpenState(call, label, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readServerRailOpenState(call);
    if (predicate(last)) {
      return last;
    }
    await sleep(350);
  }
  throw new Error(`${label} timed out. Last state:\n${JSON.stringify(last, null, 2)}`);
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
    '--zterm-alpha-smoke',
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
    process.kill(pid, 'SIGTERM');
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

async function runQuickConnectDiscoveryCase() {
  const daemon = readDaemonConfig();
  const summary = {
    caseName: options.caseName,
    evidenceDir: options.evidenceDir,
    port: options.port,
    appPath: options.appPath,
    daemon: {
      configPath: daemon.configPath,
      bridgeHost: daemon.bridgeHost,
      bridgePort: daemon.bridgePort,
      authTokenMasked: daemon.authTokenMasked,
    },
    sessionName: QUICK_SESSION,
    lifecycle: {
      tmuxBefore: listTmuxSessions(),
      tmuxAfterCreate: '',
      tmuxAfterCleanup: '',
    },
    daemonSessionsBeforeOpen: [],
    beforeDiscover: null,
    afterDiscover: null,
    afterOpen: null,
    screenshot: null,
    resourcePid: null,
  };

  ensureSmokeSession(QUICK_SESSION, QUICK_READY_TEXT, QUICK_SMOKE_OWNER);
  summary.lifecycle.tmuxAfterCreate = listTmuxSessions();
  summary.daemonSessionsBeforeOpen = await requestTmuxSessions(daemon);
  if (!summary.daemonSessionsBeforeOpen.includes(QUICK_SESSION)) {
    throw new Error(`Daemon list-sessions did not include ${QUICK_SESSION}: ${JSON.stringify(summary.daemonSessionsBeforeOpen)}`);
  }

  try {
    await startPackagedApp();
    const pageSocket = await connectPage();
    await installQuickConnectScriptAndReload(pageSocket.call, { target: daemon, sessionName: QUICK_SESSION });

    await waitForState(pageSocket.call, 'initial QuickConnect shell', (state) =>
      state.bodyText.includes('Open connection')
      && state.bodyText.includes('No session'),
    );
    await clickButtonByText(pageSocket.call, 'Open connection');
    summary.beforeDiscover = await waitForState(pageSocket.call, 'QuickConnect dialog open', (state) =>
      state.bodyText.includes('Discover sessions')
      && state.bodyText.includes('Bridge host'),
    );

    await setInputByLabel(pageSocket.call, 'Bridge host', daemon.bridgeHost);
    await setInputByLabel(pageSocket.call, 'Bridge port', String(daemon.bridgePort));
    await setInputByLabel(pageSocket.call, 'Auth token', daemon.authToken);
    await clickButtonByText(pageSocket.call, 'Discover sessions');

    summary.afterDiscover = await waitForQuickConnectState(pageSocket.call, 'QuickConnect discovery list', (state) =>
      state.radioInputs.some((item) => item.name === `mac-quick-session-${QUICK_SESSION}`),
    );
    const quickRadio = summary.afterDiscover.radioInputs.find((item) => item.name === `mac-quick-session-${QUICK_SESSION}`);
    if (!quickRadio?.checked) {
      throw new Error(`QuickConnect did not preselect latest saved matching session: ${JSON.stringify(summary.afterDiscover.radioInputs, null, 2)}`);
    }
    if ((summary.afterDiscover.smoke?.runtimeEnsureCalls || []).length !== 0) {
      throw new Error(`QuickConnect discovery created runtime before explicit open: ${JSON.stringify(summary.afterDiscover.smoke.runtimeEnsureCalls, null, 2)}`);
    }
    await clickButtonByText(pageSocket.call, 'Save & connect');
    summary.afterOpen = await waitForQuickConnectState(pageSocket.call, 'QuickConnect remote connected', (state) =>
      state.meta.join('\n').includes('connected')
      && state.meta.join('\n').includes(QUICK_SESSION)
      && state.smoke?.runtimeEnsureCalls?.some((item) => item.kind === 'remote' && item.sessionName === QUICK_SESSION && item.connect === true),
    );
    const remoteConnects = summary.afterOpen.smoke?.runtimeConnectCalls?.filter((item) => item.kind === 'remote' && item.sessionName === QUICK_SESSION) || [];
    if (remoteConnects.length < 1) {
      throw new Error(`QuickConnect open did not create remote runtime connection: ${JSON.stringify(summary.afterOpen.smoke, null, 2)}`);
    }
    const savedHosts = summary.afterOpen.storage?.['zterm:hosts'];
    if (!Array.isArray(savedHosts) || !savedHosts.some((host) => host.sessionName === QUICK_SESSION && host.bridgeHost === daemon.bridgeHost && host.bridgePort === daemon.bridgePort)) {
      throw new Error(`QuickConnect did not save selected host target: ${JSON.stringify(savedHosts, null, 2)}`);
    }
    summary.screenshot = await captureScreenshot(pageSocket.call, 'quick-connect-discovery.png');
    summary.resourcePid = captureResourceSample('quick-connect-before-close');
    pageSocket.ws.close();
    await closePackagedApp('quick-connect-final');
    summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    return summary;
  } finally {
    await closePackagedApp('quick-connect-finally');
    if (options.cleanupSessions) {
      cleanupSmokeSession(QUICK_SESSION, QUICK_SMOKE_OWNER);
      summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    }
    writeFileSync(join(options.evidenceDir, 'quick-connect-discovery-summary.json'), JSON.stringify(summary, null, 2));
  }
}

async function clickServerRailSession(call, sessionName) {
  const result = await evalPage(call, `(() => {
    const row = [...document.querySelectorAll('.mac-server-session-row')]
      .find((node) => node.getAttribute('data-session-name') === ${JSON.stringify(sessionName)});
    const button = row?.querySelector('.mac-server-session-button');
    if (!button) return { ok: false, reason: 'missing-session-button', sessionName: ${JSON.stringify(sessionName)} };
    button.click();
    return { ok: true };
  })()`);
  if (!result.ok) {
    throw new Error(`Failed to click server rail session ${sessionName}: ${JSON.stringify(result)}`);
  }
}

async function runServerRailRemoteOpenCase() {
  const daemon = readDaemonConfig();
  const summary = {
    caseName: options.caseName,
    evidenceDir: options.evidenceDir,
    port: options.port,
    appPath: options.appPath,
    daemon: {
      configPath: daemon.configPath,
      bridgeHost: daemon.bridgeHost,
      bridgePort: daemon.bridgePort,
      authTokenMasked: daemon.authTokenMasked,
    },
    sessionName: SERVER_OPEN_SESSION,
    lifecycle: {
      tmuxBefore: listTmuxSessions(),
      tmuxAfterCreate: '',
      tmuxAfterCleanup: '',
    },
    daemonSessionsBeforeRefresh: [],
    initialShell: null,
    afterRefresh: null,
    afterOpen: null,
    screenshot: null,
    resourcePid: null,
  };

  ensureSmokeSession(SERVER_OPEN_SESSION, SERVER_OPEN_READY_TEXT, SERVER_OPEN_SMOKE_OWNER);
  summary.lifecycle.tmuxAfterCreate = listTmuxSessions();
  summary.daemonSessionsBeforeRefresh = await requestTmuxSessions(daemon);
  if (!summary.daemonSessionsBeforeRefresh.includes(SERVER_OPEN_SESSION)) {
    throw new Error(`Daemon list-sessions did not include ${SERVER_OPEN_SESSION}: ${JSON.stringify(summary.daemonSessionsBeforeRefresh)}`);
  }

  try {
    await startPackagedApp();
    const pageSocket = await connectPage();
    await installServerRailOpenScriptAndReload(pageSocket.call, { target: daemon, sessionName: SERVER_OPEN_SESSION });

    summary.initialShell = await waitForServerRailOpenState(pageSocket.call, 'server rail initial shell', (state) =>
      state.bodyText.toLowerCase().includes('servers')
      && state.bodyText.includes('No session')
      && state.serverGroups.some((group) => group.text.includes('Alpha P0 daemon')),
    );
    if ((summary.initialShell.smoke?.runtimeEnsureCalls || []).length !== 0) {
      throw new Error(`Server rail initial projection created runtime before refresh/open: ${JSON.stringify(summary.initialShell.smoke, null, 2)}`);
    }

    await clickButtonByText(pageSocket.call, 'Refresh');
    summary.afterRefresh = await waitForServerRailOpenState(pageSocket.call, 'server rail live refresh', (state) =>
      state.serverGroups.some((group) => group.sessions.some((session) => session.sessionName === SERVER_OPEN_SESSION))
      && state.bodyText.includes('Live'),
    );
    const refreshedSession = summary.afterRefresh.serverGroups
      .flatMap((group) => group.sessions)
      .find((session) => session.sessionName === SERVER_OPEN_SESSION);
    if (!refreshedSession?.text.includes('live')) {
      throw new Error(`Server rail refresh did not project ${SERVER_OPEN_SESSION} as live: ${JSON.stringify(summary.afterRefresh.serverGroups, null, 2)}`);
    }
    if ((summary.afterRefresh.smoke?.runtimeEnsureCalls || []).length !== 0) {
      throw new Error(`Server rail refresh created runtime before explicit open: ${JSON.stringify(summary.afterRefresh.smoke.runtimeEnsureCalls, null, 2)}`);
    }
    if (!summary.afterRefresh.bodyText.includes('No session')) {
      throw new Error('Server rail refresh changed terminal stage before explicit open');
    }

    await clickServerRailSession(pageSocket.call, SERVER_OPEN_SESSION);
    summary.afterOpen = await waitForServerRailOpenState(pageSocket.call, 'server rail remote open connected', (state) =>
      state.meta.join('\n').includes('connected')
      && state.meta.join('\n').includes(SERVER_OPEN_SESSION)
      && state.rows.some((row) => row.includes(SERVER_OPEN_READY_TEXT))
      && state.smoke?.runtimeEnsureCalls?.some((item) => item.kind === 'remote' && item.sessionName === SERVER_OPEN_SESSION && item.connect === true),
    );
    const remoteConnects = summary.afterOpen.smoke?.runtimeConnectCalls?.filter((item) => item.kind === 'remote' && item.sessionName === SERVER_OPEN_SESSION) || [];
    if (remoteConnects.length < 1) {
      throw new Error(`Server rail open did not create a remote runtime connection: ${JSON.stringify(summary.afterOpen.smoke, null, 2)}`);
    }
    const openSession = summary.afterOpen.serverGroups
      .flatMap((group) => group.sessions)
      .find((session) => session.sessionName === SERVER_OPEN_SESSION);
    if (!openSession?.text.includes('open')) {
      throw new Error(`Server rail open did not mark session open: ${JSON.stringify(summary.afterOpen.serverGroups, null, 2)}`);
    }

    summary.screenshot = await captureScreenshot(pageSocket.call, 'server-rail-remote-open.png');
    summary.resourcePid = captureResourceSample('server-rail-remote-open-before-close');
    pageSocket.ws.close();
    await closePackagedApp('server-rail-open-final');
    summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    return summary;
  } finally {
    await closePackagedApp('server-rail-open-finally');
    if (options.cleanupSessions) {
      cleanupSmokeSession(SERVER_OPEN_SESSION, SERVER_OPEN_SMOKE_OWNER);
      summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    }
    writeFileSync(join(options.evidenceDir, 'server-rail-remote-open-summary.json'), JSON.stringify(summary, null, 2));
  }
}

async function runDisconnectReconnectCase() {
  const summary = {
    caseName: options.caseName,
    evidenceDir: options.evidenceDir,
    port: options.port,
    appPath: options.appPath,
    activeSession: RECONNECT_SESSION,
    hiddenSession: RECONNECT_HIDDEN_SESSION,
    lifecycle: {
      tmuxBefore: listTmuxSessions(),
      tmuxAfterCreate: '',
      tmuxAfterForcedClose: '',
      tmuxAfterRecreate: '',
      tmuxAfterCleanup: '',
    },
    firstConnected: null,
    afterTransportError: null,
    afterReconnect: null,
    screenshot: null,
    resourcePid: null,
  };

  ensureSmokeSession(RECONNECT_SESSION, RECONNECT_READY_TEXT, RECONNECT_SMOKE_OWNER);
  ensureSmokeSession(RECONNECT_HIDDEN_SESSION, RECONNECT_HIDDEN_READY_TEXT, RECONNECT_SMOKE_OWNER);
  summary.lifecycle.tmuxAfterCreate = listTmuxSessions();

  try {
    await startPackagedApp();
    const pageSocket = await connectPage();
    await installDisconnectReconnectScriptAndReload(pageSocket.call);

    summary.firstConnected = await waitForState(pageSocket.call, 'disconnect-reconnect initial connected', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${RECONNECT_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.tabs.some((tab) => tab.id === ACTIVE_TAB_ID && tab.active)
      && state.tabs.some((tab) => tab.id === HIDDEN_TAB_ID && !tab.active)
      && state.smoke?.runtimeConnectCalls?.some((item) => item.sessionName === RECONNECT_SESSION),
    );
    const firstWindowId = summary.firstConnected.windowId;
    const firstStorageKeys = summary.firstConnected.storageKeys;
    const hiddenConnectsBefore = (summary.firstConnected.smoke?.runtimeConnectCalls || [])
      .filter((item) => item.sessionName === RECONNECT_HIDDEN_SESSION);
    if (hiddenConnectsBefore.length !== 0) {
      throw new Error(`initial connect touched hidden reconnect runtime: ${JSON.stringify(summary.firstConnected.smoke, null, 2)}`);
    }

    const activeClientId = summary.firstConnected.smoke?.localTmuxClients
      ?.find((item) => item.sessionName === RECONNECT_SESSION)?.clientId;
    if (!activeClientId) {
      throw new Error(`missing active local tmux client id: ${JSON.stringify(summary.firstConnected.smoke, null, 2)}`);
    }
    const forceClose = await evalPage(pageSocket.call, `(() => {
      const fn = window.ztermMac?.localTmux?.forceCloseForSmoke;
      if (typeof fn !== 'function') return { ok: false, reason: 'missing-force-close-for-smoke' };
      return Promise.resolve(fn(${JSON.stringify(activeClientId)})).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
      );
    })()`);
    if (!forceClose.ok) {
      throw new Error(`failed to force close local tmux transport: ${JSON.stringify(forceClose)}`);
    }
    summary.lifecycle.tmuxAfterForcedClose = listTmuxSessions();
    summary.afterTransportError = await waitForState(pageSocket.call, 'local transport close projects error', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${RECONNECT_SESSION}`)
      && state.meta.join('\n').includes('error')
      && state.bodyText.includes('local tmux transport closed for smoke'),
      15000,
    );
    if (summary.afterTransportError.windowId !== firstWindowId) {
      throw new Error(`windowId changed after transport error: ${firstWindowId} -> ${summary.afterTransportError.windowId}`);
    }
    if (JSON.stringify(summary.afterTransportError.storageKeys) !== JSON.stringify(firstStorageKeys)) {
      throw new Error(`workspace storage keys changed after transport error: ${JSON.stringify(summary.afterTransportError.storageKeys)}`);
    }

    summary.lifecycle.tmuxAfterRecreate = listTmuxSessions();
    await clickButton(pageSocket.call, `mac-terminal-reconnect-${PANE_ID}`);
    summary.afterReconnect = await waitForState(pageSocket.call, 'local transport reconnect recovers', (state) =>
      state.meta.join('\n').includes(`Local tmux · ${RECONNECT_SESSION}`)
      && state.meta.join('\n').includes('connected')
      && state.smoke?.runtimeConnectCalls?.filter((item) => item.sessionName === RECONNECT_SESSION).length >= 2,
      15000,
    );
    if (summary.afterReconnect.windowId !== firstWindowId) {
      throw new Error(`windowId changed after reconnect: ${firstWindowId} -> ${summary.afterReconnect.windowId}`);
    }
    const hiddenConnectsAfter = (summary.afterReconnect.smoke?.runtimeConnectCalls || [])
      .filter((item) => item.sessionName === RECONNECT_HIDDEN_SESSION);
    if (hiddenConnectsAfter.length !== 0) {
      throw new Error(`reconnect touched hidden runtime: ${JSON.stringify(summary.afterReconnect.smoke, null, 2)}`);
    }
    const activeEnsureConnects = (summary.afterReconnect.smoke?.runtimeEnsureCalls || [])
      .filter((item) => item.sessionName === RECONNECT_SESSION && item.connect === true);
    const hiddenEnsureConnects = (summary.afterReconnect.smoke?.runtimeEnsureCalls || [])
      .filter((item) => item.sessionName === RECONNECT_HIDDEN_SESSION && item.connect === true);
    if (activeEnsureConnects.length < 1 || hiddenEnsureConnects.length !== 0) {
      throw new Error(`reconnect ensure calls were not target-scoped: ${JSON.stringify(summary.afterReconnect.smoke, null, 2)}`);
    }

    summary.screenshot = await captureScreenshot(pageSocket.call, 'disconnect-reconnect.png');
    summary.resourcePid = captureResourceSample('disconnect-reconnect-before-close');
    pageSocket.ws.close();
    await closePackagedApp('disconnect-reconnect-final');
    summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    return summary;
  } finally {
    await closePackagedApp('disconnect-reconnect-finally');
    if (options.cleanupSessions) {
      cleanupSmokeSession(RECONNECT_SESSION, RECONNECT_SMOKE_OWNER);
      cleanupSmokeSession(RECONNECT_HIDDEN_SESSION, RECONNECT_SMOKE_OWNER);
      summary.lifecycle.tmuxAfterCleanup = listTmuxSessions();
    }
    writeFileSync(join(options.evidenceDir, 'disconnect-reconnect-summary.json'), JSON.stringify(summary, null, 2));
  }
}

async function main() {
  const summary = options.caseName === 'quick-connect-discovery'
    ? await runQuickConnectDiscoveryCase()
    : options.caseName === 'server-rail-remote-open'
      ? await runServerRailRemoteOpenCase()
      : options.caseName === 'disconnect-reconnect'
        ? await runDisconnectReconnectCase()
      : await runHeaderRestoreCase();
  writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (options.caseName === 'quick-connect-discovery') {
    console.log(JSON.stringify({
      ok: true,
      caseName: summary.caseName,
      evidenceDir: summary.evidenceDir,
      bridgeHost: summary.daemon?.bridgeHost,
      bridgePort: summary.daemon?.bridgePort,
      sessionName: summary.sessionName,
      discovered: summary.afterDiscover?.radioInputs?.some((item) => item.name === `mac-quick-session-${summary.sessionName}`),
      remoteRuntimeConnects: summary.afterOpen?.smoke?.runtimeConnectCalls?.filter((item) => item.kind === 'remote' && item.sessionName === summary.sessionName).length,
    }, null, 2));
  } else if (options.caseName === 'server-rail-remote-open') {
    console.log(JSON.stringify({
      ok: true,
      caseName: summary.caseName,
      evidenceDir: summary.evidenceDir,
      bridgeHost: summary.daemon?.bridgeHost,
      bridgePort: summary.daemon?.bridgePort,
      sessionName: summary.sessionName,
      liveProjected: summary.afterRefresh?.serverGroups?.some((group) => group.sessions.some((session) => session.sessionName === summary.sessionName)),
      refreshRuntimeCalls: summary.afterRefresh?.smoke?.runtimeEnsureCalls?.length,
      remoteRuntimeConnects: summary.afterOpen?.smoke?.runtimeConnectCalls?.filter((item) => item.kind === 'remote' && item.sessionName === summary.sessionName).length,
      renderedReadyText: summary.afterOpen?.rows?.some((row) => row.includes(SERVER_OPEN_READY_TEXT)),
    }, null, 2));
  } else if (options.caseName === 'disconnect-reconnect') {
    console.log(JSON.stringify({
      ok: true,
      caseName: summary.caseName,
      evidenceDir: summary.evidenceDir,
      activeSession: summary.activeSession,
      hiddenSession: summary.hiddenSession,
      errorProjected: summary.afterTransportError?.meta?.join('\n').includes('error'),
      activeRuntimeConnects: summary.afterReconnect?.smoke?.runtimeConnectCalls?.filter((item) => item.sessionName === summary.activeSession).length,
      hiddenRuntimeConnects: summary.afterReconnect?.smoke?.runtimeConnectCalls?.filter((item) => item.sessionName === summary.hiddenSession).length,
      windowIdStable: summary.firstConnected?.windowId === summary.afterReconnect?.windowId,
    }, null, 2));
  } else {
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
}

main().catch((error) => {
  writeFileSync(join(options.evidenceDir, 'failure.txt'), error instanceof Error ? error.stack || error.message : String(error));
  console.error(error);
  process.exit(1);
});

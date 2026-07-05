#!/usr/bin/env node
/**
 * Packaged terminal buffer black-box gate.
 *
 * Proves terminal data correctness by comparing:
 * - tmux session truth (`capture-pane`)
 * - tmux input oracle (`pipe-pane`)
 * - packaged app render target (DOM row text)
 *
 * Cases:
 * - sequence: app input -> tmux output -> app rendered tail
 * - tui: continuously updating bottom line -> app refresh follows tmux truth
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_PORT = 9362;
const TUI_BODY_ROWS = 22;
const TUI_SCREEN_ROWS = TUI_BODY_ROWS + 1;
const GATE_SESSION_OWNER = 'terminal-buffer-blackbox';
const GATE_SESSION_OPTION_OWNER = '@zterm_mac_gate_owner';
const GATE_SESSION_OPTION_CASE = '@zterm_mac_gate_case';
const FIXED_GATE_SESSIONS = {
  sequence: 'zterm_mac_gate_sequence',
  tui: 'zterm_mac_gate_tui',
};
const ROOT = resolve(new URL('..', import.meta.url).pathname, '..');
const MAC_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DATE = new Date().toISOString().slice(0, 10);

function resolveFromRoot(value) {
  return resolve(ROOT, value);
}

function parseArgs(argv) {
  const out = {
    caseName: 'all',
    port: DEFAULT_PORT,
    evidenceDir: join(MAC_ROOT, 'evidence', `${DATE}-terminal-buffer-blackbox`),
    appPath: join(MAC_ROOT, 'out', 'mac-arm64', 'ZTerm.app'),
    keepApp: false,
    cleanupSessions: false,
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--case=')) out.caseName = arg.slice('--case='.length);
    else if (arg.startsWith('--port=')) out.port = Number.parseInt(arg.slice('--port='.length), 10);
    else if (arg.startsWith('--evidence=')) out.evidenceDir = resolveFromRoot(arg.slice('--evidence='.length));
    else if (arg.startsWith('--app=')) out.appPath = resolveFromRoot(arg.slice('--app='.length));
    else if (arg === '--keep-app') out.keepApp = true;
    else if (arg === '--keep-sessions') out.cleanupSessions = false;
    else if (arg === '--cleanup-sessions') out.cleanupSessions = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['sequence', 'tui', 'all'].includes(out.caseName)) {
    throw new Error(`Unsupported --case=${out.caseName}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port=${out.port}`);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.evidenceDir, { recursive: true });

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

function normalizeLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
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

function assertGateSession(sessionName, caseName) {
  const owner = tmuxSessionOption(sessionName, GATE_SESSION_OPTION_OWNER);
  const existingCase = tmuxSessionOption(sessionName, GATE_SESSION_OPTION_CASE);
  if (owner !== GATE_SESSION_OWNER || existingCase !== caseName) {
    throw new Error([
      `Refusing to reuse tmux session ${sessionName}: it is not this gate's dedicated ${caseName} fixture.`,
      `Expected ${GATE_SESSION_OPTION_OWNER}=${GATE_SESSION_OWNER} and ${GATE_SESSION_OPTION_CASE}=${caseName}; got owner=${owner || '<unset>'}, case=${existingCase || '<unset>'}.`,
      'Choose a different fixed gate session name or close that explicit session yourself.',
    ].join('\n'));
  }
}

function markGateSession(sessionName, caseName) {
  runTmux(['set-option', '-q', '-t', sessionName, GATE_SESSION_OPTION_OWNER, GATE_SESSION_OWNER]);
  runTmux(['set-option', '-q', '-t', sessionName, GATE_SESSION_OPTION_CASE, caseName]);
}

function ensureGateSession(sessionName, caseName, command) {
  if (sessionExists(sessionName)) {
    assertGateSession(sessionName, caseName);
    stopPipe(sessionName);
    runTmux(['respawn-pane', '-k', '-t', `${sessionName}:0.0`, command]);
  } else {
    runTmux(['new-session', '-d', '-s', sessionName, command]);
  }
  markGateSession(sessionName, caseName);
  runTmux(['resize-pane', '-t', sessionName, '-x', String(DEFAULT_COLS), '-y', String(DEFAULT_ROWS)], { allowFailure: true });
  runTmux(['clear-history', '-t', sessionName], { allowFailure: true });
}

function createSequenceSession(sessionName, evidenceDir) {
  const scriptPath = join(evidenceDir, `${sessionName}-sequence.sh`);
  writeFileSync(scriptPath, [
    '#!/bin/sh',
    "printf 'ZTERM_SEQUENCE_READY\\n'",
    'while IFS= read -r token; do',
    "  case \"$token\" in",
    '    ZTERMSEQ*)',
    '      i=1',
    '      while [ "$i" -le 80 ]; do',
    "        printf '%s_%03d\\n' \"$token\" \"$i\"",
    '        sleep 0.01',
    '        i=$((i + 1))',
    '      done',
    '      ;;',
    '    *)',
    "      printf 'ZTERM_SEQUENCE_IGNORED %s\\n' \"$token\"",
    '      ;;',
    '  esac',
    'done',
    '',
  ].join('\n'));
  run('chmod', ['755', scriptPath]);
  ensureGateSession(sessionName, 'sequence', shellQuote(scriptPath));
}

function createTuiSession(sessionName, evidenceDir) {
  const stopPath = join(evidenceDir, `${sessionName}-stop`);
  rmSync(stopPath, { force: true });
  const scriptPath = join(evidenceDir, `${sessionName}-loop.sh`);
  writeFileSync(scriptPath, [
    '#!/bin/sh',
    'stop_path="$1"',
    `body_rows=${TUI_BODY_ROWS}`,
    'i=0',
    "printf '\\033[?1049h\\033[?25l'",
    'while [ ! -f "$stop_path" ]; do',
    '  i=$((i + 1))',
    "  printf '\\033[H\\033[2J'",
    "  r=1",
    "  while [ \"$r\" -le \"$body_rows\" ]; do",
    "    printf 'ZTERM_TUI_ROW_%02d tick %06d\\n' \"$r\" \"$i\"",
    '    r=$((r + 1))',
    '  done',
    "  printf 'ZTERM_TUI_BOTTOM tick %06d' \"$i\"",
    '  sleep 0.12',
    'done',
    "printf '\\033[H\\033[2J'",
    "r=1",
    "while [ \"$r\" -le \"$body_rows\" ]; do",
    "  printf 'ZTERM_TUI_ROW_%02d tick %06d\\n' \"$r\" \"$i\"",
    '  r=$((r + 1))',
    'done',
    "printf 'ZTERM_TUI_BOTTOM tick %06d' \"$i\"",
    'while :; do sleep 3600; done',
    '',
  ].join('\n'));
  run('chmod', ['755', scriptPath]);
  ensureGateSession(sessionName, 'tui', `${shellQuote(scriptPath)} ${shellQuote(stopPath)}`);
  return { stopPath };
}

function capturePlain(sessionName, lines = 160) {
  return runTmux(['capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`]);
}

function captureVisiblePlain(sessionName) {
  return runTmux(['capture-pane', '-p', '-t', sessionName]);
}

function startPipe(sessionName, logPath) {
  writeFileSync(logPath, '');
  runTmux(['pipe-pane', '-o', '-t', sessionName, `cat >> ${shellQuote(logPath)}`]);
}

function stopPipe(sessionName) {
  runTmux(['pipe-pane', '-t', sessionName], { allowFailure: true });
}

function killDedicatedSession(sessionName, caseName) {
  if (sessionExists(sessionName)) {
    assertGateSession(sessionName, caseName);
    runTmux(['kill-session', '-t', sessionName], { allowFailure: true });
  }
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertNoExistingCdpOwner(port) {
  const owner = psForPort(port);
  if (owner.trim()) {
    throw new Error(`Refusing to start packaged smoke while CDP port ${port} is already owned:\n${owner}`);
  }
}

function captureResourceSample(name) {
  const pid = firstPidForPort(options.port);
  if (!pid) {
    writeFileSync(join(options.evidenceDir, `${name}-process.txt`), '');
    return;
  }
  const ps = run('ps', ['-p', String(pid), '-o', 'pid,ppid,pgid,%cpu,rss,vsz,etime,comm,args'], { allowFailure: true });
  const top = run('top', ['-pid', String(pid), '-stats', 'pid,cpu,mem,threads,state,time', '-l', '2'], { allowFailure: true });
  writeFileSync(join(options.evidenceDir, `${name}-ps-${pid}.txt`), ps);
  writeFileSync(join(options.evidenceDir, `${name}-top-${pid}.txt`), top);
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
  writeFileSync(join(options.evidenceDir, 'cdp-version.json'), JSON.stringify(version, null, 2));
  await sleep(700);
  writeFileSync(join(options.evidenceDir, 'process-after-open.txt'), psForPort(options.port) || '');
}

async function closePackagedApp() {
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
  writeFileSync(join(options.evidenceDir, 'process-after-close.txt'), psForPort(options.port) || '');
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
  const page = targets.find((target) => target.type === 'page' && /ZTerm Mac/u.test(target.title || ''));
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('No ZTerm Mac page target found');
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

async function resetWorkspace(call) {
  await evalPage(call, `(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('zterm:mac:workspace:v1:')) localStorage.removeItem(key);
    }
    return true;
  })()`);
  await call('Page.reload', { ignoreCache: true });
  await sleep(1100);
}

async function openLocalTmuxFromLauncher(call, sessionName) {
  const result = await evalPage(call, `(() => new Promise((resolve) => {
    const openButton = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('Open connection'));
    if (!openButton) return resolve({ ok: false, reason: 'open connection button missing' });
    openButton.click();
    setTimeout(() => {
      const cards = [...document.querySelectorAll('.mac-saved-card')];
      const card = cards.find((item) => (item.textContent || '').includes(${JSON.stringify(sessionName)}) && (item.textContent || '').includes('Local tmux session'));
      if (!card) return resolve({ ok: false, reason: 'session card missing', cards: cards.map((item) => item.textContent) });
      const button = card.querySelector('.mac-saved-open');
      if (!button) return resolve({ ok: false, reason: 'session open button missing' });
      button.click();
      resolve({ ok: true, sessionName: ${JSON.stringify(sessionName)} });
    }, 450);
  }))()`);
  if (!result.ok) {
    throw new Error(`Failed to open local tmux session ${sessionName}: ${JSON.stringify(result)}`);
  }
  await sleep(1800);
}

async function focusTerminal(call) {
  const focused = await evalPage(call, `(() => {
    const el = document.querySelector('[data-mac-terminal-input="visible-dom"]');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!focused) throw new Error('Terminal DOM focus failed');
}

async function key(call, ch) {
  if (ch === '\r') {
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await call('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return;
  }
  const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
  const code = ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`;
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await call('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

async function typeText(call, text) {
  for (const ch of text) {
    await key(call, ch);
    await sleep(2);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractMarkerLines(text, prefix) {
  const markerPattern = new RegExp(`^${escapeRegExp(prefix)}_(\\d{3})$`, 'u');
  return normalizeLines(text)
    .map((line) => line.trim())
    .filter((line) => markerPattern.test(line));
}

function suffixNumbers(lines) {
  return lines
    .map((line) => line.match(/_(\d{3})\b/u)?.[1] || null)
    .filter(Boolean);
}

function compactSequenceResult(result) {
  return {
    caseName: result.caseName,
    sessionName: result.sessionName,
    prefix: result.prefix,
    attempt: result.attempt,
    pipeSawInputToken: result.pipeSawInputToken,
    appContainsExpectedTail: result.appContainsExpectedTail,
    tmuxHasFullSequence: result.tmuxHasFullSequence,
    pipeHasFullSequence: result.pipeHasFullSequence,
    appConnectedToSession: result.appConnectedToSession,
    appLineCount: result.appLines.length,
    tmuxLineCount: result.tmuxLines.length,
    pipeLineCount: result.pipeLines.length,
    appTailSample: result.appLines.slice(-5),
    tmuxTailSample: result.tmuxLines.slice(-5),
    pipeTailSample: result.pipeLines.slice(-5),
    expectedTail: result.expectedTail,
    scroll: result.scroll,
    meta: result.meta,
  };
}

async function readAppTerminal(call) {
  return evalPage(call, `(() => {
    const viewport = document.querySelector('[data-mac-terminal-scroll="true"]');
    const viewportRect = viewport ? viewport.getBoundingClientRect() : null;
    const renderedRows = [...document.querySelectorAll('[data-terminal-row="true"]')].map((row) => ({
      index: Number(row.getAttribute('data-terminal-index') || '-1'),
      text: row.getAttribute('data-terminal-row-text') || row.innerText || row.textContent || '',
      top: row.getBoundingClientRect().top,
      bottom: row.getBoundingClientRect().bottom,
    })).sort((a, b) => a.index - b.index);
    const visibleRows = viewportRect
      ? renderedRows.filter((row) => row.bottom >= viewportRect.top - 1 && row.top <= viewportRect.bottom + 1)
      : renderedRows;
    const rows = (visibleRows.length > 0 ? visibleRows : renderedRows.slice(-80)).map((row) => ({
      index: row.index,
      text: row.text,
    }));
    const stageLines = (document.querySelector('.mac-terminal-stage')?.innerText || '').split('\\n');
    const stageText = stageLines.slice(-120).join('\\n');
    const scroll = (() => {
      const v = viewport;
      return v ? { top: v.scrollTop, height: v.scrollHeight, client: v.clientHeight, atBottom: v.scrollTop >= v.scrollHeight - v.clientHeight - 2 } : null;
    })();
    const meta = [...document.querySelectorAll('.mac-terminal-meta')].map((node) => node.innerText);
    return { rows, renderedRowCount: renderedRows.length, visibleRowCount: rows.length, stageText, scroll, meta };
  })()`);
}

async function runSequenceCase(call, sessionName) {
  const pipePath = join(options.evidenceDir, `${sessionName}-pipe.log`);
  startPipe(sessionName, pipePath);
  try {
    await openLocalTmuxFromLauncher(call, sessionName);
    await focusTerminal(call);
    const prefix = `ZTERMSEQ${Date.now()}`;
    const lines = Array.from({ length: 80 }, (_, index) => `${prefix}_${String(index + 1).padStart(3, '0')}`);
    await typeText(call, prefix);
    await key(call, '\r');
    const full = Array.from({ length: 80 }, (_, index) => String(index + 1).padStart(3, '0'));
    let result = null;
    let tmux = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      const app = await readAppTerminal(call);
      tmux = capturePlain(sessionName, 260);
      const pipe = readFileSync(pipePath, 'utf8');
      const appLines = extractMarkerLines([...app.rows.map((row) => row.text), app.stageText].join('\n'), prefix);
      const tmuxLines = extractMarkerLines(tmux, prefix);
      const pipeLines = extractMarkerLines(pipe, prefix);
      const appNums = suffixNumbers(appLines);
      const tmuxNums = suffixNumbers(tmuxLines);
      const pipeNums = suffixNumbers(pipeLines);
      const expectedTail = full.slice(-Math.min(24, appNums.length || 24));
      const pipeSawInputToken = normalizeLines(pipe).some((line) => line.trim() === prefix);
      result = {
        caseName: 'sequence',
        sessionName,
        prefix,
        attempt,
        appLines,
        tmuxLines,
        pipeLines,
        appNums,
        tmuxNums,
        pipeNums,
        expectedTail,
        pipeSawInputToken,
        appContainsExpectedTail: expectedTail.every((num) => appNums.includes(num)),
        tmuxHasFullSequence: full.every((num) => tmuxNums.includes(num)),
        pipeHasFullSequence: full.every((num) => pipeNums.includes(num)),
        appConnectedToSession: app.meta.some((line) => line.includes(sessionName) && line.includes('connected')),
        scroll: app.scroll,
        meta: app.meta,
      };
      if (result.appConnectedToSession && result.pipeSawInputToken && result.appContainsExpectedTail && result.tmuxHasFullSequence && result.pipeHasFullSequence) {
        break;
      }
    }
    if (!result) {
      throw new Error('Sequence black-box compare did not produce a comparison result');
    }
    writeFileSync(join(options.evidenceDir, 'sequence-comparison.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(options.evidenceDir, 'sequence-tmux-capture.txt'), tmux);
    if (!result.appConnectedToSession || !result.pipeSawInputToken || !result.appContainsExpectedTail || !result.tmuxHasFullSequence || !result.pipeHasFullSequence) {
      throw new Error(`Sequence black-box compare failed: ${JSON.stringify(compactSequenceResult(result), null, 2)}`);
    }
    return compactSequenceResult(result);
  } finally {
    stopPipe(sessionName);
  }
}

function extractTuiBottom(text) {
  const line = normalizeLines(text).findLast((item) => item.includes('ZTERM_TUI_BOTTOM'));
  const tick = line?.match(/tick\s+(\d+)/u)?.[1];
  return { line: line || '', tick: tick ? Number.parseInt(tick, 10) : null };
}

function compareTuiRows(appRows, tmuxText) {
  const rawAppLines = appRows
    .map((row) => String(row.text || '').trimEnd())
    .filter((line) => line.includes('ZTERM_TUI_ROW_') || line.includes('ZTERM_TUI_BOTTOM'));
  const rawTmuxLines = normalizeLines(tmuxText)
    .map((line) => line.trimEnd())
    .filter((line) => line.includes('ZTERM_TUI_ROW_') || line.includes('ZTERM_TUI_BOTTOM'));
  const appLines = currentTuiScreen(rawAppLines);
  const tmuxLines = currentTuiScreen(rawTmuxLines);
  const appBottom = extractTuiBottom(appLines.join('\n'));
  const tmuxBottom = extractTuiBottom(tmuxLines.join('\n'));
  return {
    appLines,
    tmuxLines,
    rawAppLineCount: rawAppLines.length,
    rawTmuxLineCount: rawTmuxLines.length,
    appBottom,
    tmuxBottom,
    bottomLag: appBottom.tick != null && tmuxBottom.tick != null ? tmuxBottom.tick - appBottom.tick : null,
  };
}

function currentTuiScreen(lines) {
  const bottomIndex = lines.findLastIndex((line) => line.includes('ZTERM_TUI_BOTTOM'));
  if (bottomIndex < 0) {
    return lines.slice(-TUI_SCREEN_ROWS);
  }
  return lines.slice(Math.max(0, bottomIndex - TUI_BODY_ROWS), bottomIndex + 1);
}

function compactTuiCompare(compare) {
  return {
    appBottom: compare.appBottom,
    tmuxBottom: compare.tmuxBottom,
    bottomLag: compare.bottomLag,
    appLineCount: compare.appLines.length,
    tmuxLineCount: compare.tmuxLines.length,
    rawAppLineCount: compare.rawAppLineCount,
    rawTmuxLineCount: compare.rawTmuxLineCount,
    appHeadSample: compare.appLines.slice(0, 3),
    appTailSample: compare.appLines.slice(-3),
    tmuxHeadSample: compare.tmuxLines.slice(0, 3),
    tmuxTailSample: compare.tmuxLines.slice(-3),
  };
}

async function runTuiCase(call, sessionName, stopPath) {
  await openLocalTmuxFromLauncher(call, sessionName);
  await sleep(1600);
  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    const app = await readAppTerminal(call);
    const tmux = captureVisiblePlain(sessionName);
    samples.push({ index, ...compactTuiCompare(compareTuiRows(app.rows, tmux)), scroll: app.scroll, meta: app.meta });
    await sleep(450);
  }

  writeFileSync(stopPath, 'stop\n');
  let finalCompare = null;
  let finalTmux = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(300);
    const finalApp = await readAppTerminal(call);
    finalTmux = captureVisiblePlain(sessionName);
    finalCompare = compactTuiCompare(compareTuiRows(finalApp.rows, finalTmux));
    if (finalCompare.appBottom.line && finalCompare.appBottom.line === finalCompare.tmuxBottom.line) {
      break;
    }
  }
  const appTicks = samples.map((sample) => sample.appBottom.tick).filter((tick) => tick != null);
  const tmuxTicks = samples.map((sample) => sample.tmuxBottom.tick).filter((tick) => tick != null);
  const result = {
    caseName: 'tui',
    sessionName,
    samples,
    finalCompare,
    appAdvanced: new Set(appTicks).size >= 2,
    tmuxAdvanced: new Set(tmuxTicks).size >= 2,
    maxBottomLag: Math.max(...samples.map((sample) => sample.bottomLag ?? 999)),
    finalExactBottom: finalCompare?.appBottom.line === finalCompare?.tmuxBottom.line,
    finalHasRows: (finalCompare?.appLineCount ?? 0) >= 20 && (finalCompare?.tmuxLineCount ?? 0) >= 20,
  };
  writeFileSync(join(options.evidenceDir, 'tui-refresh-comparison.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(options.evidenceDir, 'tui-final-tmux-capture.txt'), finalTmux);
  const ok = result.appAdvanced
    && result.tmuxAdvanced
    && result.maxBottomLag <= 12
    && result.finalExactBottom
    && result.finalHasRows;
  if (!ok) {
    throw new Error(`TUI refresh black-box compare failed: ${JSON.stringify({
      caseName: result.caseName,
      sessionName: result.sessionName,
      appAdvanced: result.appAdvanced,
      tmuxAdvanced: result.tmuxAdvanced,
      maxBottomLag: result.maxBottomLag,
      finalExactBottom: result.finalExactBottom,
      finalHasRows: result.finalHasRows,
      finalCompare: result.finalCompare,
    }, null, 2)}`);
  }
  return result;
}

async function captureScreenshot(call, name) {
  const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(options.evidenceDir, name), Buffer.from(result.data, 'base64'));
}

async function main() {
  const sequenceSession = FIXED_GATE_SESSIONS.sequence;
  const tuiSession = FIXED_GATE_SESSIONS.tui;
  const summary = {
    evidenceDir: options.evidenceDir,
    port: options.port,
    appPath: options.appPath,
    sessionLifecycle: {
      mode: 'fixed-dedicated-reuse',
      owner: GATE_SESSION_OWNER,
      cleanupSessions: options.cleanupSessions,
    },
    sequenceSession,
    tuiSession,
    results: [],
  };
  let tuiFixture = null;
  try {
    if (options.caseName === 'sequence' || options.caseName === 'all') {
      createSequenceSession(sequenceSession, options.evidenceDir);
    }
    if (options.caseName === 'tui' || options.caseName === 'all') {
      tuiFixture = createTuiSession(tuiSession, options.evidenceDir);
    }
    await startPackagedApp();
    const pageSocket = await connectPage();
    await resetWorkspace(pageSocket.call);
    pageSocket.ws.close();
    const freshSocket = await connectPage();
    if (options.caseName === 'sequence' || options.caseName === 'all') {
      summary.results.push(await runSequenceCase(freshSocket.call, sequenceSession));
      await captureScreenshot(freshSocket.call, 'sequence.png');
    }
    if (options.caseName === 'tui' || options.caseName === 'all') {
      summary.results.push(await runTuiCase(freshSocket.call, tuiSession, tuiFixture.stopPath));
      await captureScreenshot(freshSocket.call, 'tui.png');
    }
    captureResourceSample('resource-before-close');
    freshSocket.ws.close();
    summary.ok = true;
    writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.stack || error.message : String(error);
    writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.error(summary.error);
    process.exitCode = 1;
  } finally {
    await closePackagedApp();
    if (options.cleanupSessions) {
      if (options.caseName === 'sequence' || options.caseName === 'all') {
        killDedicatedSession(sequenceSession, 'sequence');
      }
      if (options.caseName === 'tui' || options.caseName === 'all') {
        killDedicatedSession(tuiSession, 'tui');
      }
    }
  }
}

await main();

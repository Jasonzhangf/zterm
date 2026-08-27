#!/usr/bin/env node
/**
 * Packaged Mac layout visual smoke.
 *
 * Launches the packaged .app with a dedicated CDP port, clicks the production
 * Split button, records DOM layout metrics, captures a screenshot, and closes
 * the launched app through Browser.close.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const ROOT = resolve(new URL('..', import.meta.url).pathname, '..');
const MAC_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DATE = new Date().toISOString().slice(0, 10);
const DEFAULT_PORT = 9371;

function parseArgs(argv) {
  const out = {
    port: DEFAULT_PORT,
    appPath: join(MAC_ROOT, 'out', 'mac-arm64', 'ZTerm.app'),
    evidenceDir: join(MAC_ROOT, 'evidence', `${DATE}-layout-visual-smoke`),
  };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) out.port = Number.parseInt(arg.slice('--port='.length), 10);
    else if (arg.startsWith('--app=')) out.appPath = resolve(ROOT, arg.slice('--app='.length));
    else if (arg.startsWith('--evidence=')) out.evidenceDir = resolve(ROOT, arg.slice('--evidence='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port=${out.port}`);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const executable = join(options.appPath, 'Contents', 'MacOS', 'ZTerm');

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchJson(url, timeoutMs = 10000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out fetching ${url}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout || '';
}

function portOwners(port) {
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { allowFailure: true }).trim();
}

async function waitForCleanClose(pid, port, timeoutMs = 6000) {
  const started = Date.now();
  let remainingPort = '';
  let remainingProcess = '';
  while (Date.now() - started < timeoutMs) {
    remainingPort = portOwners(port);
    remainingProcess = pid
      ? run('ps', ['-p', String(pid), '-o', 'pid=,comm='], { allowFailure: true })
      : '';
    if (!remainingPort && !remainingProcess.trim()) {
      return { remainingPort: '', remainingProcess: '' };
    }
    await sleep(250);
  }
  return { remainingPort, remainingProcess };
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolveCommand, rejectCommand } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rejectCommand(new Error(JSON.stringify(msg.error)));
      else resolveCommand(msg.result || {});
    }
  });
  ws.on('close', () => {
    for (const { rejectCommand } of pending.values()) rejectCommand(new Error('CDP websocket closed'));
    pending.clear();
  });
  ws.on('error', (error) => {
    for (const { rejectCommand } of pending.values()) rejectCommand(error);
    pending.clear();
  });
  return new Promise((resolveClient, rejectClient) => {
    ws.once('open', () => {
      resolveClient({
        command(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveCommand, rejectCommand) => {
            pending.set(id, { resolveCommand, rejectCommand });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.once('error', rejectClient);
  });
}

async function main() {
  if (!existsSync(executable)) {
    throw new Error(`Packaged executable does not exist: ${executable}`);
  }
  const existingPort = portOwners(options.port);
  if (existingPort) {
    throw new Error(`Refusing to reuse busy CDP port ${options.port}:\n${existingPort}`);
  }
  mkdirSync(options.evidenceDir, { recursive: true });
  const userDataDir = join(options.evidenceDir, 'user-data');
  mkdirSync(userDataDir, { recursive: true });

  const child = spawn(executable, [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
  ], {
    cwd: MAC_ROOT,
    env: { ...process.env, ZTERM_MAC_SMOKE: 'layout-visual' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(options.evidenceDir, 'launch-pid.txt'), `${child.pid}\n`);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  let browserClient = null;
  let pageClient = null;
  try {
    const version = await fetchJson(`http://127.0.0.1:${options.port}/json/version`);
    const targets = await fetchJson(`http://127.0.0.1:${options.port}/json/list`);
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) {
      throw new Error(`No page target found on CDP port ${options.port}`);
    }
    browserClient = await createCdpClient(version.webSocketDebuggerUrl);
    pageClient = await createCdpClient(page.webSocketDebuggerUrl);
    await pageClient.command('Runtime.enable');
    await pageClient.command('Page.enable');
    await pageClient.command('Page.bringToFront');
    await pageClient.command('Emulation.setDeviceMetricsOverride', {
      width: 2400,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);

    const before = await pageClient.command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const splitButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Split'));
        const stage = document.querySelector('[data-testid="pane-stage-single"]');
        const workspace = document.querySelector('.mac-workspace-main');
        const terminalStage = document.querySelector('.mac-terminal-stage');
        return {
          rootChildren: document.getElementById('root')?.children.length ?? -1,
          hasSplitButton: Boolean(splitButton),
          splitButtonDisabled: splitButton ? splitButton.disabled : null,
          hasSingleStage: Boolean(stage),
          workspaceGridTemplateColumns: workspace ? getComputedStyle(workspace).gridTemplateColumns : null,
          workspaceGap: workspace ? getComputedStyle(workspace).gap : null,
          terminalStagePadding: terminalStage ? getComputedStyle(terminalStage).padding : null,
        };
      })()`,
    });

    await pageClient.command('Runtime.evaluate', {
      expression: `(() => {
        const splitButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Split'));
        if (!splitButton) throw new Error('Split button not found');
        splitButton.click();
      })()`,
    });
    await sleep(500);

    const after = await pageClient.command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const splitStage = document.querySelector('[data-testid="pane-stage-split"], [data-testid="mac-pane-workbench-tree"]');
        const frames = Array.from(document.querySelectorAll('[data-testid="pane-stage-frame"]'));
        const divider = document.querySelector('[data-testid="pane-stage-divider"], [data-testid^="mac-pane-divider-"]');
        const terminalStage = document.querySelector('.mac-terminal-stage');
        const terminalSurface = document.querySelector('.mac-terminal-surface');
        const rail = document.querySelector('.mac-server-rail');
        return {
          hasSplitStage: Boolean(splitStage),
          frameCount: frames.length,
          dividerCount: document.querySelectorAll('[data-testid="pane-stage-divider"], [data-testid^="mac-pane-divider-"]').length,
          activeFrameCount: document.querySelectorAll('[data-testid="pane-stage-frame"][data-pane-active="true"]').length,
          splitStageGap: splitStage ? getComputedStyle(splitStage).gap : null,
          splitStageMargin: splitStage ? getComputedStyle(splitStage).margin : null,
          dividerWidth: divider ? getComputedStyle(divider).width : null,
          terminalStagePadding: terminalStage ? getComputedStyle(terminalStage).padding : null,
          terminalStageRadius: terminalStage ? getComputedStyle(terminalStage).borderRadius : null,
          terminalSurfaceRadius: terminalSurface ? getComputedStyle(terminalSurface).borderRadius : null,
          railWidth: rail ? rail.getBoundingClientRect().width : null,
          frameRects: frames.map((frame) => {
            const rect = frame.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          }),
          frameBackgrounds: frames.map((frame) => getComputedStyle(frame).backgroundColor),
        };
      })()`,
    });
    const dragStart = after.result.value.frameRects[0]?.width || 0;
    const dividerBox = await pageClient.command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const divider = document.querySelector('[data-testid="pane-stage-divider"], [data-testid^="mac-pane-divider-"]');
        if (!divider) throw new Error('divider not found');
        const rect = divider.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    });
    const startPoint = dividerBox.result.value;
    await pageClient.command('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startPoint.x,
      y: startPoint.y,
      button: 'none',
    });
    await pageClient.command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startPoint.x,
      y: startPoint.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await pageClient.command('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startPoint.x + 240,
      y: startPoint.y,
      button: 'left',
      buttons: 1,
    });
    await sleep(120);
    const duringDrag = await pageClient.command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const frames = Array.from(document.querySelectorAll('[data-testid="pane-stage-frame"]'));
        return {
          frameRects: frames.map((frame) => {
            const rect = frame.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          }),
          bodyCursor: document.body.style.cursor,
          bodyUserSelect: document.body.style.userSelect,
        };
      })()`,
    });
    await pageClient.command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: startPoint.x + 240,
      y: startPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(250);

    const screenshot = await pageClient.command('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(join(options.evidenceDir, 'layout-split.png'), Buffer.from(screenshot.data, 'base64'));
    const summary = {
      appPath: options.appPath,
      executable,
      port: options.port,
      pid: child.pid,
      cdpVersion: version.Browser,
      before: before.result.value,
      after: after.result.value,
      duringDrag: duringDrag.result.value,
    };
    writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
    if (
      !summary.after.hasSplitStage ||
      summary.after.frameCount !== 2 ||
      summary.after.dividerCount !== 1 ||
      summary.after.dividerWidth !== '2px' ||
      Math.abs((summary.duringDrag.frameRects[0]?.width || 0) - dragStart) < 120
    ) {
      throw new Error(`Packaged layout smoke failed:\n${JSON.stringify({ after: summary.after, duringDrag: summary.duringDrag }, null, 2)}`);
    }
    console.log(JSON.stringify(summary, null, 2));
    await browserClient.command('Browser.close').catch((error) => {
      if (!String(error?.message || error).includes('CDP websocket closed')) {
        throw error;
      }
    });
  } finally {
    if (pageClient) pageClient.close();
    if (browserClient) browserClient.close();
    writeFileSync(join(options.evidenceDir, 'stdout.txt'), stdout.join(''));
    writeFileSync(join(options.evidenceDir, 'stderr.txt'), stderr.join(''));
    const { remainingPort, remainingProcess } = await waitForCleanClose(child.pid, options.port);
    writeFileSync(join(options.evidenceDir, 'cdp-port-after-close.txt'), remainingPort ? `${remainingPort}\n` : '');
    writeFileSync(join(options.evidenceDir, 'process-after-close.txt'), remainingProcess);
    if (remainingPort || remainingProcess.trim()) {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch {
          // Already exited.
        }
        await sleep(1000);
      }
      const finalPort = portOwners(options.port);
      const finalProcess = child.pid
        ? run('ps', ['-p', String(child.pid), '-o', 'pid=,comm='], { allowFailure: true })
        : '';
      writeFileSync(join(options.evidenceDir, 'cdp-port-after-term.txt'), finalPort ? `${finalPort}\n` : '');
      writeFileSync(join(options.evidenceDir, 'process-after-term.txt'), finalProcess);
      if (finalPort || finalProcess.trim()) {
        throw new Error(`Packaged app did not close cleanly. port=${Boolean(finalPort)} process=${finalProcess.trim()}`);
      }
    }
  }
}

main().catch((error) => {
  mkdirSync(options.evidenceDir, { recursive: true });
  writeFileSync(join(options.evidenceDir, 'failure.txt'), `${error.stack || error.message}\n`);
  console.error(error.stack || error.message);
  process.exit(1);
});

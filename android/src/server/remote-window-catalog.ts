import { spawn, type ChildProcess } from 'child_process';
import { WebSocket, type RawData } from 'ws';
import type {
  RemoteWindowStreamRect,
  RemoteWindowStreamTargetManifest,
  RemoteWindowBrowserUserAgent,
} from '@zterm/shared/protocol';
import {
  formatInlineScriptExecFailure,
  rectWithOffset,
  validateRect,
} from './remote-window-support';

export const DEFAULT_ITERM2_PYTHON_TIMEOUT_MS = 5000;
export const DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS = 15000;
export const DEFAULT_CHROME_CDP_PORT = 9222;

const ITERM2_APP_BUNDLE_ID = 'com.googlecode.iterm2';
const ITERM2_PANE_GAP_PX = 1;
const CHROME_APP_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.canary',
  'com.google.Chrome.dev',
]);

function terminateProcessTree(child: ChildProcess) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function runInlineScript(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string; fallbackMessage: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcessTree(child);
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, options.timeoutMs);

    const finish = (callback: () => void) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error: Error) => finish(() => reject(error)));
    child.on('close', () => finish(() => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut || child.exitCode !== 0) {
        if (timedOut) {
          reject(new Error([
            stderr.trim(),
            `${options.timeoutMessage} after ${options.timeoutMs}ms`,
          ].filter(Boolean).join('\n')));
          return;
        }
        const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
        reject(new Error(formatInlineScriptExecFailure(
          error,
          stdout,
          stderr,
          options.timeoutMs,
          options.timeoutMessage,
          options.fallbackMessage,
        )));
        return;
      }
      resolve(stdout);
    }));
  });
}

export interface MacosAppWindowCatalog {
  windows: MacosAppWindow[];
}

export interface MacosAppWindow {
  windowId: string;
  ownerName: string;
  appBundleId: string;
  pid: number;
  title: string;
  frame: RemoteWindowStreamRect;
  contentFrame?: RemoteWindowStreamRect;
  displayId?: string;
  displayBoundsTopLeftPx?: RemoteWindowStreamRect;
}

export async function setChromeWindowUserAgent(
  target: RemoteWindowStreamTargetManifest,
  userAgent: RemoteWindowBrowserUserAgent,
  options: { cdpPort?: number; timeoutMs?: number } = {},
): Promise<{ cdpTargetId: string }> {
  if (target.videoTarget.kind !== 'app-window' || !CHROME_APP_BUNDLE_IDS.has(target.videoTarget.appBundleId)) {
    throw new Error('selected target is not a supported Chrome window');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let targets: Array<{ id: string; type: string; title?: string; webSocketDebuggerUrl?: string }>;
  try {
    const response = await fetch(`http://127.0.0.1:${options.cdpPort ?? DEFAULT_CHROME_CDP_PORT}/json/list`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Chrome CDP returned HTTP ${response.status}`);
    targets = await response.json() as typeof targets;
  } catch (error) {
    throw new Error(`Chrome CDP unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
  const candidates = targets.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl && item.title === target.videoTarget.title);
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? 'Chrome CDP page target did not match the selected window title'
      : 'Chrome CDP page target match is ambiguous');
  }
  const webSocketDebuggerUrl = candidates[0].webSocketDebuggerUrl;
  if (!webSocketDebuggerUrl) {
    throw new Error('Chrome CDP page target has no websocket endpoint');
  }
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP websocket timed out')), timeoutMs);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const commandId = Date.now();
      const timer = setTimeout(() => reject(new Error('Chrome CDP UA command timed out')), timeoutMs);
      const onMessage = (data: RawData) => {
        let message: { id?: number; error?: { message?: string } };
        try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
        if (message.id !== commandId) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        if (message.error) reject(new Error(message.error.message || 'Chrome CDP UA command failed'));
        else resolve();
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({
        id: commandId,
        method: 'Emulation.setUserAgentOverride',
        params: {
          userAgent: userAgent === 'mobile'
            ? 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36'
            : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
        },
      }), (error) => {
        if (error) { clearTimeout(timer); socket.off('message', onMessage); reject(error); }
      });
    });
    return { cdpTargetId: candidates[0].id };
  } finally {
    socket.close();
  }
}

export interface Iterm2RawCatalog {
  windows: Iterm2RawWindow[];
}

export interface Iterm2RawWindow {
  windowId: string;
  title: string;
  pid?: number;
  frame: RemoteWindowStreamRect;
  tabs: Iterm2RawTab[];
}

export interface Iterm2RawTab {
  tabId: string;
  activeSessionId?: string | null;
  root: Iterm2RawNode | null;
}

export type Iterm2RawNode = Iterm2RawSplitterNode | Iterm2RawSessionNode;

export interface Iterm2RawSplitterNode {
  type: 'splitter';
  vertical: boolean;
  children: Iterm2RawNode[];
}

export interface Iterm2RawSessionNode {
  type: 'session';
  sessionId: string;
  title: string;
  tty?: string | null;
  frame: RemoteWindowStreamRect;
  gridSize?: { width: number; height: number };
}

export interface FlattenedIterm2Pane {
  sessionId: string;
  title: string;
  tty: string | null;
  frame: RemoteWindowStreamRect;
  gridSize?: { width: number; height: number };
}

export interface TmuxClientTarget {
  tty: string;
  tmuxSession: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
}

function measureIterm2Node(node: Iterm2RawNode): { width: number; height: number } {
  if (node.type === 'session') {
    const frame = validateRect(node.frame, `session:${node.sessionId}`);
    return {
      width: frame.x + frame.width,
      height: frame.y + frame.height,
    };
  }

  if (node.children.length === 0) {
    return { width: 0, height: 0 };
  }

  let cursor = 0;
  let width = 0;
  let height = 0;
  for (const child of node.children) {
    if (child.type === 'session') {
      const frame = validateRect(child.frame, `session:${child.sessionId}`);
      width = Math.max(width, frame.x + frame.width);
      height = Math.max(height, frame.y + frame.height);
      cursor = Math.max(
        cursor,
        node.vertical ? frame.x + frame.width : frame.y + frame.height,
      ) + ITERM2_PANE_GAP_PX;
      continue;
    }

    const childSize = measureIterm2Node(child);
    const childOffset = node.vertical
      ? { x: cursor, y: 0 }
      : { x: 0, y: cursor };
    width = Math.max(width, childOffset.x + childSize.width);
    height = Math.max(height, childOffset.y + childSize.height);
    cursor += (node.vertical ? childSize.width : childSize.height) + ITERM2_PANE_GAP_PX;
  }

  return { width, height };
}

export function flattenIterm2SplitTree(
  node: Iterm2RawNode | null,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): FlattenedIterm2Pane[] {
  if (!node) {
    return [];
  }

  if (node.type === 'session') {
    return [{
      sessionId: node.sessionId,
      title: node.title,
      tty: node.tty || null,
      frame: rectWithOffset(validateRect(node.frame, `session:${node.sessionId}`), origin),
      gridSize: node.gridSize,
    }];
  }

  const panes: FlattenedIterm2Pane[] = [];
  let cursor = 0;
  for (const child of node.children) {
    if (child.type === 'session') {
      panes.push(...flattenIterm2SplitTree(child, origin));
      const childFrame = validateRect(child.frame, `session:${child.sessionId}`);
      cursor = Math.max(
        cursor,
        node.vertical ? childFrame.x + childFrame.width : childFrame.y + childFrame.height,
      ) + ITERM2_PANE_GAP_PX;
      continue;
    }

    const childSize = measureIterm2Node(child);
    const childOrigin = node.vertical
      ? { x: origin.x + cursor, y: origin.y }
      : { x: origin.x, y: origin.y + cursor };
    panes.push(...flattenIterm2SplitTree(child, childOrigin));
    cursor += (node.vertical ? childSize.width : childSize.height) + ITERM2_PANE_GAP_PX;
  }
  return panes;
}

export function parseTmuxClientTargets(stdout: string): Map<string, TmuxClientTarget> {
  const targets = new Map<string, TmuxClientTarget>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [tty, tmuxSession, tmuxWindowId, tmuxPaneId] = trimmed.split('\t');
    if (!tty || !tmuxSession) {
      continue;
    }
    targets.set(tty, {
      tty,
      tmuxSession,
      tmuxWindowId: tmuxWindowId || undefined,
      tmuxPaneId: tmuxPaneId || undefined,
    });
  }
  return targets;
}

function computeContentBounds(panes: FlattenedIterm2Pane[]) {
  return panes.reduce(
    (bounds, pane) => ({
      width: Math.max(bounds.width, pane.frame.x + pane.frame.width),
      height: Math.max(bounds.height, pane.frame.y + pane.frame.height),
    }),
    { width: 0, height: 0 },
  );
}

export function assertPaneCropWithinWindow(
  windowFrame: RemoteWindowStreamRect,
  cropRect: RemoteWindowStreamRect,
  label: string,
) {
  const relativeLeft = cropRect.x - windowFrame.x;
  const relativeTop = cropRect.y - windowFrame.y;
  const relativeRight = relativeLeft + cropRect.width;
  const relativeBottom = relativeTop + cropRect.height;
  if (
    relativeLeft < 0
    || relativeTop < 0
    || relativeRight > windowFrame.width
    || relativeBottom > windowFrame.height
  ) {
    throw new Error(`${label} crop rectangle is outside its window bounds`);
  }
}

export function buildRemoteWindowStreamTargets(
  catalog: Iterm2RawCatalog,
  tmuxTargets: Map<string, TmuxClientTarget>,
  now: string,
  options: {
    includeAppWindowTargets?: boolean;
    macosAppWindowCatalog?: MacosAppWindowCatalog | null;
    requireCaptureWindowForPanes?: boolean;
  } = {},
): RemoteWindowStreamTargetManifest[] {
  const targets: RemoteWindowStreamTargetManifest[] = [];
  const includeAppWindowTargets = options.includeAppWindowTargets !== false;
  const appWindows = options.macosAppWindowCatalog?.windows || [];
  const requireCaptureWindowForPanes = options.requireCaptureWindowForPanes === true;
  let iTermPaneCount = 0;
  let skippedPaneCount = 0;

  for (const window of catalog.windows) {
    const itermWindowFrame = validateRect(window.frame, `window:${window.windowId}`);
    const captureWindow = findMatchingIterm2CaptureWindow(window, appWindows);
    const captureWindowFrame = captureWindow
      ? validateRect(captureWindow.frame, `app-window:${captureWindow.windowId}`)
      : itermWindowFrame;
    if (includeAppWindowTargets && (!requireCaptureWindowForPanes || captureWindow)) {
      targets.push({
        streamTargetId: captureWindow
          ? `app-window:${captureWindow.pid}:${captureWindow.windowId}`
          : `app-window:${window.windowId}`,
        videoTarget: {
          kind: 'app-window',
          appBundleId: ITERM2_APP_BUNDLE_ID,
          pid: captureWindow?.pid ?? window.pid ?? 0,
          windowId: captureWindow?.windowId ?? window.windowId,
          title: captureWindow?.title || window.title || 'iTerm2',
          windowBoundsTopLeftPx: captureWindowFrame,
          cropRectTopLeftPx: captureWindowFrame,
        },
        inputTarget: {
          kind: 'app-window',
        },
        streamMode: 'interactive',
        focusPolicy: 'bring-to-focus',
        inputRoute: 'os-event',
        capture: {
          source: 'ScreenCaptureKit',
          coordinateSpace: 'macos-top-left-px',
          scale: 1,
          createdAt: now,
        },
      });
    }

    if (requireCaptureWindowForPanes && !captureWindow) {
      for (const tab of window.tabs) {
        skippedPaneCount += flattenIterm2SplitTree(tab.root).length;
      }
      continue;
    }

    for (const tab of window.tabs) {
      const panes = flattenIterm2SplitTree(tab.root);
      iTermPaneCount += panes.length;
      const contentBounds = computeContentBounds(panes);
      if (contentBounds.width > captureWindowFrame.width || contentBounds.height > captureWindowFrame.height) {
        throw new Error(`window:${window.windowId}:tab:${tab.tabId} content bounds exceed window bounds`);
      }
      const contentTopInsetPx = captureWindowFrame.height - contentBounds.height;
      for (const pane of panes) {
        const tmuxTarget = pane.tty ? tmuxTargets.get(pane.tty) : undefined;
        const cropRectTopLeftPx = {
          x: captureWindowFrame.x + pane.frame.x,
          y: captureWindowFrame.y + contentTopInsetPx + pane.frame.y,
          width: pane.frame.width,
          height: pane.frame.height,
        };
        assertPaneCropWithinWindow(
          captureWindowFrame,
          cropRectTopLeftPx,
          `window:${window.windowId}:tab:${tab.tabId}:pane:${pane.sessionId}`,
        );
        targets.push({
          streamTargetId: `iterm2-pane:${window.windowId}:${tab.tabId}:${pane.sessionId}`,
          videoTarget: {
            kind: 'iterm2-pane',
            appBundleId: ITERM2_APP_BUNDLE_ID,
            pid: captureWindow?.pid ?? window.pid ?? 0,
            windowId: captureWindow?.windowId ?? window.windowId,
            title: pane.title || window.title || 'iTerm2 pane',
            windowBoundsTopLeftPx: captureWindowFrame,
            paneRectInContentPx: pane.frame,
            cropRectTopLeftPx,
            contentTopInsetPx,
          },
          inputTarget: tmuxTarget
            ? {
                kind: 'tmux-pane',
                itermSessionId: pane.sessionId,
                tty: pane.tty || undefined,
                tmuxSession: tmuxTarget.tmuxSession,
                tmuxWindowId: tmuxTarget.tmuxWindowId,
                tmuxPaneId: tmuxTarget.tmuxPaneId,
              }
            : {
                kind: 'iterm2-pane',
                itermSessionId: pane.sessionId,
                tty: pane.tty || undefined,
              },
          streamMode: 'view',
          focusPolicy: tmuxTarget ? 'no-focus-steal' : 'bring-to-focus',
          inputRoute: tmuxTarget ? 'tmux-input' : 'iterm2-api',
          capture: {
            source: 'ScreenCaptureKit',
            coordinateSpace: 'macos-top-left-px',
            ...(captureWindow?.displayId ? { displayId: captureWindow.displayId } : {}),
            ...(captureWindow?.displayBoundsTopLeftPx ? { displayBoundsTopLeftPx: captureWindow.displayBoundsTopLeftPx } : {}),
            scale: 1,
            createdAt: now,
          },
        });
      }
    }
  }

  if (requireCaptureWindowForPanes && iTermPaneCount === 0 && skippedPaneCount > 0) {
    throw new Error('iTerm2 ScreenCaptureKit window id unavailable for all panes');
  }

  return targets;
}

function findMatchingIterm2CaptureWindow(
  window: Iterm2RawWindow,
  appWindows: MacosAppWindow[],
): MacosAppWindow | null {
  const itermWindowFrame = validateRect(window.frame, `window:${window.windowId}`);
  let best: { window: MacosAppWindow; score: number } | null = null;
  for (const candidate of appWindows) {
    if (candidate.appBundleId !== ITERM2_APP_BUNDLE_ID) {
      continue;
    }
    const frame = validateRect(candidate.frame, `app-window:${candidate.windowId}`);
    const geometryScore = Math.abs(frame.x - itermWindowFrame.x)
      + Math.abs(frame.width - itermWindowFrame.width)
      + Math.abs(frame.height - itermWindowFrame.height);
    if (geometryScore > 48) {
      continue;
    }
    const score = geometryScore + Math.min(48, Math.abs(frame.y - itermWindowFrame.y));
    if (!best || score < best.score) {
      best = { window: candidate, score };
    }
  }
  return best?.window || null;
}

export function buildMacosAppWindowTargets(
  catalog: MacosAppWindowCatalog,
  now: string,
): RemoteWindowStreamTargetManifest[] {
  return catalog.windows.map((window) => {
    const windowFrame = validateRect(window.frame, `app-window:${window.windowId}`);
    // ScreenCaptureKit 的 desktopIndependentWindow 坐标真源是窗口 frame。
    // AX contentFrame 可能保留独立的 title-bar 偏移，不能直接作为该 capture
    // source 的 crop rect；否则 crop 会落到 windowBounds 之外，focus update 必失败。
    const cropRect = windowFrame;
    return {
      streamTargetId: `app-window:${window.pid}:${window.windowId}`,
      videoTarget: {
        kind: 'app-window',
        appBundleId: window.appBundleId,
        ownerName: window.ownerName || undefined,
        pid: window.pid,
        windowId: window.windowId,
        title: window.title || window.ownerName || window.appBundleId || `Window ${window.windowId}`,
        windowBoundsTopLeftPx: windowFrame,
        cropRectTopLeftPx: cropRect,
      },
      inputTarget: {
        kind: 'app-window',
      },
      streamMode: 'interactive',
      focusPolicy: 'bring-to-focus',
      inputRoute: 'os-event',
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        ...(window.displayId ? { displayId: window.displayId } : {}),
        ...(window.displayBoundsTopLeftPx ? { displayBoundsTopLeftPx: window.displayBoundsTopLeftPx } : {}),
        scale: 1,
        createdAt: now,
      },
    };
  });
}

export function runDefaultIterm2Python(
  script: string,
  options: { pythonBinary: string; timeoutMs: number },
): Promise<string> {
  return runInlineScript(options.pythonBinary, ['-c', script], {
    timeoutMs: options.timeoutMs,
    timeoutMessage: 'iTerm2 Python catalog timed out',
    fallbackMessage: 'iTerm2 Python API failed',
  });
}

export function runDefaultMacosAppWindowCatalog(
  script: string,
  options: { swiftBinary: string; timeoutMs: number },
): Promise<string> {
  return runInlineScript(options.swiftBinary, ['-e', script], {
    timeoutMs: options.timeoutMs,
    timeoutMessage: 'macOS app window catalog timed out',
    fallbackMessage: 'macOS app window catalog failed',
  });
}

export function parseIterm2Catalog(stdout: string): Iterm2RawCatalog {
  const parsed = JSON.parse(stdout) as Iterm2RawCatalog;
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error('iTerm2 catalog missing windows');
  }
  return parsed;
}

export function parseMacosAppWindowCatalog(stdout: string): MacosAppWindowCatalog {
  const parsed = JSON.parse(stdout) as MacosAppWindowCatalog;
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error('macOS app window catalog missing windows');
  }
  return parsed;
}

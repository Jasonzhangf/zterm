import { execFile } from 'node:child_process';
import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRect,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '@zterm/shared/protocol';

const DEFAULT_ITERM2_PYTHON_TIMEOUT_MS = 5000;
const DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS = 5000;
const ITERM2_APP_BUNDLE_ID = 'com.googlecode.iterm2';
const ITERM2_PANE_GAP_PX = 1;

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

export interface RemoteWindowStreamDaemonDeps {
  platform?: NodeJS.Platform;
  now?: () => string;
  pythonBinary?: string;
  swiftBinary?: string;
  iterm2PythonTimeoutMs?: number;
  appWindowCatalogTimeoutMs?: number;
  runIterm2Python?: (script: string, options: { pythonBinary: string; timeoutMs: number }) => Promise<string>;
  runMacosAppWindowCatalog?: (script: string, options: { swiftBinary: string; timeoutMs: number }) => Promise<string>;
  runTmux: (args: string[]) => { ok: true; stdout: string };
}

export interface RemoteWindowStreamDaemonRuntime {
  listTargets: (
    payload: RemoteWindowStreamRequestPayload,
  ) => Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>;
}

const ITERM2_CATALOG_PYTHON = String.raw`
import json
import iterm2

def frame_dict(frame):
    return {
        "x": int(round(frame.origin.x)),
        "y": int(round(frame.origin.y)),
        "width": int(round(frame.size.width)),
        "height": int(round(frame.size.height)),
    }

async def node_dict(node):
    if hasattr(node, "session_id"):
        tty = None
        try:
            tty = await node.async_get_variable("session.tty")
        except Exception:
            tty = None
        grid = None
        try:
            grid = {"width": int(node.grid_size.width), "height": int(node.grid_size.height)}
        except Exception:
            grid = None
        return {
            "type": "session",
            "sessionId": node.session_id,
            "title": getattr(node, "name", "") or "",
            "tty": tty,
            "frame": frame_dict(node.frame),
            "gridSize": grid,
        }
    children = []
    for child in getattr(node, "children", []) or []:
        children.append(await node_dict(child))
    return {
        "type": "splitter",
        "vertical": bool(getattr(node, "vertical", False)),
        "children": children,
    }

async def main(connection):
    app = await iterm2.async_get_app(connection)
    windows = []
    for window in app.terminal_windows:
        frame = await window.async_get_frame()
        tabs = []
        for tab in window.tabs:
            try:
                await tab.async_update_layout()
            except Exception:
                pass
            root = await node_dict(tab.root) if tab.root else None
            tabs.append({
                "tabId": tab.tab_id,
                "activeSessionId": tab.active_session_id,
                "root": root,
            })
        windows.append({
            "windowId": getattr(window, "window_id", "") or "",
            "title": "iTerm2",
            "pid": 0,
            "frame": frame_dict(frame),
            "tabs": tabs,
        })
    print(json.dumps({"windows": windows}, ensure_ascii=False))

iterm2.run_until_complete(main)
`;

const MACOS_APP_WINDOW_CATALOG_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    return nil
}

let windowInfoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var windows: [[String: Any]] = []

for info in windowInfoList {
    guard let layerValue = number(info[kCGWindowLayer as String]), Int(layerValue) == 0 else {
        continue
    }
    let alpha = number(info[kCGWindowAlpha as String]) ?? 1
    if alpha <= 0 {
        continue
    }
    guard
        let pidNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
        let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let x = number(bounds["X"]),
        let y = number(bounds["Y"]),
        let width = number(bounds["Width"]),
        let height = number(bounds["Height"])
    else {
        continue
    }
    if width < 40 || height < 40 {
        continue
    }
    let pid = pidNumber.intValue
    let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
    let rawTitle = info[kCGWindowName as String] as? String ?? ""
    let appBundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
    let windowId = (info[kCGWindowNumber as String] as? NSNumber)?.stringValue ?? ""
    let title = rawTitle.isEmpty ? (ownerName.isEmpty ? appBundleId : ownerName) : rawTitle
    windows.append([
        "windowId": windowId,
        "ownerName": ownerName,
        "appBundleId": appBundleId,
        "pid": pid,
        "title": title,
        "frame": [
            "x": Int(x.rounded()),
            "y": Int(y.rounded()),
            "width": Int(width.rounded()),
            "height": Int(height.rounded()),
        ],
    ])
}

let data = try JSONSerialization.data(withJSONObject: ["windows": windows], options: [])
FileHandle.standardOutput.write(data)
`;

function remoteWindowError(
  payload: RemoteWindowStreamRequestPayload,
  code: string,
  message: string,
): RemoteWindowStreamErrorPayload {
  return {
    requestId: payload.requestId || '',
    code,
    message,
  };
}

function validateRect(rect: RemoteWindowStreamRect, label: string): RemoteWindowStreamRect {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = rect[key];
    if (!Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be finite`);
    }
  }
  if (rect.width < 0 || rect.height < 0) {
    throw new Error(`${label} dimensions must be non-negative`);
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function rectWithOffset(rect: RemoteWindowStreamRect, offset: { x: number; y: number }): RemoteWindowStreamRect {
  return {
    x: offset.x + rect.x,
    y: offset.y + rect.y,
    width: rect.width,
    height: rect.height,
  };
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

function assertPaneCropWithinWindow(
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
  options: { includeAppWindowTargets?: boolean } = {},
): RemoteWindowStreamTargetManifest[] {
  const targets: RemoteWindowStreamTargetManifest[] = [];
  const includeAppWindowTargets = options.includeAppWindowTargets !== false;

  for (const window of catalog.windows) {
    const windowFrame = validateRect(window.frame, `window:${window.windowId}`);
    if (includeAppWindowTargets) {
      targets.push({
        streamTargetId: `app-window:${window.windowId}`,
        videoTarget: {
          kind: 'app-window',
          appBundleId: ITERM2_APP_BUNDLE_ID,
          pid: window.pid || 0,
          windowId: window.windowId,
          title: window.title || 'iTerm2',
          windowBoundsTopLeftPx: windowFrame,
          cropRectTopLeftPx: windowFrame,
        },
        inputTarget: {
          kind: 'app-window',
        },
        streamMode: 'view',
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

    for (const tab of window.tabs) {
      const panes = flattenIterm2SplitTree(tab.root);
      const contentBounds = computeContentBounds(panes);
      if (contentBounds.width > windowFrame.width || contentBounds.height > windowFrame.height) {
        throw new Error(`window:${window.windowId}:tab:${tab.tabId} content bounds exceed window bounds`);
      }
      const contentTopInsetPx = windowFrame.height - contentBounds.height;
      for (const pane of panes) {
        const tmuxTarget = pane.tty ? tmuxTargets.get(pane.tty) : undefined;
        const cropRectTopLeftPx = {
          x: windowFrame.x + pane.frame.x,
          y: windowFrame.y + contentTopInsetPx + pane.frame.y,
          width: pane.frame.width,
          height: pane.frame.height,
        };
        assertPaneCropWithinWindow(
          windowFrame,
          cropRectTopLeftPx,
          `window:${window.windowId}:tab:${tab.tabId}:pane:${pane.sessionId}`,
        );
        targets.push({
          streamTargetId: `iterm2-pane:${window.windowId}:${tab.tabId}:${pane.sessionId}`,
          videoTarget: {
            kind: 'iterm2-pane',
            appBundleId: ITERM2_APP_BUNDLE_ID,
            pid: window.pid || 0,
            windowId: window.windowId,
            title: pane.title || window.title || 'iTerm2 pane',
            windowBoundsTopLeftPx: windowFrame,
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
            scale: 1,
            createdAt: now,
          },
        });
      }
    }
  }

  return targets;
}

export function buildMacosAppWindowTargets(
  catalog: MacosAppWindowCatalog,
  now: string,
): RemoteWindowStreamTargetManifest[] {
  return catalog.windows.map((window) => {
    const windowFrame = validateRect(window.frame, `app-window:${window.windowId}`);
    return {
      streamTargetId: `app-window:${window.pid}:${window.windowId}`,
      videoTarget: {
        kind: 'app-window',
        appBundleId: window.appBundleId,
        pid: window.pid,
        windowId: window.windowId,
        title: window.title || window.ownerName || window.appBundleId || `Window ${window.windowId}`,
        windowBoundsTopLeftPx: windowFrame,
        cropRectTopLeftPx: windowFrame,
      },
      inputTarget: {
        kind: 'app-window',
      },
      streamMode: 'view',
      focusPolicy: 'bring-to-focus',
      inputRoute: 'os-event',
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: now,
      },
    };
  });
}

function runDefaultIterm2Python(
  script: string,
  options: { pythonBinary: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(options.pythonBinary, ['-c', script], {
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = [error.message, stderr, stdout].filter(Boolean).join('\n');
        reject(new Error(details || 'iTerm2 Python API failed'));
        return;
      }
      resolve(stdout);
    });
  });
}

function runDefaultMacosAppWindowCatalog(
  script: string,
  options: { swiftBinary: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(options.swiftBinary, ['-e', script], {
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = [error.message, stderr, stdout].filter(Boolean).join('\n');
        reject(new Error(details || 'macOS app window catalog failed'));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseIterm2Catalog(stdout: string): Iterm2RawCatalog {
  const parsed = JSON.parse(stdout) as Iterm2RawCatalog;
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error('iTerm2 catalog missing windows');
  }
  return parsed;
}

function parseMacosAppWindowCatalog(stdout: string): MacosAppWindowCatalog {
  const parsed = JSON.parse(stdout) as MacosAppWindowCatalog;
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error('macOS app window catalog missing windows');
  }
  return parsed;
}

export function createRemoteWindowStreamDaemonRuntime(
  deps: RemoteWindowStreamDaemonDeps,
): RemoteWindowStreamDaemonRuntime {
  const platform = deps.platform || process.platform;
  const pythonBinary = (deps.pythonBinary || process.env.ZTERM_ITERM2_PYTHON || 'python3').trim();
  const swiftBinary = (deps.swiftBinary || process.env.ZTERM_MACOS_SWIFT || 'swift').trim();
  const iterm2PythonTimeoutMs = deps.iterm2PythonTimeoutMs || DEFAULT_ITERM2_PYTHON_TIMEOUT_MS;
  const appWindowCatalogTimeoutMs = deps.appWindowCatalogTimeoutMs || DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS;
  const runIterm2Python = deps.runIterm2Python || runDefaultIterm2Python;
  const runMacosAppWindowCatalog = deps.runMacosAppWindowCatalog || runDefaultMacosAppWindowCatalog;
  const now = deps.now || (() => new Date().toISOString());

  async function queryIterm2Catalog() {
    const stdout = await runIterm2Python(ITERM2_CATALOG_PYTHON, {
      pythonBinary,
      timeoutMs: iterm2PythonTimeoutMs,
    });
    return parseIterm2Catalog(stdout);
  }

  async function queryMacosAppWindowCatalog() {
    const stdout = await runMacosAppWindowCatalog(MACOS_APP_WINDOW_CATALOG_SWIFT, {
      swiftBinary,
      timeoutMs: appWindowCatalogTimeoutMs,
    });
    return parseMacosAppWindowCatalog(stdout);
  }

  async function listTargets(
    payload: RemoteWindowStreamRequestPayload,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId) {
      return remoteWindowError(payload, 'remote_window_request_invalid', 'remote window target request requires requestId');
    }
    if (platform !== 'darwin') {
      return remoteWindowError(payload, 'remote_window_platform_unsupported', 'remote window stream catalog is only available on macOS daemon hosts');
    }
    const createdAt = now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets: RemoteWindowStreamTargetManifest[] = [];
    const errors: RemoteWindowStreamErrorPayload[] = [];

    let macosAppWindowCatalogOk = false;
    if (includeAppWindows) {
      try {
        const appWindowCatalog = await queryMacosAppWindowCatalog();
        targets.push(...buildMacosAppWindowTargets(appWindowCatalog, createdAt));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
      }
    }

    let catalog: Iterm2RawCatalog | null = null;
    if (includeIterm2) {
      try {
        catalog = await queryIterm2Catalog();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(remoteWindowError(payload, 'iterm2_api_unavailable', message || 'iTerm2 Python API unavailable'));
      }
    }

    let tmuxTargets = new Map<string, TmuxClientTarget>();
    if (catalog) {
      try {
        tmuxTargets = parseTmuxClientTargets(deps.runTmux([
          'list-clients',
          '-F',
          '#{client_tty}\t#{session_name}\t#{window_id}\t#{pane_id}',
        ]).stdout);
      } catch {
        tmuxTargets = new Map<string, TmuxClientTarget>();
      }
    }

    if (catalog) {
      try {
        targets.push(...buildRemoteWindowStreamTargets(catalog, tmuxTargets, createdAt, {
          includeAppWindowTargets: includeAppWindows && !macosAppWindowCatalogOk,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(remoteWindowError(payload, 'remote_window_manifest_invalid', message || 'remote window target manifest invalid'));
      }
    }

    if (targets.length > 0) {
      return {
        requestId: payload.requestId,
        targets,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }
    return errors[0] || {
      requestId: payload.requestId,
      targets: [],
    };
  }

  return {
    listTargets,
  };
}

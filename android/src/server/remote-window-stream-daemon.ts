import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import wrtc from '@roamhq/wrtc';
import type {
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowInputEventPayload,
  RemoteWindowInputResultPayload,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRect,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamStartRequestPayload,
  RemoteWindowStreamStatusPayload,
  RemoteWindowStreamStopRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
} from '@zterm/shared/protocol';

const DEFAULT_ITERM2_PYTHON_TIMEOUT_MS = 5000;
const DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS = 15000;
const DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS = 20000;
const DEFAULT_REMOTE_WINDOW_FRAME_RATE = 30;
const DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS = 60_000;
const REMOTE_WINDOW_INPUT_STALE_MS = 1_000;
const REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS = 3_000;
const REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS = 15_000;
const ITERM2_APP_BUNDLE_ID = 'com.googlecode.iterm2';
const ITERM2_PANE_GAP_PX = 1;
const REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS = 220;
const REMOTE_WINDOW_CAPTURE_FRAME_MAGIC = Buffer.from('ZRW1');

type RtcPeerConnectionCtor = typeof globalThis.RTCPeerConnection;
type RtcSessionDescriptionCtor = typeof globalThis.RTCSessionDescription;
type RtcIceCandidateCtor = typeof globalThis.RTCIceCandidate;

interface RtcVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

interface RtcVideoSourceLike {
  createTrack(): MediaStreamTrack;
  onFrame(frame: RtcVideoFrame): void;
}

const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  nonstandard,
} = wrtc as unknown as {
  RTCPeerConnection: RtcPeerConnectionCtor;
  RTCSessionDescription: RtcSessionDescriptionCtor;
  RTCIceCandidate: RtcIceCandidateCtor;
  nonstandard: {
    RTCVideoSource: { new (init?: { isScreencast?: boolean; needsDenoising?: boolean }): RtcVideoSourceLike };
    rgbaToI420: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void;
  };
};

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
  displayId?: string;
  displayBoundsTopLeftPx?: RemoteWindowStreamRect;
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
  targetCatalogCacheTtlMs?: number;
  nowMs?: () => number;
  warmTargetCatalogOnStart?: boolean;
  captureStartupTimeoutMs?: number;
  frameRate?: number;
  runIterm2Python?: (script: string, options: { pythonBinary: string; timeoutMs: number }) => Promise<string>;
  runMacosAppWindowCatalog?: (script: string, options: { swiftBinary: string; timeoutMs: number }) => Promise<string>;
  remoteWindowInputHelperFactory?: (options: { swiftBinary: string }) => RemoteWindowInputHelper;
  captureSourceFactory?: RemoteWindowCaptureSourceFactory;
  runRemoteWindowInputEvent?: RemoteWindowInputEventRunner;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  rtcSessionDescriptionFactory?: (description: RTCSessionDescriptionInit) => RTCSessionDescription;
  rtcIceCandidateFactory?: (candidate: RTCIceCandidateInit) => RTCIceCandidate;
  videoSourceFactory?: () => RtcVideoSourceLike;
  rgbaToI420?: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void;
  runTmux: (args: string[]) => { ok: true; stdout: string };
}

export interface RemoteWindowStreamDaemonRuntime {
  listTargets: (
    payload: RemoteWindowStreamRequestPayload,
  ) => Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>;
  startStream: (
    payload: RemoteWindowStreamStartRequestPayload,
    handlers?: RemoteWindowStreamDaemonHandlers,
  ) => Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamErrorPayload>;
  addIceCandidate: (payload: RemoteWindowStreamIceCandidatePayload) => Promise<boolean>;
  stopStream: (
    payload: RemoteWindowStreamStopRequestPayload,
  ) => Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload>;
  updateStreamQuality: (
    payload: RemoteWindowStreamQualityRequestPayload,
  ) => Promise<RemoteWindowStreamQualityResultPayload | RemoteWindowStreamErrorPayload>;
  injectInput: (
    payload: RemoteWindowInputEventPayload,
  ) => Promise<RemoteWindowInputResultPayload | RemoteWindowStreamErrorPayload>;
  dispose: (reason?: string) => void;
}

interface RemoteWindowTargetCatalogCacheEntry {
  updatedAtMs: number;
  response: RemoteWindowStreamTargetsResponsePayload;
}

export function buildRemoteWindowImagePasteInputPayloads(options: {
  requestPrefix: string;
  streamId: string;
  targetId: string;
  now?: () => number;
}): RemoteWindowInputEventPayload[] {
  const now = options.now ?? Date.now;
  return [
    {
      requestId: `${options.requestPrefix}-0`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: 'key',
        phase: 'down',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    },
    {
      requestId: `${options.requestPrefix}-1`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: 'key',
        phase: 'up',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    },
  ];
}

export interface RemoteWindowStreamDaemonHandlers {
  sendIceCandidate?: (payload: RemoteWindowStreamIceCandidatePayload) => void;
  sendStatus?: (payload: RemoteWindowStreamStatusPayload) => void;
}

export interface RemoteWindowCaptureFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface RemoteWindowCaptureFrameSource {
  width: number;
  height: number;
  frameRate: number;
  stop: () => void;
}

export type RemoteWindowCaptureSourceFactory = (
  target: RemoteWindowStreamTargetManifest,
  options: {
    frameRate: number;
    startupTimeoutMs: number;
    swiftBinary: string;
    onFrame: (frame: RemoteWindowCaptureFrame) => void;
    onError: (error: Error) => void;
  },
) => Promise<RemoteWindowCaptureFrameSource>;

export type RemoteWindowInputEventRunner = (
  payload: RemoteWindowInputEventPayload,
  target: RemoteWindowStreamTargetManifest,
  options: {
    swiftBinary: string;
    runTmux: (args: string[]) => { ok: true; stdout: string };
    daemonReceivedAtMs: number;
  },
) => Promise<void>;

export interface RemoteWindowInputConfig {
  daemonReceivedAtMs: number;
  clientSentAt?: number;
  pid: number;
  appBundleId: string;
  focusPolicy: RemoteWindowStreamTargetManifest['focusPolicy'];
  window: {
    windowId: string;
    title: string;
    bounds: RemoteWindowStreamRect;
  };
  event: RemoteWindowInputEventPayload['event'];
}

export interface RemoteWindowInputHelper {
  warm: () => Promise<void>;
  send: (config: RemoteWindowInputConfig) => Promise<void>;
  dispose: () => void;
}

interface ActiveRemoteWindowStream {
  streamId: string;
  requestId: string;
  targetId: string;
  target: RemoteWindowStreamTargetManifest;
  peerConnection: RTCPeerConnection;
  videoSender: RTCRtpSender | null;
  videoSource: RtcVideoSourceLike;
  videoTrack: MediaStreamTrack;
  videoBitrate: RemoteWindowVideoBitrateConfig | null;
  captureSource: RemoteWindowCaptureFrameSource | null;
  handlers: RemoteWindowStreamDaemonHandlers;
  framesSent: number;
  pendingVideoFrame: {
    frame: RemoteWindowCaptureFrame;
  } | null;
  cleanupDone: boolean;
}

type RemoteWindowCaptureChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

type RemoteWindowInputHelperChildProcess = ChildProcessWithoutNullStreams & {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

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

func rectDict(_ rect: CGRect) -> [String: Any] {
    return [
        "x": Int(rect.origin.x.rounded()),
        "y": Int(rect.origin.y.rounded()),
        "width": Int(rect.size.width.rounded()),
        "height": Int(rect.size.height.rounded()),
    ]
}

func activeDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else {
        return []
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &displays, &count)
    return Array(displays.prefix(Int(count)))
}

func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> Double {
    let intersection = lhs.intersection(rhs)
    if intersection.isNull || intersection.isEmpty {
        return 0
    }
    return Double(max(0, intersection.width)) * Double(max(0, intersection.height))
}

func bestDisplay(for frame: CGRect) -> (id: CGDirectDisplayID, bounds: CGRect)? {
    var best: (id: CGDirectDisplayID, bounds: CGRect, area: Double)? = nil
    for displayId in activeDisplays() {
        let bounds = CGDisplayBounds(displayId)
        let area = intersectionArea(frame, bounds)
        guard area > 0 else {
            continue
        }
        if best == nil || area > best!.area {
            best = (displayId, bounds, area)
        }
    }
    return best.map { ($0.id, $0.bounds) }
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
    let frameRect = CGRect(x: x, y: y, width: width, height: height)
    var windowEntry: [String: Any] = [
        "windowId": windowId,
        "ownerName": ownerName,
        "appBundleId": appBundleId,
        "pid": pid,
        "title": title,
        "frame": rectDict(frameRect),
    ]
    if let display = bestDisplay(for: frameRect) {
        windowEntry["displayId"] = String(display.id)
        windowEntry["displayBoundsTopLeftPx"] = rectDict(display.bounds)
    }
    windows.append(windowEntry)
}

let data = try JSONSerialization.data(withJSONObject: ["windows": windows], options: [])
FileHandle.standardOutput.write(data)
`;

export const MACOS_REMOTE_WINDOW_INPUT_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

struct InputConfig: Decodable {
    let pid: Int32
    let appBundleId: String
    let focusPolicy: String
    let window: RemoteInputWindow
    let event: RemoteInputEvent
}

struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct RemoteInputWindow: Decodable {
    let windowId: String
    let title: String
    let bounds: Rect
}

struct RemoteInputEvent: Decodable {
    let kind: String
    let gesture: String?
    let phase: String?
    let button: String?
    let buttons: Int?
    let pointerId: Int?
    let startX: Double?
    let startY: Double?
    let x: Double?
    let y: Double?
    let startNormalizedX: Double?
    let startNormalizedY: Double?
    let normalizedX: Double?
    let normalizedY: Double?
    let unit: String?
    let deltaX: Double?
    let deltaY: Double?
    let durationMs: Double?
    let velocityX: Double?
    let velocityY: Double?
    let width: Double?
    let height: Double?
    let key: String?
    let code: String?
    let text: String?
    let shiftKey: Bool?
    let altKey: Bool?
    let ctrlKey: Bool?
    let metaKey: Bool?
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

func inputError(_ message: String, code: Int = 1) -> NSError {
    return NSError(domain: "RemoteWindowInput", code: code, userInfo: [NSLocalizedDescriptionKey: message])
}

func closeEnough(_ lhs: Double, _ rhs: Double, tolerance: Double = 8.0) -> Bool {
    return abs(lhs - rhs) <= tolerance
}

func copyAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success {
        return nil
    }
    return value as AnyObject?
}

func rectScore(_ position: CGPoint, _ size: CGSize, _ bounds: Rect) -> Double {
    return abs(position.x - bounds.x)
        + abs(position.y - bounds.y)
        + abs(size.width - bounds.width)
        + abs(size.height - bounds.height)
}

func axPoint(_ value: AnyObject?) -> CGPoint? {
    guard let value = value else { return nil }
    let axValue = value as! AXValue
    var point = CGPoint.zero
    if AXValueGetType(axValue) != .cgPoint {
        return nil
    }
    AXValueGetValue(axValue, .cgPoint, &point)
    return point
}

func axSize(_ value: AnyObject?) -> CGSize? {
    guard let value = value else { return nil }
    let axValue = value as! AXValue
    var size = CGSize.zero
    if AXValueGetType(axValue) != .cgSize {
        return nil
    }
    AXValueGetValue(axValue, .cgSize, &size)
    return size
}

func frontmostPidMatches(_ pid: Int32) -> Bool {
    guard let frontmost = NSWorkspace.shared.frontmostApplication else {
        return false
    }
    return frontmost.processIdentifier == pid
}

func waitForRunningApplication(_ pid: Int32) -> NSRunningApplication? {
    for attempt in 0..<6 {
        if let app = NSRunningApplication(processIdentifier: pid) {
            return app
        }
        if attempt < 5 {
            usleep(50000)
        }
    }
    return nil
}

func axWindowMatchesBounds(_ window: AXUIElement, _ bounds: Rect) -> Bool {
    guard
        let position = axPoint(copyAttribute(window, kAXPositionAttribute)),
        let size = axSize(copyAttribute(window, kAXSizeAttribute))
    else {
        return false
    }
    return rectScore(position, size, bounds) <= 96.0
}

func focusedWindowMatchesTarget(_ appElement: AXUIElement, _ bounds: Rect) -> Bool {
    guard let focusedWindow = copyAttribute(appElement, kAXFocusedWindowAttribute) else {
        return false
    }
    let focusedElement = focusedWindow as! AXUIElement
    return axWindowMatchesBounds(focusedElement, bounds)
}

func activateTargetApplication(_ config: InputConfig, _ app: NSRunningApplication) {
    app.unhide()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        "-e",
        "tell application \"System Events\" to set frontmost of first process whose unix id is " + String(config.pid) + " to true"
    ]
    try? process.run()
    process.waitUntilExit()
}

func focusTargetWindow(_ config: InputConfig) throws {
    guard config.focusPolicy == "bring-to-focus" else {
        return
    }
    guard AXIsProcessTrusted() else {
        throw NSError(domain: "RemoteWindowInput", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS Accessibility permission is required for remote window input"])
    }
    guard let app = waitForRunningApplication(config.pid) else {
        throw NSError(domain: "RemoteWindowInput", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote input target app is not running pid=" + String(config.pid)])
    }
    let appElement = AXUIElementCreateApplication(config.pid)
    if frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, config.window.bounds) {
        return
    }
    let windows = copyAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var bestWindow: AXUIElement?
    var bestScore = Double.greatestFiniteMagnitude
    for window in windows {
        guard
            let position = axPoint(copyAttribute(window, kAXPositionAttribute)),
            let size = axSize(copyAttribute(window, kAXSizeAttribute))
        else {
            continue
        }
        let score = rectScore(position, size, config.window.bounds)
        if score < bestScore {
            bestScore = score
            bestWindow = window
        }
    }
    guard let window = bestWindow, bestScore <= 96.0 else {
        throw NSError(domain: "RemoteWindowInput", code: 4, userInfo: [NSLocalizedDescriptionKey: "remote input target window could not be matched for focus"])
    }
	    var isFrontmost = false
	    var isFocused = false
	    for attempt in 0..<3 {
	        activateTargetApplication(config, app)
	        AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
	        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
	        AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
	        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
	        AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	        AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
	        usleep(attempt == 0 ? 120000 : 180000)
        isFrontmost = frontmostPidMatches(config.pid)
        isFocused = focusedWindowMatchesTarget(appElement, config.window.bounds)
        if isFrontmost && isFocused {
            return
        }
    }
    if !isFrontmost {
        throw NSError(domain: "RemoteWindowInput", code: 5, userInfo: [NSLocalizedDescriptionKey: "remote input target app did not become frontmost"])
    }
    if !isFocused {
        throw NSError(domain: "RemoteWindowInput", code: 6, userInfo: [NSLocalizedDescriptionKey: "remote input target window did not become focused"])
    }
}

func findTargetWindow(_ config: InputConfig) throws -> AXUIElement {
    guard AXIsProcessTrusted() else {
        throw NSError(domain: "RemoteWindowInput", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS Accessibility permission is required for remote window input"])
    }
    guard waitForRunningApplication(config.pid) != nil else {
        throw NSError(domain: "RemoteWindowInput", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote input target app is not running pid=" + String(config.pid)])
    }
    let appElement = AXUIElementCreateApplication(config.pid)
    let windows = copyAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var bestWindow: AXUIElement?
    var bestScore = Double.greatestFiniteMagnitude
    for window in windows {
        guard
            let position = axPoint(copyAttribute(window, kAXPositionAttribute)),
            let size = axSize(copyAttribute(window, kAXSizeAttribute))
        else {
            continue
        }
        let score = rectScore(position, size, config.window.bounds)
        if score < bestScore {
            bestScore = score
            bestWindow = window
        }
    }
    guard let window = bestWindow, bestScore <= 96.0 else {
        throw NSError(domain: "RemoteWindowInput", code: 4, userInfo: [NSLocalizedDescriptionKey: "remote input target window could not be matched"])
    }
    return window
}

func resizeTargetWindow(_ config: InputConfig) throws {
    guard
        let width = config.event.width,
        let height = config.event.height,
        width >= 120,
        height >= 120
    else {
        throw inputError("remote window resize dimensions are invalid")
    }
    let window = try findTargetWindow(config)
    var size = CGSize(width: width, height: height)
    guard let sizeValue = AXValueCreate(.cgSize, &size) else {
        throw inputError("remote window resize size value could not be created")
    }
    let result = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
    if result != .success {
        throw inputError("remote window resize failed")
    }
}

let source = CGEventSource(stateID: .hidSystemState)

func flags(_ event: RemoteInputEvent) -> CGEventFlags {
    var result = CGEventFlags()
    if event.shiftKey == true { result.insert(.maskShift) }
    if event.altKey == true { result.insert(.maskAlternate) }
    if event.ctrlKey == true { result.insert(.maskControl) }
    if event.metaKey == true { result.insert(.maskCommand) }
    return result
}

func mouseButton(_ button: String?) -> CGMouseButton {
    switch button {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func mouseType(phase: String, button: String?, buttons: Int?) -> CGEventType {
    let right = button == "right"
    let middle = button == "middle"
    if phase == "down" { return right ? .rightMouseDown : .leftMouseDown }
    if phase == "up" { return right ? .rightMouseUp : .leftMouseUp }
    if phase == "move" && (buttons ?? 0) > 0 {
        if right { return .rightMouseDragged }
        if middle { return .otherMouseDragged }
        return .leftMouseDragged
    }
    return .mouseMoved
}

func postMouseMove(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    let event = CGEvent(
        mouseEventSource: source,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    )
    event?.post(tap: .cghidEventTap)
}

func postScrollEvent(x: Double, y: Double, deltaX: Double, deltaY: Double, unit: String?) {
    let units: CGScrollEventUnit = unit == "pixel" ? .pixel : .line
    let point = CGPoint(x: x, y: y)
    postMouseMove(x: x, y: y)
    // Android/DOM deltas use positive values for scrolling down/right; CGEvent
    // wheel values use the opposite sign for pixel scroll injection.
    let wheel1 = Int32(max(-32767, min(32767, (-deltaY).rounded())))
    let wheel2 = Int32(max(-32767, min(32767, (-deltaX).rounded())))
    let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: units,
        wheelCount: 2,
        wheel1: wheel1,
        wheel2: wheel2,
        wheel3: 0
    )
    event?.location = point
    event?.post(tap: .cghidEventTap)
}

let REMOTE_GESTURE_REPLAY_MAX_STEP_PX = 120.0
let REMOTE_GESTURE_REPLAY_MAX_STEPS = 12

func boundedGestureReplayStepCount(deltaX: Double, deltaY: Double) -> Int {
    let magnitude = max(abs(deltaX), abs(deltaY))
    if magnitude <= REMOTE_GESTURE_REPLAY_MAX_STEP_PX {
        return 1
    }
    return max(1, min(REMOTE_GESTURE_REPLAY_MAX_STEPS, Int(ceil(magnitude / REMOTE_GESTURE_REPLAY_MAX_STEP_PX))))
}

func postGestureSwipeScrollEvent(
    startX: Double,
    startY: Double,
    x: Double,
    y: Double,
    deltaX: Double,
    deltaY: Double,
    unit: String?
) {
    let stepCount = boundedGestureReplayStepCount(deltaX: deltaX, deltaY: deltaY)
    let stepDeltaX = deltaX / Double(stepCount)
    let stepDeltaY = deltaY / Double(stepCount)
    for step in 0..<stepCount {
        let progress = Double(step + 1) / Double(stepCount)
        let stepX = startX + (x - startX) * progress
        let stepY = startY + (y - startY) * progress
        postScrollEvent(x: stepX, y: stepY, deltaX: stepDeltaX, deltaY: stepDeltaY, unit: unit)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "Enter": 36,
    "NumpadEnter": 76,
    "Escape": 53,
    "Backspace": 51,
    "Tab": 48,
    "Space": 49,
    "ArrowLeft": 123,
    "ArrowRight": 124,
    "ArrowDown": 125,
    "ArrowUp": 126,
    "KeyV": 9,
    "Delete": 117,
    "Home": 115,
    "End": 119,
    "PageUp": 116,
    "PageDown": 121,
]

func handleConfig(_ config: InputConfig) throws {
    if config.event.kind == "window-resize" {
        try resizeTargetWindow(config)
        return
    }
    try focusTargetWindow(config)

    if config.event.kind == "focus" {
        return
    } else if config.event.kind == "pointer" {
        guard let phase = config.event.phase else {
            throw inputError("remote pointer input missing phase")
        }
        guard let x = config.event.x, let y = config.event.y else {
            throw inputError("remote pointer input missing coordinates")
        }
        let point = CGPoint(x: x, y: y)
        let event = CGEvent(
            mouseEventSource: source,
            mouseType: mouseType(phase: phase, button: config.event.button, buttons: config.event.buttons),
            mouseCursorPosition: point,
            mouseButton: mouseButton(config.event.button)
        )
        event?.post(tap: .cghidEventTap)
    } else if config.event.kind == "scroll" {
        guard
            let x = config.event.x,
            let y = config.event.y,
            let deltaX = config.event.deltaX,
            let deltaY = config.event.deltaY
        else {
            throw inputError("remote scroll input missing delta or coordinates")
        }
        postScrollEvent(x: x, y: y, deltaX: deltaX, deltaY: deltaY, unit: config.event.unit)
    } else if config.event.kind == "gesture" {
        guard config.event.gesture == "swipe", config.event.phase == "end" else {
            throw inputError("remote gesture input unsupported")
        }
        guard
            let startX = config.event.startX,
            let startY = config.event.startY,
            let x = config.event.x,
            let y = config.event.y,
            let deltaX = config.event.deltaX,
            let deltaY = config.event.deltaY
        else {
            throw inputError("remote gesture input missing delta or coordinates")
        }
        postGestureSwipeScrollEvent(
            startX: startX,
            startY: startY,
            x: x,
            y: y,
            deltaX: deltaX,
            deltaY: deltaY,
            unit: config.event.unit
        )
    } else if config.event.kind == "key" {
        guard let phase = config.event.phase else {
            throw inputError("remote key input missing phase")
        }
        let down = phase == "down"
        let code = config.event.code ?? ""
        if let keyCode = keyCodes[code] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
            event?.flags = flags(config.event)
            event?.post(tap: .cghidEventTap)
        } else if !(config.event.text ?? config.event.key ?? "").isEmpty {
            var utf16 = (config.event.text ?? config.event.key ?? "").utf16.map { UniChar($0) }
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            event?.flags = flags(config.event)
            event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            event?.post(tap: .cghidEventTap)
        } else {
            throw inputError("remote key input unsupported: \(code)")
        }
    } else {
        throw inputError("remote input event kind unsupported")
    }
}

func writeResult(ok: Bool, error: String? = nil) {
    var result: [String: Any] = ["ok": ok]
    if let error = error {
        result["error"] = error
    }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

@discardableResult
func handleRawConfig(_ rawConfig: String, exitOnFailure: Bool) -> Bool {
    do {
        guard let data = rawConfig.data(using: .utf8) else {
            throw inputError("remote input config is not utf8")
        }
        let config = try JSONDecoder().decode(InputConfig.self, from: data)
        try handleConfig(config)
        writeResult(ok: true)
        return true
    } catch {
        writeResult(ok: false, error: error.localizedDescription)
        if exitOnFailure {
            exit(2)
        }
        return false
    }
}

func writeReady() {
    print("{\"ready\":true}")
    fflush(stdout)
}

if let rawConfig = ProcessInfo.processInfo.environment["ZTERM_REMOTE_WINDOW_INPUT_CONFIG"] {
    handleRawConfig(rawConfig, exitOnFailure: true)
} else {
    writeReady()
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            continue
        }
        handleRawConfig(line, exitOnFailure: false)
    }
}
`;

export const SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT = String.raw`
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct CaptureConfig: Decodable {
    let windowId: String
    let appBundleId: String
    let title: String
    let windowBounds: Rect
    let cropRect: Rect
    let frameRate: Int
    let queueDepth: Int
}

struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func stderrLine(_ message: String) {
    if let data = (message + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func appendUInt32(_ value: UInt32, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { bytes in
        data.append(contentsOf: bytes)
    }
}

func closeEnough(_ lhs: Double, _ rhs: Double) -> Bool {
    return abs(lhs - rhs) <= 4.0
}

func rectMatches(_ frame: CGRect, _ rect: Rect) -> Bool {
    return closeEnough(frame.origin.x, rect.x)
        && closeEnough(frame.origin.y, rect.y)
        && closeEnough(frame.size.width, rect.width)
        && closeEnough(frame.size.height, rect.height)
}

final class FrameOutput: NSObject, SCStreamOutput {
    private var emitted = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else {
            return
        }
        guard sampleBuffer.isValid, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0, let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return
        }

        let source = baseAddress.assumingMemoryBound(to: UInt8.self)
        var rgba = Data(count: width * height * 4)
        rgba.withUnsafeMutableBytes { destinationRaw in
            guard let destinationBase = destinationRaw.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return
            }
            for y in 0..<height {
                let sourceRow = source.advanced(by: y * bytesPerRow)
                let destinationRow = destinationBase.advanced(by: y * width * 4)
                for x in 0..<width {
                    let sourcePixel = sourceRow.advanced(by: x * 4)
                    let destinationPixel = destinationRow.advanced(by: x * 4)
                    destinationPixel[0] = sourcePixel[2]
                    destinationPixel[1] = sourcePixel[1]
                    destinationPixel[2] = sourcePixel[0]
                    destinationPixel[3] = sourcePixel[3]
                }
            }
        }

        var header = Data()
        header.append(contentsOf: [0x5A, 0x52, 0x57, 0x31])
        appendUInt32(UInt32(width), to: &header)
        appendUInt32(UInt32(height), to: &header)
        appendUInt32(UInt32(rgba.count), to: &header)
        FileHandle.standardOutput.write(header)
        FileHandle.standardOutput.write(rgba)
        emitted += 1
    }
}

let env = ProcessInfo.processInfo.environment
guard let configJson = env["ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG"],
      let configData = configJson.data(using: .utf8) else {
    stderrLine("missing ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG")
    exit(2)
}

let config: CaptureConfig
do {
    config = try JSONDecoder().decode(CaptureConfig.self, from: configData)
} catch {
    stderrLine("invalid capture config: " + String(describing: error))
    exit(2)
}

NSApplication.shared
let output = FrameOutput()
let sampleQueue = DispatchQueue(label: "zterm.remote-window.capture.sample")
var activeStream: SCStream?

Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let numericWindowId = UInt32(config.windowId)
        let window = content.windows.first { candidate in
            if let numericWindowId = numericWindowId, candidate.windowID == numericWindowId {
                return true
            }
            if !config.appBundleId.isEmpty && candidate.owningApplication?.bundleIdentifier != config.appBundleId {
                return false
            }
            return rectMatches(candidate.frame, config.windowBounds)
        }
        guard let targetWindow = window else {
            stderrLine("ScreenCaptureKit window not found for " + config.windowId)
            exit(3)
        }

        let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.capturesAudio = false
        streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfiguration.queueDepth = max(3, min(3, config.queueDepth))
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, config.frameRate)))
        streamConfiguration.width = max(1, Int(config.cropRect.width.rounded()))
        streamConfiguration.height = max(1, Int(config.cropRect.height.rounded()))
        streamConfiguration.sourceRect = CGRect(
            x: max(0, config.cropRect.x - config.windowBounds.x),
            y: max(0, config.cropRect.y - config.windowBounds.y),
            width: max(1, config.cropRect.width),
            height: max(1, config.cropRect.height)
        )

        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
        activeStream = stream
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        stderrLine("zterm remote window capture started")
    } catch {
        stderrLine("ScreenCaptureKit capture start failed: " + String(describing: error))
        exit(4)
    }
}

dispatchMain()
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

function buildRemoteWindowTargetCatalogCacheKey(payload: RemoteWindowStreamRequestPayload) {
  return [
    payload.includeAppWindows !== false ? 'app' : 'no-app',
    payload.includeIterm2 !== false ? 'iterm2' : 'no-iterm2',
  ].join('|');
}

function cloneRemoteWindowTargetCatalogResponse(
  response: RemoteWindowStreamTargetsResponsePayload,
  requestId: string,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId,
    targets: response.targets.slice(),
    ...(response.errors
      ? {
          errors: response.errors.map((error) => ({
            ...error,
            requestId,
          })),
        }
      : {}),
  };
}

function cloneRemoteWindowTargetCatalogResult(
  result: RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload,
  requestId: string,
) {
  if ('targets' in result) {
    return cloneRemoteWindowTargetCatalogResponse(result, requestId);
  }
  return {
    ...result,
    requestId,
  };
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateRemoteWindowErrorMessage(message: string) {
  const normalized = normalizeWhitespace(message);
  if (normalized.length <= REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS - 1).trimEnd()}...`;
}

function isExecFileTimeoutError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    message?: string;
  };
  return candidate.killed === true
    || candidate.signal === 'SIGTERM'
    || candidate.code === 'ETIMEDOUT'
    || /timed out|timeout/iu.test(candidate.message || '');
}

function formatInlineScriptExecFailure(
  error: Error,
  stdout: string,
  stderr: string,
  timeoutMs: number,
  timeoutMessage: string,
  fallbackMessage: string,
) {
  const timeoutDetail = isExecFileTimeoutError(error)
    ? `${timeoutMessage} after ${timeoutMs}ms`
    : '';
  return [stderr, stdout, timeoutDetail, error.message && !error.message.includes(' -c ') && !error.message.includes(' -e ') ? error.message : '']
    .filter(Boolean)
    .join('\n') || fallbackMessage;
}

export function buildScreenCaptureKitStartupTimeoutMessage(stderrBuffer: string, timeoutMs: number) {
  const stderrDetail = stderrBuffer
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return stderrDetail
    ? `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms: ${stderrDetail}`
    : `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms`;
}

export function summarizeRemoteWindowCatalogError(error: unknown, fallbackMessage: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const normalizedRaw = normalizeWhitespace(raw);
  const missingPythonModule = normalizedRaw.match(/No module named ['"]?([A-Za-z0-9_.-]+)['"]?/u);
  if (missingPythonModule?.[1]) {
    return `iTerm2 Python API unavailable: missing Python module ${missingPythonModule[1]}`;
  }

  const candidateLines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('Command failed:'));
  const diagnosticLine = [...candidateLines].reverse().find((line) =>
    /(?:error|exception|denied|permission|timeout|timed out|not found|unavailable|failed)/iu.test(line),
  ) || candidateLines[0] || normalizedRaw || fallbackMessage;
  return truncateRemoteWindowErrorMessage(diagnosticLine || fallbackMessage);
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
        reject(new Error(formatInlineScriptExecFailure(
          error,
          stdout,
          stderr,
          options.timeoutMs,
          'iTerm2 Python catalog timed out',
          'iTerm2 Python API failed',
        )));
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
        reject(new Error(formatInlineScriptExecFailure(
          error,
          stdout,
          stderr,
          options.timeoutMs,
          'macOS app window catalog timed out',
          'macOS app window catalog failed',
        )));
        return;
      }
      resolve(stdout);
    });
  });
}

interface PendingRemoteWindowInputHelperRequest {
  config: RemoteWindowInputConfig;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  refreshReceivedAtAfterFocusConfig: RemoteWindowInputConfig | null;
}

interface PendingRemoteWindowInputHelperWarm {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function isRemoteWindowFocusInputConfig(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return config.event.kind === 'focus';
}

export function resolveRemoteWindowInputHelperTimeoutMs(config: Pick<RemoteWindowInputConfig, 'event'>) {
  return isRemoteWindowFocusInputConfig(config)
    ? REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS
    : REMOTE_WINDOW_INPUT_STALE_MS;
}

function remoteWindowInputConfigsShareTarget(
  lhs: RemoteWindowInputConfig,
  rhs: RemoteWindowInputConfig,
) {
  return lhs.pid === rhs.pid
    && lhs.appBundleId === rhs.appBundleId
    && lhs.focusPolicy === rhs.focusPolicy
    && lhs.window.windowId === rhs.window.windowId;
}

export function shouldRefreshRemoteWindowQueuedInputAfterFocus(
  focusConfig: RemoteWindowInputConfig,
  queuedConfig: RemoteWindowInputConfig,
) {
  return isRemoteWindowFocusInputConfig(focusConfig)
    && !isRemoteWindowFocusInputConfig(queuedConfig)
    && remoteWindowInputConfigsShareTarget(focusConfig, queuedConfig);
}

type RemoteWindowInputHelperProcessFactory = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; env: NodeJS.ProcessEnv },
) => RemoteWindowInputHelperChildProcess;

export function createDefaultRemoteWindowInputHelper(options: {
  swiftBinary: string;
  processFactory?: RemoteWindowInputHelperProcessFactory;
}): RemoteWindowInputHelper {
  let child: RemoteWindowInputHelperChildProcess | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let active: PendingRemoteWindowInputHelperRequest | null = null;
  const queue: PendingRemoteWindowInputHelperRequest[] = [];
  const warmWaiters: PendingRemoteWindowInputHelperWarm[] = [];
  let disposed = false;
  let ready = false;
  let waitingForReadyPump = false;

  const stderrSummary = () => stderrBuffer.trim().slice(-REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS);

  const rejectWarmWaiters = (error: Error) => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };

  const resolveWarmWaiters = () => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  };

  const rejectIfStale = (request: PendingRemoteWindowInputHelperRequest) => {
    if (isRemoteWindowInputConfigStale(
      request.config,
      Date.now(),
      resolveRemoteWindowInputHelperTimeoutMs(request.config),
    )) {
      rejectRequest(request, new Error('remote window input stale'));
      return true;
    }
    return false;
  };

  const rejectRequest = (request: PendingRemoteWindowInputHelperRequest | null, error: Error) => {
    if (!request) {
      return;
    }
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    request.reject(error);
  };

  const rejectAll = (error: Error) => {
    rejectRequest(active, error);
    active = null;
    while (queue.length > 0) {
      rejectRequest(queue.shift() || null, error);
    }
  };

  const refreshQueueAfterSuccessfulFocus = (focusConfig: RemoteWindowInputConfig) => {
    if (!isRemoteWindowFocusInputConfig(focusConfig)) {
      return;
    }
    const receivedAtMs = Date.now();
    for (const request of queue) {
      if (
        request.refreshReceivedAtAfterFocusConfig === focusConfig
        && shouldRefreshRemoteWindowQueuedInputAfterFocus(focusConfig, request.config)
      ) {
        request.config.daemonReceivedAtMs = receivedAtMs;
        request.refreshReceivedAtAfterFocusConfig = null;
      }
    }
  };

  const startChild = () => {
    if (child && !child.killed) {
      return child;
    }
    stderrBuffer = '';
    stdoutBuffer = '';
    const createProcess = options.processFactory || ((command, args, spawnOptions) => (
      spawn(command, args, spawnOptions) as RemoteWindowInputHelperChildProcess
    ));
    const currentChild = createProcess(options.swiftBinary, ['-e', MACOS_REMOTE_WINDOW_INPUT_SWIFT], {
      windowsHide: true,
      env: process.env,
    });
    child = currentChild;
    ready = false;
    currentChild.stdout.setEncoding('utf8');
    currentChild.stderr.setEncoding('utf8');
    currentChild.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (rawLine) {
          try {
            const response = JSON.parse(rawLine) as { ok?: unknown; ready?: unknown; error?: unknown };
            if (response.ready === true) {
              ready = true;
              resolveWarmWaiters();
              pump();
              newlineIndex = stdoutBuffer.indexOf('\n');
              continue;
            }
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              if (response.ok === true) {
                refreshQueueAfterSuccessfulFocus(request.config);
                request.resolve();
              } else {
                request.reject(new Error(String(response.error || 'remote window input event failed')));
              }
              pump();
            }
          } catch (error) {
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              request.reject(error instanceof Error ? error : new Error('remote window input helper returned invalid JSON'));
              pump();
            }
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    currentChild.stderr.on('data', (chunk) => {
      stderrBuffer = (stderrBuffer + String(chunk)).slice(-4096);
    });
    currentChild.on('error', (error) => {
      const message = stderrSummary();
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      const wrapped = new Error(message ? `${error.message}\n${message}` : error.message);
      rejectWarmWaiters(wrapped);
      rejectAll(wrapped);
    });
    currentChild.on('exit', (code, signal) => {
      const message = [
        `remote window input helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        stderrSummary(),
      ].filter(Boolean).join('\n');
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      if (!disposed) {
        const error = new Error(message);
        rejectWarmWaiters(error);
        rejectAll(error);
      }
    });
    return currentChild;
  };

  const waitUntilReady = () => {
    if (disposed) {
      return Promise.reject(new Error('remote window input helper is disposed'));
    }
    const helperProcess = startChild();
    if (ready && child === helperProcess && !helperProcess.killed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PendingRemoteWindowInputHelperWarm = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = warmWaiters.indexOf(waiter);
          if (index >= 0) {
            warmWaiters.splice(index, 1);
          }
          const message = stderrSummary();
          const error = new Error(message
            ? `remote window input helper did not become ready before timeout: ${message}`
            : 'remote window input helper did not become ready before timeout');
          if (child === helperProcess && !helperProcess.killed) {
            child.kill('SIGTERM');
            child = null;
            ready = false;
          }
          reject(error);
        }, REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS),
      };
      warmWaiters.push(waiter);
    });
  };

  const startReadyPump = () => {
    if (waitingForReadyPump) {
      return;
    }
    waitingForReadyPump = true;
    waitUntilReady()
      .then(() => {
        waitingForReadyPump = false;
        pump();
      })
      .catch((error: Error) => {
        waitingForReadyPump = false;
        rejectAll(error);
      });
  };

  const pump = () => {
    if (disposed || active || queue.length === 0) {
      return;
    }
    const request = queue.shift();
    if (!request) {
      return;
    }
    if (rejectIfStale(request)) {
      pump();
      return;
    }
    const helperProcess = startChild();
    if (!ready) {
      queue.unshift(request);
      startReadyPump();
      return;
    }
    active = request;
    request.timeout = setTimeout(() => {
      if (active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, new Error('remote window input helper timed out'));
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      if (child === helperProcess) {
        child = null;
        ready = false;
      }
      pump();
    }, resolveRemoteWindowInputHelperTimeoutMs(request.config));
    helperProcess.stdin.write(`${JSON.stringify(request.config)}\n`, (error) => {
      if (!error || active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, error);
      pump();
    });
  };

  const findFocusConfigForQueuedInput = (config: RemoteWindowInputConfig) => {
    if (active && shouldRefreshRemoteWindowQueuedInputAfterFocus(active.config, config)) {
      return active.config;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queuedConfig = queue[index]!.config;
      if (!remoteWindowInputConfigsShareTarget(queuedConfig, config)) {
        continue;
      }
      return shouldRefreshRemoteWindowQueuedInputAfterFocus(queuedConfig, config)
        ? queuedConfig
        : null;
    }
    return null;
  };

  return {
    warm() {
      return waitUntilReady();
    },
    send(config) {
      if (disposed) {
        return Promise.reject(new Error('remote window input helper is disposed'));
      }
      return new Promise<void>((resolve, reject) => {
        queue.push({
          config,
          resolve,
          reject,
          timeout: null,
          refreshReceivedAtAfterFocusConfig: findFocusConfigForQueuedInput(config),
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      rejectWarmWaiters(new Error('remote window input helper disposed'));
      rejectAll(new Error('remote window input helper disposed'));
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      child = null;
      ready = false;
    },
  };
}

export function buildRemoteWindowInputConfig(
  payload: RemoteWindowInputEventPayload,
  target: RemoteWindowStreamTargetManifest,
  options: { daemonReceivedAtMs?: number } = {},
): RemoteWindowInputConfig {
  return {
    daemonReceivedAtMs: Number.isFinite(options.daemonReceivedAtMs)
      ? Number(options.daemonReceivedAtMs)
      : Date.now(),
    pid: target.videoTarget.pid,
    appBundleId: target.videoTarget.appBundleId,
    focusPolicy: target.focusPolicy,
    window: {
      windowId: target.videoTarget.windowId,
      title: target.videoTarget.title,
      bounds: target.videoTarget.windowBoundsTopLeftPx,
    },
    clientSentAt: payload.clientSentAt,
    event: payload.event,
  };
}

export function isRemoteWindowInputConfigStale(
  config: Pick<RemoteWindowInputConfig, 'daemonReceivedAtMs'>,
  nowMs = Date.now(),
  staleMs = REMOTE_WINDOW_INPUT_STALE_MS,
) {
  if (!Number.isFinite(config.daemonReceivedAtMs)) {
    return true;
  }
  return nowMs - Number(config.daemonReceivedAtMs) > staleMs;
}

function normalizeRtcDescription(
  description: RTCSessionDescriptionInit | RTCSessionDescription | null,
  expectedType: RemoteWindowStreamRtcDescription['type'],
): RemoteWindowStreamRtcDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`remote window daemon expected ${expectedType} description`);
  }
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

function normalizeIceCandidate(candidate: RTCIceCandidate): RemoteWindowStreamIceCandidate {
  const candidateLike = typeof candidate.toJSON === 'function'
    ? candidate.toJSON()
    : candidate;
  return {
    candidate: String(candidateLike.candidate || ''),
    sdpMid: candidateLike.sdpMid ?? null,
    sdpMLineIndex: candidateLike.sdpMLineIndex ?? null,
    usernameFragment: candidateLike.usernameFragment ?? null,
  };
}

function normalizeRemoteWindowVideoBitrateConfig(
  input: RemoteWindowVideoBitrateConfig | undefined,
): RemoteWindowVideoBitrateConfig | null {
  if (!input) {
    return null;
  }
  const defaults = (() => {
    switch (input.preset) {
      case '2mbps':
        return { bitrateMbps: 2 as const, maxFrameRateFps: 30 as const };
      case '5mbps':
        return { bitrateMbps: 5 as const, maxFrameRateFps: 30 as const };
      case '10mbps':
        return { bitrateMbps: 10 as const, maxFrameRateFps: 30 as const };
      case '20mbps':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 30 as const };
      case 'fullscreen':
        return { bitrateMbps: 20 as const, maxFrameRateFps: 60 as const };
      default:
        throw new Error(`remote window video bitrate preset is invalid: ${String(input.preset)}`);
    }
  })();
  const bitrateMbps = defaults.bitrateMbps;
  const maxBitrateBps = bitrateMbps * 1_000_000;
  if (
    input.bitrateMbps !== bitrateMbps
    || !Number.isFinite(input.maxBitrateBps)
    || input.maxBitrateBps <= 0
    || input.maxBitrateBps > maxBitrateBps
  ) {
    throw new Error('remote window video bitrate config does not match its preset');
  }
  const maxFrameRateFps = input.maxFrameRateFps ?? defaults.maxFrameRateFps;
  if (
    !Number.isFinite(maxFrameRateFps)
    || maxFrameRateFps < 5
    || maxFrameRateFps > defaults.maxFrameRateFps
  ) {
    throw new Error('remote window video frame-rate config does not match its preset');
  }
  return {
    preset: input.preset,
    bitrateMbps,
    maxBitrateBps: Math.floor(input.maxBitrateBps),
    maxFrameRateFps,
  };
}

type RemoteWindowVideoBitrateApplyResult =
  | { applied: true; videoBitrate: RemoteWindowVideoBitrateConfig }
  | { applied: false; reason: string };

async function applyRemoteWindowVideoBitrate(
  sender: RTCRtpSender | null,
  config: RemoteWindowVideoBitrateConfig,
): Promise<RemoteWindowVideoBitrateApplyResult> {
  if (
    !sender
    || typeof sender.getParameters !== 'function'
    || typeof sender.setParameters !== 'function'
  ) {
    return {
      applied: false,
      reason: 'remote window video bitrate control is not available on this WebRTC sender',
    };
  }
  const currentParameters = sender.getParameters();
  const currentEncodings = Array.isArray(currentParameters.encodings)
    ? currentParameters.encodings
    : [];
  if (currentEncodings.length === 0) {
    return {
      applied: false,
      reason: 'remote window video bitrate sender has no encodings to update',
    };
  }
  const nextParameters = {
    ...currentParameters,
    encodings: currentEncodings.map((encoding) => ({
      ...encoding,
      maxBitrate: config.maxBitrateBps,
      maxFramerate: config.maxFrameRateFps,
    })),
  } as RTCRtpSendParameters;
  await sender.setParameters(nextParameters);
  return { applied: true, videoBitrate: config };
}

function formatRemoteWindowVideoBitrateError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name || 'remote window video bitrate could not be applied';
  }
  const message = String(error || '').trim();
  return message || 'remote window video bitrate could not be applied';
}

function addRemoteWindowVideoTrack(
  peerConnection: RTCPeerConnection,
  videoTrack: MediaStreamTrack,
) {
  return peerConnection.addTrack(videoTrack);
}

function validateStreamTargetForCapture(target: RemoteWindowStreamTargetManifest) {
  if (!target.streamTargetId.trim()) {
    throw new Error('remote window stream target id is required');
  }
  const windowBounds = validateRect(target.videoTarget.windowBoundsTopLeftPx, 'remote-window.windowBoundsTopLeftPx');
  const cropRect = target.videoTarget.cropRectTopLeftPx
    ? validateRect(target.videoTarget.cropRectTopLeftPx, 'remote-window.cropRectTopLeftPx')
    : null;
  if (!cropRect) {
    throw new Error('remote window stream target requires cropRectTopLeftPx');
  }
  if (cropRect.width <= 0 || cropRect.height <= 0) {
    throw new Error('remote window stream crop rectangle must be drawable');
  }
  assertPaneCropWithinWindow(windowBounds, cropRect, target.streamTargetId);
  return {
    windowBounds,
    cropRect,
  };
}

function convertRgbaToI420Frame(
  frame: RemoteWindowCaptureFrame,
  convert: (rgba: RtcVideoFrame, i420: RtcVideoFrame) => void,
): RtcVideoFrame {
  const width = Math.max(1, Math.floor(frame.width));
  const height = Math.max(1, Math.floor(frame.height));
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const i420 = {
    width,
    height,
    data: new Uint8Array(width * height + chromaWidth * chromaHeight * 2),
  };
  convert({
    width,
    height,
    data: frame.rgba,
  }, i420);
  return i420;
}

export function buildScreenCaptureKitConfig(target: RemoteWindowStreamTargetManifest, frameRate: number) {
  const { windowBounds, cropRect } = validateStreamTargetForCapture(target);
  return {
    windowId: target.videoTarget.windowId,
    appBundleId: target.videoTarget.appBundleId,
    title: target.videoTarget.title,
    windowBounds,
    cropRect,
    frameRate: Math.max(1, Math.floor(frameRate)),
    queueDepth: 3,
  };
}

function stopChildProcess(child: RemoteWindowCaptureChildProcess) {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
}

export function startScreenCaptureKitFrameSource(
  target: RemoteWindowStreamTargetManifest,
  options: {
    frameRate: number;
    startupTimeoutMs: number;
    swiftBinary: string;
    onFrame: (frame: RemoteWindowCaptureFrame) => void;
    onError: (error: Error) => void;
  },
): Promise<RemoteWindowCaptureFrameSource> {
  const captureConfig = buildScreenCaptureKitConfig(target, options.frameRate);
  const child = spawn(options.swiftBinary, ['-e', SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT], {
    env: {
      ...process.env,
      ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG: JSON.stringify(captureConfig),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as RemoteWindowCaptureChildProcess;
  child.stdin.end();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = '';
  let firstFrameResolved = false;
  let stopped = false;
  let frameWidth = Math.max(1, Math.floor(captureConfig.cropRect.width));
  let frameHeight = Math.max(1, Math.floor(captureConfig.cropRect.height));

  const cleanupListeners = () => {
    child.stdout.removeListener('data', onStdout);
    child.stderr.removeListener('data', onStderr);
    child.removeListener('error', onChildError);
    child.removeListener('exit', onChildExit);
  };

  const frameSource: RemoteWindowCaptureFrameSource = {
    get width() {
      return frameWidth;
    },
    get height() {
      return frameHeight;
    },
    frameRate: Math.max(1, Math.floor(options.frameRate)),
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      cleanupListeners();
      stopChildProcess(child);
    },
  };

  let resolveStart: (source: RemoteWindowCaptureFrameSource) => void = () => undefined;
  let rejectStart: (error: Error) => void = () => undefined;
  const startup = new Promise<RemoteWindowCaptureFrameSource>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });

  const startupTimer = setTimeout(() => {
    if (firstFrameResolved || stopped) {
      return;
    }
    frameSource.stop();
    rejectStart(new Error(buildScreenCaptureKitStartupTimeoutMessage(
      stderrBuffer,
      options.startupTimeoutMs,
    )));
  }, Math.max(1, options.startupTimeoutMs));

  function fail(error: Error) {
    if (!firstFrameResolved) {
      clearTimeout(startupTimer);
      frameSource.stop();
      rejectStart(error);
      return;
    }
    options.onError(error);
  }

  function emitFrame(width: number, height: number, rgba: Buffer) {
    frameWidth = width;
    frameHeight = height;
    const frame = {
      width,
      height,
      rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    };
    options.onFrame(frame);
    if (!firstFrameResolved) {
      firstFrameResolved = true;
      clearTimeout(startupTimer);
      resolveStart(frameSource);
    }
  }

  function onStdout(chunk: Buffer) {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (stdoutBuffer.length >= 16) {
      if (!stdoutBuffer.subarray(0, 4).equals(REMOTE_WINDOW_CAPTURE_FRAME_MAGIC)) {
        fail(new Error('ScreenCaptureKit frame stream header mismatch'));
        return;
      }
      const width = stdoutBuffer.readUInt32LE(4);
      const height = stdoutBuffer.readUInt32LE(8);
      const byteLength = stdoutBuffer.readUInt32LE(12);
      if (width === 0 || height === 0 || byteLength !== width * height * 4) {
        fail(new Error('ScreenCaptureKit frame stream emitted invalid frame dimensions'));
        return;
      }
      const packetLength = 16 + byteLength;
      if (stdoutBuffer.length < packetLength) {
        return;
      }
      const rgba = Buffer.from(stdoutBuffer.subarray(16, packetLength));
      stdoutBuffer = stdoutBuffer.subarray(packetLength);
      if (!stopped) {
        emitFrame(width, height, rgba);
      }
    }
  }

  function onStderr(chunk: Buffer) {
    stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`;
    stderrBuffer = stderrBuffer.slice(-1200);
  }

  function onChildError(error: Error) {
    fail(new Error(`ScreenCaptureKit capture process failed: ${error.message}`));
  }

  function onChildExit(code: number | null, signal: NodeJS.Signals | null) {
    if (stopped) {
      return;
    }
    const detail = truncateRemoteWindowErrorMessage(stderrBuffer || `capture process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    fail(new Error(`ScreenCaptureKit capture process exited: ${detail}`));
  }

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.on('error', onChildError);
  child.on('exit', onChildExit);

  return startup;
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
  const captureStartupTimeoutMs = deps.captureStartupTimeoutMs || DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS;
  const defaultFrameRate = deps.frameRate || DEFAULT_REMOTE_WINDOW_FRAME_RATE;
  const runIterm2Python = deps.runIterm2Python || runDefaultIterm2Python;
  const runMacosAppWindowCatalog = deps.runMacosAppWindowCatalog || runDefaultMacosAppWindowCatalog;
  let remoteWindowInputHelper: RemoteWindowInputHelper | null = null;
  const getRemoteWindowInputHelper = () => {
    if (!remoteWindowInputHelper) {
      remoteWindowInputHelper = deps.remoteWindowInputHelperFactory
        ? deps.remoteWindowInputHelperFactory({ swiftBinary })
        : createDefaultRemoteWindowInputHelper({ swiftBinary });
    }
    return remoteWindowInputHelper;
  };
  const warmRemoteWindowInputHelperForTarget = async (target: RemoteWindowStreamTargetManifest) => {
    if (
      platform !== 'darwin'
      || deps.runRemoteWindowInputEvent
      || target.inputRoute !== 'os-event'
      || target.focusPolicy !== 'bring-to-focus'
    ) {
      return;
    }
    await getRemoteWindowInputHelper().warm();
  };
  const runRemoteWindowInputEvent = deps.runRemoteWindowInputEvent || ((payload, target, options) => (
    getRemoteWindowInputHelper().send(buildRemoteWindowInputConfig(payload, target, {
      daemonReceivedAtMs: options.daemonReceivedAtMs,
    }))
  ));
  const now = deps.now || (() => new Date().toISOString());
  const captureSourceFactory = deps.captureSourceFactory || startScreenCaptureKitFrameSource;
  const createPeerConnection = deps.peerConnectionFactory || ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const createRtcSessionDescription = deps.rtcSessionDescriptionFactory || ((description: RTCSessionDescriptionInit) => new RTCSessionDescription(description));
  const createRtcIceCandidate = deps.rtcIceCandidateFactory || ((candidate: RTCIceCandidateInit) => new RTCIceCandidate(candidate));
  const createVideoSource = deps.videoSourceFactory || (() => new nonstandard.RTCVideoSource({ isScreencast: true }));
  const rgbaToI420 = deps.rgbaToI420 || nonstandard.rgbaToI420;
  const activeStreams = new Map<string, ActiveRemoteWindowStream>();
  const targetCatalogCacheTtlMs = Math.max(
    0,
    Math.floor(deps.targetCatalogCacheTtlMs ?? DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS),
  );
  const nowMs = deps.nowMs || Date.now;
  const targetCatalogCache = new Map<string, RemoteWindowTargetCatalogCacheEntry>();
  const targetCatalogRefreshes = new Map<string, Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>>();

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

  async function listTargetsLive(
    payload: RemoteWindowStreamRequestPayload,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> {
    const createdAt = now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets: RemoteWindowStreamTargetManifest[] = [];
    const errors: RemoteWindowStreamErrorPayload[] = [];

    let macosAppWindowCatalogOk = false;
    let macosAppWindowCatalog: MacosAppWindowCatalog | null = null;
    if (includeAppWindows) {
      try {
        macosAppWindowCatalog = await queryMacosAppWindowCatalog();
        targets.push(...buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
        errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
      }
    }

    let catalog: Iterm2RawCatalog | null = null;
    if (includeIterm2) {
      try {
        catalog = await queryIterm2Catalog();
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'iTerm2 Python API unavailable');
        errors.push(remoteWindowError(payload, 'iterm2_api_unavailable', message || 'iTerm2 Python API unavailable'));
      }
    }

    let tmuxTargets = new Map<string, TmuxClientTarget>();
    if (catalog) {
      if (!macosAppWindowCatalogOk) {
        try {
          macosAppWindowCatalog = await queryMacosAppWindowCatalog();
          macosAppWindowCatalogOk = true;
        } catch (error) {
          const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
          errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
        }
      }
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
          includeAppWindowTargets: false,
          macosAppWindowCatalog,
          requireCaptureWindowForPanes: true,
        }));
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'remote window target manifest invalid');
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

  function startTargetCatalogRefresh(
    cacheKey: string,
    payload: RemoteWindowStreamRequestPayload,
  ) {
    const existing = targetCatalogRefreshes.get(cacheKey);
    if (existing) {
      return existing;
    }
    const refreshPayload = {
      ...payload,
      requestId: payload.requestId || `rw-catalog-refresh-${nowMs()}`,
    };
    const refresh = listTargetsLive(refreshPayload)
      .catch((error: unknown) => remoteWindowError(
        refreshPayload,
        'remote_window_catalog_failed',
        error instanceof Error ? error.message : 'remote window catalog failed',
      ))
      .then((result) => {
        if ('targets' in result) {
          targetCatalogCache.set(cacheKey, {
            updatedAtMs: nowMs(),
            response: cloneRemoteWindowTargetCatalogResponse(result, result.requestId),
          });
        }
        return result;
      })
      .finally(() => {
        if (targetCatalogRefreshes.get(cacheKey) === refresh) {
          targetCatalogRefreshes.delete(cacheKey);
        }
      });
    targetCatalogRefreshes.set(cacheKey, refresh);
    return refresh;
  }

  async function refreshTargetCatalog(
    cacheKey: string,
    payload: RemoteWindowStreamRequestPayload,
  ) {
    const result = await startTargetCatalogRefresh(cacheKey, payload);
    return cloneRemoteWindowTargetCatalogResult(result, payload.requestId);
  }

  function warmTargetCatalog() {
    if (platform !== 'darwin') {
      return;
    }
    const payload: RemoteWindowStreamRequestPayload = {
      requestId: `rw-catalog-warm-${nowMs()}`,
      includeAppWindows: true,
      includeIterm2: true,
    };
    void startTargetCatalogRefresh(
      buildRemoteWindowTargetCatalogCacheKey(payload),
      payload,
    );
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
    const cacheKey = buildRemoteWindowTargetCatalogCacheKey(payload);
    const cached = targetCatalogCache.get(cacheKey) || null;
    const cacheAgeMs = cached ? nowMs() - cached.updatedAtMs : Number.POSITIVE_INFINITY;
    const cacheFresh = Boolean(cached && cacheAgeMs >= 0 && cacheAgeMs < targetCatalogCacheTtlMs);
    if (!payload.forceRefresh && cached && cacheFresh) {
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    if (!payload.forceRefresh && cached) {
      void startTargetCatalogRefresh(cacheKey, payload);
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    return refreshTargetCatalog(cacheKey, payload);
  }

  function buildStreamError(
    payload: { requestId?: string; streamId?: string },
    code: string,
    message: string,
  ): RemoteWindowStreamErrorPayload {
    return {
      requestId: payload.requestId || '',
      ...(payload.streamId ? { streamId: payload.streamId } : {}),
      code,
      message: truncateRemoteWindowErrorMessage(message || code),
    };
  }

  function cleanupStream(entry: ActiveRemoteWindowStream, reason: string) {
    if (entry.cleanupDone) {
      return false;
    }
    entry.cleanupDone = true;
    activeStreams.delete(entry.streamId);
    entry.pendingVideoFrame = null;
    try {
      entry.captureSource?.stop();
    } catch {
      // Capture cleanup must not prevent peer cleanup.
    }
    entry.captureSource = null;
    try {
      entry.videoTrack.stop();
    } catch {
      // Track cleanup must remain exactly once even if the track is already stopped.
    }
    entry.peerConnection.onicecandidate = null;
    entry.peerConnection.onconnectionstatechange = null;
    try {
      entry.peerConnection.close();
    } catch {
      // Peer cleanup must not mask the stream cleanup path.
    }
    entry.handlers.sendStatus?.({
      requestId: entry.requestId,
      streamId: entry.streamId,
      phase: 'stopped',
      framesSent: entry.framesSent,
      message: reason,
    });
    return true;
  }

  function isCurrentStream(entry: ActiveRemoteWindowStream) {
    return activeStreams.get(entry.streamId) === entry && !entry.cleanupDone;
  }

  function isRemoteWindowPeerMediaReady(entry: ActiveRemoteWindowStream) {
    return Boolean(entry.peerConnection.localDescription);
  }

  function sendRemoteWindowVideoFrame(
    entry: ActiveRemoteWindowStream,
    captureFrame: RemoteWindowCaptureFrame,
  ) {
    const i420Frame = convertRgbaToI420Frame(captureFrame, rgbaToI420);
    entry.videoSource.onFrame(i420Frame);
    entry.framesSent += 1;
    if (entry.framesSent === 1) {
      entry.handlers.sendStatus?.({
        requestId: entry.requestId,
        streamId: entry.streamId,
        phase: 'streaming',
        framesSent: entry.framesSent,
        frameWidth: captureFrame.width,
        frameHeight: captureFrame.height,
      });
    }
  }

  function flushPendingRemoteWindowVideoFrame(entry: ActiveRemoteWindowStream) {
    if (!isCurrentStream(entry) || !isRemoteWindowPeerMediaReady(entry) || !entry.pendingVideoFrame) {
      return;
    }
    const pending = entry.pendingVideoFrame;
    entry.pendingVideoFrame = null;
    try {
      sendRemoteWindowVideoFrame(entry, pending.frame);
    } catch (error) {
      cleanupStream(
        entry,
        `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function handleRemoteWindowCaptureFrame(
    entry: ActiveRemoteWindowStream,
    captureFrame: RemoteWindowCaptureFrame,
  ) {
    if (!isCurrentStream(entry)) {
      return;
    }
    if (!isRemoteWindowPeerMediaReady(entry)) {
      entry.pendingVideoFrame = {
        frame: {
          width: captureFrame.width,
          height: captureFrame.height,
          rgba: new Uint8Array(captureFrame.rgba),
        },
      };
      return;
    }
    try {
      sendRemoteWindowVideoFrame(entry, captureFrame);
    } catch (error) {
      cleanupStream(
        entry,
        `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function validateRemoteWindowInput(payload: RemoteWindowInputEventPayload, entry: ActiveRemoteWindowStream) {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      throw new Error('remote window input requires requestId, streamId, and targetId');
    }
    if (payload.targetId !== entry.targetId) {
      throw new Error(`remote window input target mismatch: ${payload.targetId}`);
    }
    if (entry.target.inputRoute === 'os-event' && entry.target.focusPolicy !== 'bring-to-focus') {
      throw new Error('remote window OS input requires bring-to-focus policy');
    }
    if (entry.target.inputRoute !== 'os-event') {
      throw new Error(`remote window input route is not implemented: ${entry.target.inputRoute}`);
    }
    if (payload.event.kind === 'focus') {
      return;
    }
    if (payload.event.kind === 'window-resize') {
      if (
        !Number.isFinite(payload.event.width)
        || !Number.isFinite(payload.event.height)
        || payload.event.width < 120
        || payload.event.height < 120
      ) {
        throw new Error('remote window resize dimensions are invalid');
      }
      return;
    }
    if (payload.event.kind === 'pointer') {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window pointer input coordinates are invalid');
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error('remote window pointer input normalized coordinates are out of range');
      }
    }
    if (payload.event.kind === 'scroll') {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window scroll input coordinates or delta are invalid');
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error('remote window scroll input normalized coordinates are out of range');
      }
      if (payload.event.unit !== 'pixel') {
        throw new Error('remote window scroll input unit is invalid');
      }
    }
    if (payload.event.kind === 'gesture') {
      const values = [
        payload.event.startX,
        payload.event.startY,
        payload.event.x,
        payload.event.y,
        payload.event.startNormalizedX,
        payload.event.startNormalizedY,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY,
        payload.event.durationMs,
        payload.event.velocityX,
        payload.event.velocityY,
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error('remote window gesture input coordinates, delta, or timing are invalid');
      }
      if (
        payload.event.startNormalizedX < 0
        || payload.event.startNormalizedX > 1
        || payload.event.startNormalizedY < 0
        || payload.event.startNormalizedY > 1
        || payload.event.normalizedX < 0
        || payload.event.normalizedX > 1
        || payload.event.normalizedY < 0
        || payload.event.normalizedY > 1
      ) {
        throw new Error('remote window gesture input normalized coordinates are out of range');
      }
      if (
        payload.event.gesture !== 'swipe'
        || payload.event.phase !== 'end'
        || payload.event.unit !== 'pixel'
        || payload.event.durationMs <= 0
      ) {
        throw new Error('remote window gesture input contract is invalid');
      }
    }
    if (payload.event.kind === 'key' && payload.event.phase !== 'down' && payload.event.phase !== 'up') {
      throw new Error('remote window key input phase is invalid');
    }
  }

  async function startStream(
    payload: RemoteWindowStreamStartRequestPayload,
    handlers: RemoteWindowStreamDaemonHandlers = {},
  ): Promise<RemoteWindowStreamStartedPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_request_invalid', 'remote window stream start requires requestId and streamId');
    }
    if (platform !== 'darwin') {
      return buildStreamError(payload, 'remote_window_platform_unsupported', 'remote window stream is only available on macOS daemon hosts');
    }
    if (activeStreams.has(payload.streamId)) {
      return buildStreamError(payload, 'remote_window_stream_exists', `remote window stream already exists: ${payload.streamId}`);
    }

    let entry: ActiveRemoteWindowStream | null = null;
    try {
      validateStreamTargetForCapture(payload.target);
      const inputHelperWarm = warmRemoteWindowInputHelperForTarget(payload.target)
        .then(() => null, (error: unknown) => (
          error instanceof Error ? error : new Error('remote window input helper warm failed')
        ));
      const peerConnection = createPeerConnection({
        iceServers: Array.isArray(payload.iceServers) ? payload.iceServers as unknown as RTCIceServer[] : [],
      });
      const videoSource = createVideoSource();
      const videoTrack = videoSource.createTrack();
      const requestedVideoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      const videoSender = addRemoteWindowVideoTrack(
        peerConnection,
        videoTrack,
      ) as RTCRtpSender | undefined;
      const streamFrameRate = requestedVideoBitrate?.maxFrameRateFps ?? defaultFrameRate;
      let videoBitrate: RemoteWindowVideoBitrateConfig | null = null;
      let videoBitrateWarning: string | null = null;

      entry = {
        streamId: payload.streamId,
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        target: payload.target,
        peerConnection,
        videoSender: videoSender || null,
        videoSource,
        videoTrack,
        videoBitrate,
        captureSource: null,
        handlers,
        framesSent: 0,
        pendingVideoFrame: null,
        cleanupDone: false,
      };
      activeStreams.set(payload.streamId, entry);

      peerConnection.onicecandidate = (event) => {
        if (!entry || !isCurrentStream(entry) || !event.candidate) {
          return;
        }
        handlers.sendIceCandidate?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          candidate: normalizeIceCandidate(event.candidate),
        });
      };
      peerConnection.onconnectionstatechange = () => {
        if (!entry || !isCurrentStream(entry)) {
          return;
        }
        const state = peerConnection.connectionState;
        if (state === 'connected') {
          flushPendingRemoteWindowVideoFrame(entry);
        }
        if (state === 'failed' || state === 'closed') {
          cleanupStream(entry, `remote window WebRTC connection ${state}`);
        }
      };

      handlers.sendStatus?.({
        requestId: payload.requestId,
        streamId: payload.streamId,
        phase: 'starting',
        ...(videoBitrateWarning
          ? { message: `video bitrate not applied: ${videoBitrateWarning}` }
          : {}),
      });

      await peerConnection.setRemoteDescription(createRtcSessionDescription({
        type: payload.offer.type,
        sdp: payload.offer.sdp,
      }));

      const captureSource = await captureSourceFactory(payload.target, {
        frameRate: streamFrameRate,
        startupTimeoutMs: captureStartupTimeoutMs,
        swiftBinary,
        onFrame: (frame) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          handleRemoteWindowCaptureFrame(entry, frame);
        },
        onError: (error) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          cleanupStream(entry, error.message || 'remote window capture failed');
        },
      });
      if (!isCurrentStream(entry)) {
        captureSource.stop();
        throw new Error('remote window stream was closed before capture started');
      }
      entry.captureSource = captureSource;
      const inputHelperWarmError = await inputHelperWarm;
      if (inputHelperWarmError) {
        throw inputHelperWarmError;
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (!isCurrentStream(entry)) {
        throw new Error('remote window stream was closed before media negotiation completed');
      }
      flushPendingRemoteWindowVideoFrame(entry);
      if (requestedVideoBitrate) {
        try {
          const applyResult = await applyRemoteWindowVideoBitrate(videoSender || null, requestedVideoBitrate);
          if (applyResult.applied) {
            videoBitrate = applyResult.videoBitrate;
            entry.videoBitrate = videoBitrate;
          } else {
            videoBitrateWarning = applyResult.reason;
          }
        } catch (error) {
          videoBitrateWarning = formatRemoteWindowVideoBitrateError(error);
        }
        if (videoBitrateWarning) {
          handlers.sendStatus?.({
            requestId: payload.requestId,
            streamId: payload.streamId,
            phase: 'starting',
            message: `video bitrate not applied: ${videoBitrateWarning}`,
          });
        }
      }

      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.target.streamTargetId,
        answer: normalizeRtcDescription(peerConnection.localDescription || answer, 'answer'),
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: captureSource.width,
          frameHeight: captureSource.height,
          frameRate: captureSource.frameRate,
          ...(entry.videoBitrate ? { maxBitrateBps: entry.videoBitrate.maxBitrateBps } : {}),
          targetKind: payload.target.videoTarget.kind,
        },
        transport: {
          kind: 'webrtc-video',
        },
      };
    } catch (error) {
      if (entry) {
        cleanupStream(entry, error instanceof Error ? error.message : String(error));
      }
      return buildStreamError(
        payload,
        'remote_window_stream_start_failed',
        error instanceof Error ? error.message : 'remote window stream start failed',
      );
    }
  }

  async function addIceCandidate(payload: RemoteWindowStreamIceCandidatePayload) {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return false;
    }
    await entry.peerConnection.addIceCandidate(createRtcIceCandidate({
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid ?? null,
      sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
      usernameFragment: payload.candidate.usernameFragment ?? null,
    }));
    flushPendingRemoteWindowVideoFrame(entry);
    return true;
  }

  async function stopStream(
    payload: RemoteWindowStreamStopRequestPayload,
  ): Promise<RemoteWindowStreamStatusPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, 'remote_window_stream_stop_invalid', 'remote window stream stop requires requestId and streamId');
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        phase: 'stopped',
        framesSent: 0,
        message: 'remote window stream already stopped',
      };
    }
    const framesSent = entry.framesSent;
    cleanupStream(entry, 'remote window stream stopped');
    return {
      requestId: payload.requestId,
      streamId: payload.streamId,
      phase: 'stopped',
      framesSent,
      message: 'remote window stream stopped',
    };
  }

  async function updateStreamQuality(
    payload: RemoteWindowStreamQualityRequestPayload,
  ): Promise<RemoteWindowStreamQualityResultPayload | RemoteWindowStreamErrorPayload> {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      return buildStreamError(payload, 'remote_window_stream_quality_invalid', 'remote window stream quality requires requestId, streamId, and targetId');
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, 'remote_window_stream_quality_missing', `remote window stream is not active: ${payload.streamId}`);
    }
    if (payload.targetId !== entry.targetId) {
      return buildStreamError(payload, 'remote_window_stream_quality_target_mismatch', `remote window stream quality target mismatch: ${payload.targetId}`);
    }
    try {
      const videoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      if (!videoBitrate) {
        throw new Error('remote window stream quality requires videoBitrate');
      }
      const applyResult = await applyRemoteWindowVideoBitrate(entry.videoSender, videoBitrate);
      if (!applyResult.applied) {
        throw new Error(applyResult.reason);
      }
      entry.videoBitrate = applyResult.videoBitrate;
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.targetId,
        accepted: true,
        videoBitrate: applyResult.videoBitrate,
      };
    } catch (error) {
      return buildStreamError(
        payload,
        'remote_window_stream_quality_failed',
        formatRemoteWindowVideoBitrateError(error),
      );
    }
  }

  async function injectInput(
    payload: RemoteWindowInputEventPayload,
  ): Promise<RemoteWindowInputResultPayload | RemoteWindowStreamErrorPayload> {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, 'remote_window_input_stream_missing', `remote window stream is not active: ${payload.streamId || 'missing'}`);
    }
    const daemonReceivedAtMs = nowMs();
    try {
      validateRemoteWindowInput(payload, entry);
      await runRemoteWindowInputEvent(payload, entry.target, {
        swiftBinary,
        runTmux: deps.runTmux,
        daemonReceivedAtMs,
      });
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.targetId,
        accepted: true,
      };
    } catch (error) {
      return buildStreamError(
        payload,
        'remote_window_input_failed',
        error instanceof Error ? error.message : 'remote window input failed',
      );
    }
  }

  function dispose(reason = 'remote window daemon runtime disposed') {
    for (const entry of Array.from(activeStreams.values())) {
      cleanupStream(entry, reason);
    }
    targetCatalogCache.clear();
    targetCatalogRefreshes.clear();
    remoteWindowInputHelper?.dispose();
    remoteWindowInputHelper = null;
  }

  if (deps.warmTargetCatalogOnStart) {
    warmTargetCatalog();
  }

  return {
    listTargets,
    startStream,
    addIceCandidate,
    stopStream,
    updateStreamQuality,
    injectInput,
    dispose,
  };
}

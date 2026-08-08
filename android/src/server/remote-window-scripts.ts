export const ITERM2_CATALOG_PYTHON = String.raw`
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
            # 只读布局信息；不调用 async_update_layout()（会强制重排 pane，干扰用户正在使用的 iTerm2）
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

export const MACOS_APP_WINDOW_CATALOG_SWIFT = String.raw`
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
    let skipFocus: Bool?
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
    let clickCount: Int?
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

func frontmostProcessPidFromSystemEvents() -> Int32? {
    let process = Process()
    let output = Pipe()
    let error = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        "-e",
        "tell application \"System Events\" to get unix id of first application process whose frontmost is true"
    ]
    process.standardOutput = output
    process.standardError = error
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return nil
    }
    guard process.terminationStatus == 0 else {
        return nil
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    guard
        let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
        let frontmostPid = Int32(raw)
    else {
        return nil
    }
    return frontmostPid
}

func frontmostPidMatches(_ pid: Int32) -> Bool {
    return frontmostProcessPidFromSystemEvents() == pid
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
    // 已在前台（frontmost pid 匹配）即视为已聚焦：bounds 比对在 retina/坐标差异下不可靠，
    // 会导致每次手势都执行 bring-to-front 打断 ScreenCaptureKit 捕获并让其他窗口闪烁
    if frontmostPidMatches(config.pid) {
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

func postClickEvent(x: Double, y: Double, button: String?, clickCount: Int?) {
    let point = CGPoint(x: x, y: y)
    postMouseMove(x: x, y: y)
    let count = max(1, min(3, clickCount ?? 1))
    for _ in 0..<count {
        let down = CGEvent(
            mouseEventSource: source,
            mouseType: mouseType(phase: "down", button: button, buttons: 1),
            mouseCursorPosition: point,
            mouseButton: mouseButton(button)
        )
        down?.post(tap: .cghidEventTap)
        usleep(18000)
        let up = CGEvent(
            mouseEventSource: source,
            mouseType: mouseType(phase: "up", button: button, buttons: 0),
            mouseCursorPosition: point,
            mouseButton: mouseButton(button)
        )
        up?.post(tap: .cghidEventTap)
        usleep(18000)
    }
}

func postScrollEvent(x: Double, y: Double, deltaX: Double, deltaY: Double, unit: String?, moveCursor: Bool = true) {
    let units: CGScrollEventUnit = unit == "pixel" ? .pixel : .line
    let point = CGPoint(x: x, y: y)
    if moveCursor {
        postMouseMove(x: x, y: y)
    }
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
    "KeyW": 13,
    "Delete": 117,
    "Home": 115,
    "End": 119,
    "PageUp": 116,
    "PageDown": 121,
]

func handleConfig(_ config: InputConfig) throws {
    if config.event.kind == "close-window" {
        try focusTargetWindow(config)
        let commandDown = CGEvent(keyboardEventSource: source, virtualKey: keyCodes["KeyW"]!, keyDown: true)
        commandDown?.flags = [.maskCommand]
        commandDown?.post(tap: .cghidEventTap)
        let commandUp = CGEvent(keyboardEventSource: source, virtualKey: keyCodes["KeyW"]!, keyDown: false)
        commandUp?.flags = [.maskCommand]
        commandUp?.post(tap: .cghidEventTap)
        return
    }
    if config.event.kind == "window-resize" {
        try resizeTargetWindow(config)
        return
    }
    if config.skipFocus != true {
        try focusTargetWindow(config)
    }

    if config.event.kind == "focus" {
        return
    } else if config.event.kind == "click" {
        guard let x = config.event.x, let y = config.event.y else {
            throw inputError("remote click input missing coordinates")
        }
        postClickEvent(x: x, y: y, button: config.event.button, clickCount: config.event.clickCount)
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
        postScrollEvent(x: x, y: y, deltaX: deltaX, deltaY: deltaY, unit: config.event.unit, moveCursor: config.event.moveCursor ?? true)
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

struct CompositeWindow: Decodable {
    let windowId: String
    let windowBounds: Rect
    let cropRect: Rect
    let offsetX: Double
    let offsetY: Double
}

struct CaptureConfig: Decodable {
    let windowId: String
    let appBundleId: String
    let title: String
    let windowBounds: Rect
    let cropRect: Rect
    let frameRate: Int
    let queueDepth: Int
    let compositeWindows: [CompositeWindow]?
    let canvasWidth: Int?
    let canvasHeight: Int?
}

struct CaptureCommand: Decodable {
    let kind: String
    let seq: Int
    let windowBounds: Rect
    let cropRect: Rect
    let frameRate: Int
    let queueDepth: Int
    let compositeWindows: [CompositeWindow]?
    let canvasWidth: Int?
    let canvasHeight: Int?
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

func makeStreamConfiguration(windowBounds: Rect, cropRect: Rect, frameRate: Int, queueDepth: Int) -> SCStreamConfiguration {
    let streamConfiguration = SCStreamConfiguration()
    streamConfiguration.capturesAudio = false
    streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
    streamConfiguration.queueDepth = max(3, min(3, queueDepth))
    streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, frameRate)))
    streamConfiguration.width = max(1, Int(cropRect.width.rounded()))
    streamConfiguration.height = max(1, Int(cropRect.height.rounded()))
    streamConfiguration.sourceRect = CGRect(
        x: max(0, cropRect.x - windowBounds.x),
        y: max(0, cropRect.y - windowBounds.y),
        width: max(1, cropRect.width),
        height: max(1, cropRect.height)
    )
    return streamConfiguration
}

func writeCaptureUpdate(seq: Int, ok: Bool, width: Int? = nil, height: Int? = nil, error: String? = nil) {
    var result: [String: Any] = ["seq": seq, "ok": ok]
    if let width = width { result["width"] = width }
    if let height = height { result["height"] = height }
    if let error = error { result["error"] = error }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
       let json = String(data: data, encoding: .utf8) {
        stderrLine("ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE " + json)
    }
}

func writeFrame(rgba: Data, width: Int, height: Int) {
    var header = Data()
    header.append(contentsOf: [0x5A, 0x52, 0x57, 0x31])
    appendUInt32(UInt32(width), to: &header)
    appendUInt32(UInt32(height), to: &header)
    appendUInt32(UInt32(rgba.count), to: &header)
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(rgba)
}

final class CompositeCanvas {
    let width: Int
    let height: Int
    private var data: Data
    private let lock = NSLock()
    private let offsets: [(x: Int, y: Int, width: Int, height: Int)]

    init(width: Int, height: Int, offsets: [(x: Int, y: Int, width: Int, height: Int)]) {
        self.width = width
        self.height = height
        self.offsets = offsets
        self.data = Data(count: width * height * 4)
    }

    func blit(index: Int, rgba: Data, frameWidth: Int, frameHeight: Int) {
        guard index < offsets.count else { return }
        lock.lock()
        defer { lock.unlock() }
        let slot = offsets[index]
        let copyWidth = min(slot.width, frameWidth)
        let copyHeight = min(slot.height, frameHeight)
        for y in 0..<copyHeight {
            let srcRow = y * frameWidth * 4
            let dstRow = ((slot.y + y) * width + slot.x) * 4
            data.replaceSubrange(
                dstRow..<(dstRow + copyWidth * 4),
                with: rgba[srcRow..<(srcRow + copyWidth * 4)]
            )
        }
        writeFrame(rgba: data, width: width, height: height)
    }
}

final class FrameOutput: NSObject, SCStreamOutput {
    private var emitted = 0
    private let canvas: CompositeCanvas?
    private let canvasIndex: Int

    init(canvas: CompositeCanvas? = nil, canvasIndex: Int = 0) {
        self.canvas = canvas
        self.canvasIndex = canvasIndex
    }

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

        if let canvas = canvas {
            canvas.blit(index: canvasIndex, rgba: rgba, frameWidth: width, frameHeight: height)
        } else {
            writeFrame(rgba: rgba, width: width, height: height)
        }
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
let sampleQueue = DispatchQueue(label: "zterm.remote-window.capture.sample")
var activeStreams: [SCStream] = []

func findScWindow(windowId: String, appBundleId: String, windowBounds: Rect, content: SCShareableContent) -> SCWindow? {
    let numericWindowId = UInt32(windowId)
    return content.windows.first { candidate in
        if let numericWindowId = numericWindowId, candidate.windowID == numericWindowId {
            return true
        }
        if !appBundleId.isEmpty && candidate.owningApplication?.bundleIdentifier != appBundleId {
            return false
        }
        return rectMatches(candidate.frame, windowBounds)
    }
}

func startCompositeCapture(config: CaptureConfig, compositeWindows: [CompositeWindow], canvasWidth: Int, canvasHeight: Int, content: SCShareableContent) async throws {
    for stream in activeStreams {
        try? await stream.stopCapture()
    }
    activeStreams.removeAll()
    var allWindows: [CompositeWindow] = [CompositeWindow(
        windowId: config.windowId,
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        offsetX: 0,
        offsetY: 0
    )]
    allWindows.append(contentsOf: compositeWindows)
    var offsets: [(x: Int, y: Int, width: Int, height: Int)] = []
    for entry in allWindows {
        offsets.append((
            x: Int(entry.offsetX.rounded()),
            y: Int(entry.offsetY.rounded()),
            width: Int(entry.cropRect.width.rounded()),
            height: Int(entry.cropRect.height.rounded())
        ))
    }
    let canvas = CompositeCanvas(width: canvasWidth, height: canvasHeight, offsets: offsets)
    for (index, entry) in allWindows.enumerated() {
        guard let targetWindow = findScWindow(
            windowId: entry.windowId,
            appBundleId: config.appBundleId,
            windowBounds: entry.windowBounds,
            content: content
        ) else {
            stderrLine("ScreenCaptureKit composite window not found for " + entry.windowId)
            continue
        }
        let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
        let streamConfiguration = makeStreamConfiguration(
            windowBounds: entry.windowBounds,
            cropRect: entry.cropRect,
            frameRate: config.frameRate,
            queueDepth: config.queueDepth
        )
        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
        activeStreams.append(stream)
        let output = FrameOutput(canvas: canvas, canvasIndex: index)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
    }
}

func startSingleWindowCapture(config: CaptureConfig, content: SCShareableContent) async throws {
    guard let targetWindow = findScWindow(
        windowId: config.windowId,
        appBundleId: config.appBundleId,
        windowBounds: config.windowBounds,
        content: content
    ) else {
        stderrLine("ScreenCaptureKit window not found for " + config.windowId)
        exit(3)
    }

    let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
    let streamConfiguration = makeStreamConfiguration(
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        frameRate: config.frameRate,
        queueDepth: config.queueDepth
    )

    let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
    activeStreams.append(stream)
    try stream.addStreamOutput(FrameOutput(), type: .screen, sampleHandlerQueue: sampleQueue)
    try await stream.startCapture()
}

Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        if let compositeWindows = config.compositeWindows, !compositeWindows.isEmpty,
           let canvasWidth = config.canvasWidth, let canvasHeight = config.canvasHeight {
            try await startCompositeCapture(
                config: config,
                compositeWindows: compositeWindows,
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                content: content
            )
            stderrLine("zterm remote window composite capture started: \(compositeWindows.count + 1) windows")
        } else {
            try await startSingleWindowCapture(config: config, content: content)
            stderrLine("zterm remote window capture started")
        }
    } catch {
        stderrLine("ScreenCaptureKit capture start failed: " + String(describing: error))
        exit(4)
    }
}

DispatchQueue.global(qos: .utility).async {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            continue
        }
        guard let data = trimmed.data(using: .utf8) else {
            continue
        }
        do {
            let command = try JSONDecoder().decode(CaptureCommand.self, from: data)
            guard command.kind == "update-config" else {
                writeCaptureUpdate(seq: command.seq, ok: false, error: "unsupported capture command")
                continue
            }
            Task { @MainActor in
                do {
                    if let compositeWindows = command.compositeWindows, !compositeWindows.isEmpty,
                       let canvasWidth = command.canvasWidth, let canvasHeight = command.canvasHeight {
                        // 组合模式更新：停旧流并按新窗口列表重建（窗口增删/布局变化）
                        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                        try await startCompositeCapture(
                            config: CaptureConfig(
                                windowId: config.windowId,
                                appBundleId: config.appBundleId,
                                title: config.title,
                                windowBounds: config.windowBounds,
                                cropRect: config.cropRect,
                                frameRate: config.frameRate,
                                queueDepth: config.queueDepth,
                                compositeWindows: compositeWindows,
                                canvasWidth: canvasWidth,
                                canvasHeight: canvasHeight
                            ),
                            compositeWindows: compositeWindows,
                            canvasWidth: canvasWidth,
                            canvasHeight: canvasHeight,
                            content: content
                        )
                        writeCaptureUpdate(
                            seq: command.seq,
                            ok: true,
                            width: canvasWidth,
                            height: canvasHeight
                        )
                    } else {
                        guard let stream = activeStreams.first else {
                            throw NSError(domain: "RemoteWindowCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "capture stream is not active"])
                        }
                        let nextConfig = makeStreamConfiguration(
                            windowBounds: command.windowBounds,
                            cropRect: command.cropRect,
                            frameRate: command.frameRate,
                            queueDepth: command.queueDepth
                        )
                        try await stream.updateConfiguration(nextConfig)
                        writeCaptureUpdate(
                            seq: command.seq,
                            ok: true,
                            width: max(1, Int(command.cropRect.width.rounded())),
                            height: max(1, Int(command.cropRect.height.rounded()))
                        )
                    }
                } catch {
                    writeCaptureUpdate(seq: command.seq, ok: false, error: error.localizedDescription)
                }
            }
        } catch {
            stderrLine("ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE invalid command: " + error.localizedDescription)
        }
    }
}

dispatchMain()
`;

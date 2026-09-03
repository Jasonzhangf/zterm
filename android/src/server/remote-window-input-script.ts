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
    let moveCursor: Bool?
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

var lastVerifiedFocusPid: Int32? = nil
var lastVerifiedFocusWindowId: String? = nil
var lastVerifiedFocusAt: TimeInterval = 0

func canReuseVerifiedFocus(_ config: InputConfig) -> Bool {
    guard config.event.kind == "scroll" || (config.event.kind == "pointer" && config.event.phase == "move") else {
        return false
    }
    let now = Date().timeIntervalSinceReferenceDate
    return lastVerifiedFocusPid == config.pid
        && lastVerifiedFocusWindowId == config.window.windowId
        && now - lastVerifiedFocusAt <= 0.25
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
    if canReuseVerifiedFocus(config) {
        return
    }
    guard AXIsProcessTrusted() else {
        throw NSError(domain: "RemoteWindowInput", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS Accessibility permission is required for remote window input"])
    }
    guard let app = waitForRunningApplication(config.pid) else {
        throw NSError(domain: "RemoteWindowInput", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote input target app is not running pid=" + String(config.pid)])
    }
    let appElement = AXUIElementCreateApplication(config.pid)
    // 同一应用可有多个窗口；前台 PID 不等于目标窗口已聚焦。
    if frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, config.window.bounds) {
        lastVerifiedFocusPid = config.pid
        lastVerifiedFocusWindowId = config.window.windowId
        lastVerifiedFocusAt = Date().timeIntervalSinceReferenceDate
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
            lastVerifiedFocusPid = config.pid
            lastVerifiedFocusWindowId = config.window.windowId
            lastVerifiedFocusAt = Date().timeIntervalSinceReferenceDate
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

func postClickEvent(x: Double, y: Double, button: String?, clickCount: Int?, moveCursor: Bool = true) {
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
    if !moveCursor {
        // 触控模式：点击后隐藏系统光标，避免远端串流画面残留鼠标
        CGDisplayHideCursor(CGMainDisplayID())
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
    try focusTargetWindow(config)

    if config.event.kind == "focus" {
        return
    } else if config.event.kind == "click" {
        guard let x = config.event.x, let y = config.event.y else {
            throw inputError("remote click input missing coordinates")
        }
        postClickEvent(x: x, y: y, button: config.event.button, clickCount: config.event.clickCount, moveCursor: config.event.moveCursor ?? true)
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

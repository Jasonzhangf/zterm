export const MACOS_REMOTE_WINDOW_INPUT_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(
    _ element: AXUIElement,
    _ windowId: UnsafeMutablePointer<CGWindowID>
) -> AXError

struct InputConfig: Decodable {
    let pid: Int32
    let appBundleId: String
    let focusPolicy: String
    let window: RemoteInputWindow
    let event: RemoteInputEvent
    let native: RemoteInputNativeCarrier?
}

// Final-holder release is target-free by contract: the daemon helper owns the
// exact native carrier, so the wire payload carries only the release operation.
// This envelope decodes that payload without requiring a target window/event.
struct InputReleaseEnvelope: Decodable {
    let release: RemoteInputReleaseOperation?
}

struct RemoteInputModifierFlags: Decodable {
    let shiftKey: Bool?
    let altKey: Bool?
    let ctrlKey: Bool?
    let metaKey: Bool?
}

struct RemoteInputNativeCarrier: Decodable {
    let kind: String
    let nativeKeyCode: Int?
    let nativeKeyText: String?
    let flags: RemoteInputModifierFlags?
}

struct RemoteInputReleaseOperation: Decodable {
    let carrierKey: String
    let kind: String
    let nativeKeyCode: Int?
    let nativeKeyText: String?
    let flags: RemoteInputModifierFlags?
    let button: String?
    let x: Double?
    let y: Double?
    let observeKeyCode: Int?
    let observeDeadlineMs: Int?
}

struct RemoteInputReleaseResult: Encodable {
    let status: String
    let error: String?
}

struct RemoteInputResizePosition: Encodable {
    let x: Double
    let y: Double
}

struct RemoteInputResizeSize: Encodable {
    let width: Double
    let height: Double
}

struct RemoteInputResizeObservation: Encodable {
    let kind: String
    let position: RemoteInputResizePosition
    let size: RemoteInputResizeSize
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

func copyAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success {
        return nil
    }
    return value as AnyObject?
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

func parseTargetWindowId(_ config: InputConfig) throws -> CGWindowID {
    guard
        let rawWindowId = CGWindowID(config.window.windowId),
        rawWindowId > 0
    else {
        throw inputError("remote input target window id is invalid", code: 4)
    }
    return rawWindowId
}

func axWindowId(_ window: AXUIElement) -> CGWindowID? {
    var windowId = CGWindowID(0)
    guard _AXUIElementGetWindow(window, &windowId) == .success, windowId > 0 else {
        return nil
    }
    return windowId
}

func focusedWindowMatchesTarget(_ appElement: AXUIElement, _ targetWindowId: CGWindowID) -> Bool {
    guard let focusedWindow = copyAttribute(appElement, kAXFocusedWindowAttribute) else {
        return false
    }
    let focusedElement = focusedWindow as! AXUIElement
    return axWindowId(focusedElement) == targetWindowId
}

func findAxWindow(_ appElement: AXUIElement, _ targetWindowId: CGWindowID) -> AXUIElement? {
    let windows = copyAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
    return windows.first { axWindowId($0) == targetWindowId }
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
    let targetWindowId = try parseTargetWindowId(config)
    // 同一应用可有多个窗口；前台 PID 不等于目标窗口已聚焦。
    if frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, targetWindowId) {
        return
    }
    guard let window = findAxWindow(appElement, targetWindowId) else {
        throw inputError("remote input target window could not be matched for focus", code: 4)
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
        isFocused = focusedWindowMatchesTarget(appElement, targetWindowId)
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
    let targetWindowId = try parseTargetWindowId(config)
    guard let window = findAxWindow(appElement, targetWindowId) else {
        throw inputError("remote input target window could not be matched", code: 4)
    }
    return window
}

func readTargetPositionAndSize(_ window: AXUIElement) throws -> RemoteInputResizeObservation {
    var positionRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef) == .success,
          let positionRefValue = positionRef,
          CFGetTypeID(positionRefValue) == AXValueGetTypeID()
    else {
        throw inputError("remote window resize position readback failed")
    }
    let positionValue = positionRefValue as! AXValue
    var position = CGPoint.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position) else {
        throw inputError("remote window resize position readback invalid")
    }

    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let sizeRefValue = sizeRef,
          CFGetTypeID(sizeRefValue) == AXValueGetTypeID()
    else {
        throw inputError("remote window resize size readback failed")
    }
    let sizeValue = sizeRefValue as! AXValue
    var size = CGSize.zero
    guard AXValueGetValue(sizeValue, .cgSize, &size) else {
        throw inputError("remote window resize size readback invalid")
    }
    return RemoteInputResizeObservation(
        kind: "window-resize",
        position: RemoteInputResizePosition(x: Double(position.x), y: Double(position.y)),
        size: RemoteInputResizeSize(width: Double(size.width), height: Double(size.height))
    )
}

func resizeTargetWindow(_ config: InputConfig) throws -> RemoteInputResizeObservation {
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
    return try readTargetPositionAndSize(window)
}

let source = CGEventSource(stateID: .hidSystemState)

func flags(from carrierFlags: RemoteInputModifierFlags) -> CGEventFlags {
    var result = CGEventFlags()
    if carrierFlags.shiftKey == true { result.insert(.maskShift) }
    if carrierFlags.altKey == true { result.insert(.maskAlternate) }
    if carrierFlags.ctrlKey == true { result.insert(.maskControl) }
    if carrierFlags.metaKey == true { result.insert(.maskCommand) }
    return result
}

func postNativeKeyCarrier(_ carrier: RemoteInputNativeCarrier, down: Bool) throws {
    guard carrier.kind == "key" else {
        throw inputError("remote native carrier is not a key")
    }
    let event: CGEvent?
    if let keyCode = carrier.nativeKeyCode {
        event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: down)
    } else if let text = carrier.nativeKeyText, !text.isEmpty {
        var utf16 = Array(text.utf16).map { UniChar($0) }
        event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    } else {
        throw inputError("remote native key carrier is empty")
    }
    guard let posted = event else {
        throw inputError("remote native key event construction failed")
    }
    posted.flags = flags(from: carrier.flags ?? RemoteInputModifierFlags(shiftKey: false, altKey: false, ctrlKey: false, metaKey: false))
    posted.post(tap: .cghidEventTap)
}

func keyStateIsDown(_ keyCode: Int) -> Bool {
    return CGEventSource.keyState(CGEventSourceStateID.combinedSessionState, key: CGKeyCode(keyCode))
}

func buttonStateIsDown(_ button: CGMouseButton) -> Bool {
    return CGEventSource.buttonState(CGEventSourceStateID.combinedSessionState, button: button)
}

func observeRelease(operation: RemoteInputReleaseOperation) -> RemoteInputReleaseResult {
    let deadlineMs = operation.observeDeadlineMs ?? 2500
    let deadline = Date().timeIntervalSince1970 + Double(deadlineMs) / 1000.0
    while Date().timeIntervalSince1970 < deadline {
        if operation.kind == "pointer" {
            if !buttonStateIsDown(mouseButton(operation.button)) {
                return RemoteInputReleaseResult(status: "released", error: nil)
            }
        } else if let observeKeyCode = operation.observeKeyCode {
            if !keyStateIsDown(observeKeyCode) {
                return RemoteInputReleaseResult(status: "released", error: nil)
            }
        } else {
            return RemoteInputReleaseResult(status: "unverified", error: nil)
        }
        let remaining = deadline - Date().timeIntervalSince1970
        if remaining <= 0 {
            break
        }
        Thread.sleep(forTimeInterval: min(0.05, remaining))
    }
    return RemoteInputReleaseResult(status: "unverified", error: nil)
}

func handleRelease(operation: RemoteInputReleaseOperation) throws -> RemoteInputReleaseResult {
    if operation.kind == "pointer" {
        guard let x = operation.x, let y = operation.y else {
            throw inputError("remote native pointer release missing coordinates")
        }
        let event = CGEvent(
            mouseEventSource: source,
            mouseType: mouseType(phase: "up", button: operation.button, buttons: 0),
            mouseCursorPosition: CGPoint(x: x, y: y),
            mouseButton: mouseButton(operation.button)
        )
        guard event != nil else {
            throw inputError("remote native pointer release event construction failed")
        }
        event?.post(tap: .cghidEventTap)
    } else {
        let carrier = RemoteInputNativeCarrier(
            kind: operation.kind,
            nativeKeyCode: operation.nativeKeyCode,
            nativeKeyText: operation.nativeKeyText,
            flags: operation.flags
        )
        try postNativeKeyCarrier(carrier, down: false)
    }
    return observeRelease(operation: operation)
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

func handleConfig(_ config: InputConfig) throws {
    if config.event.kind == "close-window" {
        try focusTargetWindow(config)
        guard let carrier = config.native else {
            throw inputError("remote window close input missing normalized native carrier")
        }
        try postNativeKeyCarrier(carrier, down: true)
        try postNativeKeyCarrier(carrier, down: false)
        return
    }
    if config.event.kind == "window-resize" {
        let observed = try resizeTargetWindow(config)
        writeResult(ok: true, operation: [
            "kind": observed.kind,
            "position": ["x": observed.position.x, "y": observed.position.y],
            "size": ["width": observed.size.width, "height": observed.size.height],
        ])
        return
    }
    // Continuous motion is intentionally delivered without Accessibility/System
    // Events focus checks. Those checks are multi-hundred-millisecond operations
    // and serializing them into scroll/pointer-move turns a live gesture into a
    // stop-and-go queue. Reliable actions (click, key, pointer down/up, focus)
    // still verify the target immediately before injection.
    let isContinuousMotion = config.event.kind == "scroll"
        || (config.event.kind == "pointer" && config.event.phase == "move")
    if !isContinuousMotion {
        try focusTargetWindow(config)
    }

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
        guard let carrier = config.native else {
            throw inputError("remote key input missing normalized native carrier")
        }
        try postNativeKeyCarrier(carrier, down: phase == "down")
    } else {
        throw inputError("remote input event kind unsupported")
    }
}

func writeResult(
    ok: Bool,
    error: String? = nil,
    release: [String: Any]? = nil,
    operation: [String: Any]? = nil
) {
    var result: [String: Any] = ["ok": ok]
    if let error = error {
        result["error"] = error
    }
    if let release = release {
        result["release"] = release
    }
    if let operation = operation {
        result["operation"] = operation
    }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func releaseDict(_ result: RemoteInputReleaseResult) -> [String: Any] {
    var dict: [String: Any] = ["status": result.status]
    if let error = result.error {
        dict["error"] = error
    }
    return dict
}

@discardableResult
func handleRawConfig(_ rawConfig: String, exitOnFailure: Bool) -> Bool {
    do {
        guard let data = rawConfig.data(using: .utf8) else {
            throw inputError("remote input config is not utf8")
        }
        let envelope = try JSONDecoder().decode(InputReleaseEnvelope.self, from: data)
        if let release = envelope.release {
            do {
                let releaseResult = try handleRelease(operation: release)
                writeResult(ok: true, release: releaseDict(releaseResult))
            } catch {
                writeResult(ok: true, release: ["status": "failed", "error": error.localizedDescription])
            }
            return true
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

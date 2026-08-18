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

// 缓存每个 pid 的 AXUIElement app ref，避免重复创建
var axAppCache: [Int32: AXUIElement] = [:]

func axApp(for pid: Int32) -> AXUIElement? {
    if let cached = axAppCache[pid] { return cached }
    let app = AXUIElementCreateApplication(pid)
    axAppCache[pid] = app
    return app
}

// 用 AXUIElement 取窗口 content rect；macOS CGWindowList 给的 frame 在多数 app 含 title bar，
// 而 ScreenCaptureKit 截 desktopIndependentWindow 返回的像素含装饰（含 title bar），
// 导致客户端用 CGWindow frame 算 cropRect 与实际图像不贴合。
// 对每个窗口取 AXContent = (kAXPosition, kAXSize)，作为"用户看到的窗口内容"几何。
func axContentRect(for pid: Int32, cgWindowId: Int) -> CGRect? {
    guard let app = axApp(for: pid) else { return nil }
    // 优先匹配 AXTitleUIElement，否则取 kAXFocusedWindowAttribute
    var winRef: CFTypeRef?
    var axErr = AXUIElementCopyAttributeValue(app, kAXTitleUIElementAttribute as CFString, &winRef)
    if axErr != .success || winRef == nil {
        axErr = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &winRef)
    }
    if axErr != .success { return nil }
    guard let winObj = winRef else { return nil }
    let axWin = winObj as! AXUIElement

    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(axWin, kAXSizeAttribute as CFString, &sizeRef)
    guard let pVal = posRef, let sVal = sizeRef else { return nil }

    var p = CGPoint.zero
    var s = CGSize.zero
    guard
        AXValueGetValue(pVal as! AXValue, .cgPoint, &p),
        AXValueGetValue(sVal as! AXValue, .cgSize, &s)
    else { return nil }
    return CGRect(origin: p, size: s)
}

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
    let windowNumber = (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
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

    // 用 AXUIElement 算 content area；失败或与 frame 完全一致时不写入（保持原 frame）
    // macOS 坐标是 top-left origin，但 AXUIElement 返回的 y 在主屏是 top-left，在副屏是 bottom-left。
    // 这里要求 AX 返回的位置必须在 [frame.x, frame.x+width] 范围内，否则忽略。
    if windowNumber > 0, let content = axContentRect(for: pid_t(pid), cgWindowId: windowNumber) {
        // AX 返回的 y 在副屏是 bottom-left，需要翻转到 top-left
        // 主屏 frame.y 接近 AX y；副屏 frame.y 接近 display.height - (content.y + content.height)
        let axY = content.origin.y
        let axX = content.origin.x
        let axW = content.size.width
        let axH = content.size.height

        // 简单判定：content.x 应在 [frame.x - 50, frame.x + frame.width + 50] 之间
        let xOk = axX >= frameRect.minX - 50 && axX <= frameRect.maxX + 50
        let wOk = abs(axW - frameRect.width) <= 80
        let hOk = abs(axH - frameRect.height) <= 200 && axH > 100
        if xOk && wOk && hOk {
            // 算 contentRect 的 y：top-left = frame.y + (frame.height - content.height)，
            // 前提是 AX y == frame.y（即 title bar 在窗口底部不会出现）
            // macOS 上正常 title bar 在顶部，content y 偏移 = frame.height - content.height
            let titleBarHeight = max(0, frameRect.height - axH)
            // 主屏：content 起点 y_top = frame.y + titleBarHeight
            // 副屏（macOS top-left）：同样逻辑
            let contentTopY = frameRect.minY + titleBarHeight
            windowEntry["contentFrame"] = [
                "x": Int(axX.rounded()),
                "y": Int(contentTopY.rounded()),
                "width": Int(axW.rounded()),
                "height": Int(axH.rounded()),
            ]
        }
    }

    if let display = bestDisplay(for: frameRect) {
        windowEntry["displayId"] = String(display.id)
        windowEntry["displayBoundsTopLeftPx"] = rectDict(display.bounds)
    }
    windows.append(windowEntry)
}

let data = try JSONSerialization.data(withJSONObject: ["windows": windows], options: [])
FileHandle.standardOutput.write(data)
`;

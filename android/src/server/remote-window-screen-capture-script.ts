export const SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT = String.raw`
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

struct CompositeWindow: Decodable {
    let windowId: String
    let windowBounds: Rect
    let cropRect: Rect
    let offsetX: Double
    let offsetY: Double
    let outputWidth: Int?
    let outputHeight: Int?
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
    let outputWidth: Int?
    let outputHeight: Int?
}

struct CaptureCommand: Decodable {
    let kind: String
    let seq: Int
    let windowId: String
    let windowBounds: Rect
    let cropRect: Rect
    let frameRate: Int
    let queueDepth: Int
    let compositeWindows: [CompositeWindow]?
    let canvasWidth: Int?
    let canvasHeight: Int?
    let outputWidth: Int?
    let outputHeight: Int?
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

let frameOutputLock = NSLock()

func writeFrame(rgba: Data, width: Int, height: Int) {
    var packet = Data()
    packet.append(contentsOf: [0x5A, 0x52, 0x57, 0x31])
    appendUInt32(UInt32(width), to: &packet)
    appendUInt32(UInt32(height), to: &packet)
    appendUInt32(UInt32(rgba.count), to: &packet)
    packet.append(rgba)
    frameOutputLock.lock()
    defer { frameOutputLock.unlock() }
    FileHandle.standardOutput.write(packet)
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

_ = NSApplication.shared
let sampleQueue = DispatchQueue(label: "zterm.remote-window.capture.sample")
var activeStreams: [SCStream] = []
var compositeStopped = true
var captureLoopGeneration = 0
var singleWindowCapture: CompositeWindow? = nil

@Sendable func findScWindow(windowId: String, appBundleId: String, windowBounds: Rect, content: SCShareableContent) -> SCWindow? {
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

@Sendable func startCompositeCapture(config: CaptureConfig, compositeWindows: [CompositeWindow], canvasWidth: Int, canvasHeight: Int, content: SCShareableContent) async throws {
    for stream in activeStreams {
        try? await stream.stopCapture()
    }
    activeStreams.removeAll()
    let allWindows: [CompositeWindow] = [CompositeWindow(
        windowId: config.windowId,
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        offsetX: 0,
        offsetY: 0,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight
    )] + compositeWindows
    // ScreenCaptureKit 多 SCStream 并发只出首帧（真机验证：每窗口仅 1 帧）。
    // 组合模式改用 SCScreenshotManager.captureImage 逐窗口截图 + 平铺合成（10fps），无并发限制。
    compositeStopped = false
    captureLoopGeneration += 1
    let generation = captureLoopGeneration
    let timerQueue = DispatchQueue(label: "zterm.remote-window.composite.timer")
    timerQueue.asyncAfter(deadline: .now() + 0.05) {
        Task {
            while !compositeStopped && generation == captureLoopGeneration {
                await compositeFrameLoop(
                    allWindows: allWindows,
                    canvasWidth: canvasWidth,
                    canvasHeight: canvasHeight,
                    content: content
                )
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }
    stderrLine("zterm remote window composite capture started (SCScreenshotManager): \(allWindows.count) windows")
}

@Sendable func compositeFrameLoop(allWindows: [CompositeWindow], canvasWidth: Int, canvasHeight: Int, content: SCShareableContent) async {
    // 1. 逐窗口截图（async，串行）
    var snapshots: [(image: CGImage, slotX: Int, slotY: Int, slotW: Int, slotH: Int)] = []
    for entry in allWindows {
        guard let window = findScWindow(
            windowId: entry.windowId,
            appBundleId: "",
            windowBounds: entry.windowBounds,
            content: content
        ) else { continue }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let screenshotConfig = SCStreamConfiguration()
        let crop = entry.cropRect
        let sw = Int(crop.width.rounded())
        let sh = Int(crop.height.rounded())
        guard sw > 0 && sh > 0 else { return }
        screenshotConfig.width = max(1, entry.outputWidth ?? sw)
        screenshotConfig.height = max(1, entry.outputHeight ?? sh)
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: screenshotConfig
            )
        } catch {
            stderrLine("zterm remote window screenshot failed window=\(entry.windowId): \(String(describing: error))")
            return
        }
        let imgWidth = image.width
        let imgHeight = image.height
        guard imgWidth > 0, imgHeight > 0 else { continue }
        snapshots.append((
            image: image,
            slotX: Int(entry.offsetX.rounded()),
            slotY: Int(entry.offsetY.rounded()),
            slotW: min(entry.outputWidth ?? Int(entry.cropRect.width.rounded()), imgWidth),
            slotH: min(entry.outputHeight ?? Int(entry.cropRect.height.rounded()), imgHeight)
        ))
    }
    // 2. 同步合成（无 await）；Data(count:) 零填充
    var canvas = Data(count: canvasWidth * canvasHeight * 4)
    for snap in snapshots {
        guard let provider = snap.image.dataProvider, let pixelData = provider.data else { continue }
        let bytes = pixelData as Data
        let bpr = snap.image.bytesPerRow
        for y in 0..<snap.slotH {
            let srcRow = y * bpr
            let dstRow = ((snap.slotY + y) * canvasWidth + snap.slotX) * 4
            if dstRow + snap.slotW * 4 <= canvas.count {
                canvas.replaceSubrange(
                    dstRow..<(dstRow + snap.slotW * 4),
                    with: bytes[srcRow..<(srcRow + snap.slotW * 4)]
                )
            }
        }
    }
    writeFrame(rgba: canvas, width: canvasWidth, height: canvasHeight)
}

func startSingleWindowCapture(config: CaptureConfig, content: SCShareableContent) async throws {
    // 统一走 SCScreenshotManager 逐帧截图（与组合模式相同路径）：
    // macOS 26 上 SCStream 单窗口 capture 实测卡死不出帧（只发首帧），
    // SCScreenshotManager.captureImage 无此问题（组合模式已验证可靠）。
    compositeStopped = false
    captureLoopGeneration += 1
    let generation = captureLoopGeneration
    singleWindowCapture = CompositeWindow(
        windowId: config.windowId,
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        offsetX: 0,
        offsetY: 0,
        outputWidth: nil,
        outputHeight: nil
    )
    let timerQueue = DispatchQueue(label: "zterm.remote-window.single.timer")
    timerQueue.asyncAfter(deadline: .now() + 0.05) {
        Task { @MainActor in
            while !compositeStopped && generation == captureLoopGeneration {
                guard let windowEntry = singleWindowCapture else {
                    break
                }
                await compositeFrameLoop(
                    allWindows: [windowEntry],
                    canvasWidth: Int(windowEntry.cropRect.width.rounded()),
                    canvasHeight: Int(windowEntry.cropRect.height.rounded()),
                    content: content
                )
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }
    stderrLine("zterm remote window single capture started (SCScreenshotManager): \(config.windowId)")
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
                        // 组合模式更新：停旧 CGWindowList 循环并按新窗口列表重建
                        compositeStopped = true
                        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                        try await startCompositeCapture(
                            config: CaptureConfig(
                                windowId: command.windowId,
                                appBundleId: config.appBundleId,
                                title: config.title,
                                windowBounds: config.windowBounds,
                                cropRect: config.cropRect,
                                frameRate: config.frameRate,
                                queueDepth: config.queueDepth,
                                compositeWindows: compositeWindows,
                                canvasWidth: canvasWidth,
                                canvasHeight: canvasHeight,
                                outputWidth: command.outputWidth,
                                outputHeight: command.outputHeight
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
                        guard !activeStreams.isEmpty || singleWindowCapture != nil else {
                            throw NSError(domain: "RemoteWindowCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "capture stream is not active"])
                        }
                        if activeStreams.isEmpty {
                            // 单窗口切换：启动时 SCShareableContent 快照不含 capture 启动后新出现的窗口，
                            // 旧路径直接换 target 变量会输出全黑帧且 ACK ok:true（假阳性）。
                            // 对齐组合分支：重枚举 content、验证目标窗口真实存在、重建单窗口循环。
                            compositeStopped = true
                            let freshContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                            guard findScWindow(
                                windowId: command.windowId,
                                appBundleId: "",
                                windowBounds: command.windowBounds,
                                content: freshContent
                            ) != nil else {
                                writeCaptureUpdate(
                                    seq: command.seq,
                                    ok: false,
                                    error: "target window not found in fresh shareable content"
                                )
                                return
                            }
                            try await startSingleWindowCapture(
                                config: CaptureConfig(
                                    windowId: command.windowId,
                                    appBundleId: config.appBundleId,
                                    title: config.title,
                                    windowBounds: command.windowBounds,
                                    cropRect: command.cropRect,
                                    frameRate: config.frameRate,
                                    queueDepth: config.queueDepth,
                                    compositeWindows: nil,
                                    canvasWidth: nil,
                                    canvasHeight: nil,
                                    outputWidth: nil,
                                    outputHeight: nil
                                ),
                                content: freshContent
                            )
                            writeCaptureUpdate(
                                seq: command.seq,
                                ok: true,
                                width: max(1, Int(command.cropRect.width.rounded())),
                                height: max(1, Int(command.cropRect.height.rounded()))
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

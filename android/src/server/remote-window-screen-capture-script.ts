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
    let mainOffsetX: Double?
    let mainOffsetY: Double?
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
    let mainOffsetX: Double?
    let mainOffsetY: Double?
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

func hasScreenCapturePermission() -> Bool {
    CGPreflightScreenCaptureAccess()
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

func makeStreamConfiguration(
    entry: CompositeWindow,
    frameRate: Int,
    queueDepth: Int
) -> SCStreamConfiguration {
    let streamConfiguration = SCStreamConfiguration()
    streamConfiguration.capturesAudio = false
    streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
    streamConfiguration.queueDepth = max(3, min(3, queueDepth))
    streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, frameRate)))
    // SCStream natively scales the captured window to width x height. Use
    // outputWidth/outputHeight (the canvas slot size from the layout planner)
    // so each frame already matches its composite slot; otherwise the blit
    // would crop only the top-left corner of a larger native frame.
    let outputW = entry.outputWidth ?? Int(entry.cropRect.width.rounded())
    let outputH = entry.outputHeight ?? Int(entry.cropRect.height.rounded())
    streamConfiguration.width = max(1, outputW)
    streamConfiguration.height = max(1, outputH)
    streamConfiguration.sourceRect = CGRect(
        // ScreenCaptureKit sourceRect is expressed in display coordinates,
        // not coordinates local to the filtered window. Keeping the absolute
        // crop rect is required when the window is offset from display origin.
        x: entry.cropRect.x,
        y: entry.cropRect.y,
        width: max(1, entry.cropRect.width),
        height: max(1, entry.cropRect.height)
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
        let copyWidth = min(slot.width, frameWidth, max(0, width - slot.x))
        let copyHeight = min(slot.height, frameHeight, max(0, height - slot.y))
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

        do {
            if let canvas = canvas {
                canvas.blit(index: canvasIndex, rgba: rgba, frameWidth: width, frameHeight: height)
            } else {
                writeFrame(rgba: rgba, width: width, height: height)
            }
        } catch {
            stderrLine("remote window capture frame blit failed: " + error.localizedDescription)
            return
        }
        emitted += 1
    }
}

func startRemoteWindowCaptureProcess() {
    if CommandLine.arguments.dropFirst().contains("--permission-probe") {
        guard hasScreenCapturePermission() else {
            stderrLine("Screen Recording permission is required; grant zterm-daemon in macOS Privacy settings")
            exit(5)
        }
        exit(0)
    }

    let env = ProcessInfo.processInfo.environment
    guard let configJson = env["ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG"],
          let configData = configJson.data(using: .utf8) else {
        stderrLine("missing ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG")
        exit(2)
    }

    var config: CaptureConfig
    do {
        config = try JSONDecoder().decode(CaptureConfig.self, from: configData)
    } catch {
        stderrLine("invalid capture config: " + String(describing: error))
        exit(2)
    }

    guard hasScreenCapturePermission() else {
        stderrLine("Screen Recording permission is required; grant zterm-daemon in macOS Privacy settings")
        exit(5)
    }
    let sampleQueue = DispatchQueue(label: "zterm.remote-window.capture.sample")
    var activeStreams: [SCStream] = []
    var activeOutputs: [SCStreamOutput] = []

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

@Sendable func startCapture(config: CaptureConfig) async throws {
    for stream in activeStreams {
        try? await stream.stopCapture()
    }
    activeStreams.removeAll()
    activeOutputs.removeAll()

    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let mainWindow = CompositeWindow(
        windowId: config.windowId,
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        offsetX: config.mainOffsetX ?? 0,
        offsetY: config.mainOffsetY ?? 0,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight
    )
    let compositeWindows = config.compositeWindows ?? []
    let allWindows = [mainWindow] + compositeWindows
    let canvasWidth = config.canvasWidth ?? max(1, Int(mainWindow.cropRect.width.rounded()))
    let canvasHeight = config.canvasHeight ?? max(1, Int(mainWindow.cropRect.height.rounded()))
    let compositeCanvas = compositeWindows.isEmpty ? nil : CompositeCanvas(
        width: canvasWidth,
        height: canvasHeight,
        offsets: allWindows.map { entry in
            (
                x: Int(entry.offsetX.rounded()),
                y: Int(entry.offsetY.rounded()),
                width: max(1, entry.outputWidth ?? Int(entry.cropRect.width.rounded())),
                height: max(1, entry.outputHeight ?? Int(entry.cropRect.height.rounded()))
            )
        }
    )

    for (index, entry) in allWindows.enumerated() {
        guard let window = findScWindow(
            windowId: entry.windowId,
            appBundleId: index == 0 ? config.appBundleId : "",
            windowBounds: entry.windowBounds,
            content: content
        ) else {
            throw NSError(
                domain: "RemoteWindowCapture",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "remote window capture target not found in SCShareableContent: \(entry.windowId)"]
            )
        }
        guard let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else {
            throw NSError(
                domain: "RemoteWindowCapture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "remote window capture display not found for frame: \(NSStringFromRect(window.frame))"]
            )
        }

        let filter = SCContentFilter(display: display, including: [window])
        let streamConfiguration = makeStreamConfiguration(
            entry: entry,
            frameRate: config.frameRate,
            queueDepth: config.queueDepth
        )
        let output = FrameOutput(canvas: compositeCanvas, canvasIndex: index)
        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        activeStreams.append(stream)
        activeOutputs.append(output)
    }

    stderrLine("zterm remote window capture started (SCStream): \(allWindows.count) windows")
}

@Sendable func updateCapture(config: CaptureConfig) async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let mainWindow = CompositeWindow(
        windowId: config.windowId,
        windowBounds: config.windowBounds,
        cropRect: config.cropRect,
        offsetX: config.mainOffsetX ?? 0,
        offsetY: config.mainOffsetY ?? 0,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight
    )
    let allWindows = [mainWindow] + (config.compositeWindows ?? [])
    guard allWindows.count == activeStreams.count else {
        throw NSError(
            domain: "RemoteWindowCapture",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "in-place capture update cannot change stream lane count"]
        )
    }
    for (index, entry) in allWindows.enumerated() {
        guard let window = findScWindow(
            windowId: entry.windowId,
            appBundleId: index == 0 ? config.appBundleId : "",
            windowBounds: entry.windowBounds,
            content: content
        ) else {
            throw NSError(
                domain: "RemoteWindowCapture",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "remote window capture target not found in SCShareableContent: \(entry.windowId)"]
            )
        }
        guard let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else {
            throw NSError(
                domain: "RemoteWindowCapture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "remote window capture display not found for frame: \(NSStringFromRect(window.frame))"]
            )
        }
        let filter = SCContentFilter(display: display, including: [window])
        let streamConfiguration = makeStreamConfiguration(
            entry: entry,
            frameRate: config.frameRate,
            queueDepth: config.queueDepth
        )
        try await activeStreams[index].updateContentFilter(filter)
        try await activeStreams[index].updateConfiguration(streamConfiguration)
    }
    stderrLine("zterm remote window capture updated in place (SCStream): \(allWindows.count) windows")
}

    // SCStream setup must not depend on the AppKit main run loop. This process
    // only calls dispatchMain(), so a bare Task would never be scheduled.
    DispatchQueue.global(qos: .userInitiated).async {
        Task {
        do {
            try await startCapture(config: config)
        } catch {
            stderrLine("ScreenCaptureKit capture start failed: " + String(describing: error))
            exit(4)
        }
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
                DispatchQueue.global(qos: .userInitiated).async {
                    Task {
                    do {
                        let nextConfig = CaptureConfig(
                            windowId: command.windowId,
                            appBundleId: config.appBundleId,
                            title: config.title,
                            windowBounds: command.windowBounds,
                            cropRect: command.cropRect,
                            frameRate: command.frameRate,
                            queueDepth: command.queueDepth,
                            compositeWindows: command.compositeWindows,
                            canvasWidth: command.canvasWidth,
                            canvasHeight: command.canvasHeight,
                            mainOffsetX: command.mainOffsetX,
                            mainOffsetY: command.mainOffsetY,
                            outputWidth: command.outputWidth,
                            outputHeight: command.outputHeight
                        )
                        try await updateCapture(config: nextConfig)
                        config = nextConfig
                        writeCaptureUpdate(
                            seq: command.seq,
                            ok: true,
                            width: nextConfig.canvasWidth ?? max(1, Int(nextConfig.cropRect.width.rounded())),
                            height: nextConfig.canvasHeight ?? max(1, Int(nextConfig.cropRect.height.rounded()))
                        )
                    } catch {
                        writeCaptureUpdate(seq: command.seq, ok: false, error: error.localizedDescription)
                    }
                    }
                }
            } catch {
                stderrLine("ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE invalid command: " + error.localizedDescription)
            }
        }
    }

    dispatchMain()
}

func startRemoteWindowValidateProcess(windowIds: [String]) {
    guard hasScreenCapturePermission() else {
        stderrLine("Screen Recording permission is required; grant zterm-daemon in macOS Privacy settings")
        exit(5)
    }

    DispatchQueue.global(qos: .userInitiated).async {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let missingIds = windowIds.filter { windowId in
                    guard let numericId = UInt32(windowId) else { return true }
                    return !content.windows.contains(where: { $0.windowID == numericId })
                }
                if !missingIds.isEmpty {
                    stderrLine("remote window target not found in fresh SCShareableContent: \(missingIds.joined(separator: ", "))")
                    exit(4)
                }
                for windowId in windowIds {
                    guard let numericId = UInt32(windowId),
                          let window = content.windows.first(where: { $0.windowID == numericId }) else {
                        continue
                    }
                    guard content.displays.first(where: { $0.frame.contains(window.frame) }) != nil else {
                        let frame = window.frame
                        let frameDescription = "x:\(frame.origin.x),y:\(frame.origin.y),width:\(frame.size.width),height:\(frame.size.height)"
                        stderrLine("remote window target frame is outside display for window \(windowId): frame={\(frameDescription)}")
                        exit(6)
                    }
                }
                exit(0)
            } catch {
                stderrLine("remote window target validation failed: " + String(describing: error))
                exit(3)
            }
        }
    }

    dispatchMain()
}
`;

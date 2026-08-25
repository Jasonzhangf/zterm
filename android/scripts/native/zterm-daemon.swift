import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

struct CaptureRect {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

func parsePositiveInt(_ value: String, label: String) -> Int {
  guard let parsed = Int(value), parsed > 0 else {
    fail("invalid \(label): \(value)", code: 64)
  }
  return parsed
}

func parseRect(_ value: String) -> CaptureRect {
  let parts = value.split(separator: ",").map(String.init)
  guard parts.count == 4 else {
    fail("invalid capture rect: \(value)", code: 64)
  }
  guard
    let x = Int(parts[0]),
    let y = Int(parts[1])
  else {
    fail("invalid capture rect origin: \(value)", code: 64)
  }
  return CaptureRect(
    x: x,
    y: y,
    width: parsePositiveInt(parts[2], label: "capture rect width"),
    height: parsePositiveInt(parts[3], label: "capture rect height")
  )
}

func writeScreenCapturePNG(_ image: CGImage, to outputPath: String) throws {
  let bitmapRep = NSBitmapImageRep(cgImage: image)
  guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
    throw NSError(
      domain: "ZtermDaemonScreenCapture",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "could not encode screen capture as PNG"]
    )
  }
  try pngData.write(to: URL(fileURLWithPath: outputPath))
}

@Sendable func captureScreenWithScreenCaptureKit(
  windowId: String?,
  rect: CaptureRect?
) async throws -> CGImage {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

  if let windowId = windowId {
    let requestedWindowId = UInt32(parsePositiveInt(windowId, label: "window id"))
    guard let window = content.windows.first(where: { $0.windowID == requestedWindowId }) else {
      throw NSError(
        domain: "ZtermDaemonScreenCapture",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "capture-screen window not found in SCShareableContent: \(windowId)"]
      )
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int(window.frame.width.rounded()))
    configuration.height = max(1, Int(window.frame.height.rounded()))
    configuration.showsCursor = false
    configuration.capturesAudio = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
  }

  if let rect = rect {
    let requestedRect = CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
    guard let display = content.displays.first(where: { $0.frame.contains(requestedRect) }) else {
      throw NSError(
        domain: "ZtermDaemonScreenCapture",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "capture-screen rectangle is outside one display: \(NSStringFromRect(requestedRect))"]
      )
    }

    let filter = SCContentFilter(
      display: display,
      excludingApplications: [],
      exceptingWindows: []
    )
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = CGRect(
      x: requestedRect.minX - display.frame.minX,
      y: requestedRect.minY - display.frame.minY,
      width: requestedRect.width,
      height: requestedRect.height
    )
    configuration.width = max(1, Int(requestedRect.width.rounded()))
    configuration.height = max(1, Int(requestedRect.height.rounded()))
    configuration.showsCursor = false
    configuration.capturesAudio = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
  }

  throw NSError(
    domain: "ZtermDaemonScreenCapture",
    code: 64,
    userInfo: [NSLocalizedDescriptionKey: "capture-screen requires exactly one of --window-id or --rect"]
  )
}

func captureScreen(to outputPath: String, windowId: String? = nil, rect: CaptureRect? = nil) {
  // The one-shot path stays inside the installed daemon binary. Missing permission
  // is an explicit failure; there is no system helper or second executable.
  guard hasScreenCapturePermission() else {
    fail("Screen Recording permission is required; grant zterm-daemon in macOS Privacy settings", code: 5)
  }

  if windowId != nil && rect != nil {
    fail("capture-screen accepts only one of --window-id or --rect", code: 64)
  }
  if windowId == nil && rect == nil {
    fail("capture-screen requires exactly one of --window-id or --rect", code: 64)
  }

  let completion = DispatchSemaphore(value: 0)
  DispatchQueue.global(qos: .userInitiated).async {
    Task {
      do {
        let image = try await captureScreenWithScreenCaptureKit(windowId: windowId, rect: rect)
        try writeScreenCapturePNG(image, to: outputPath)
        completion.signal()
      } catch {
        FileHandle.standardError.write(Data(("zterm-daemon screen capture failed: " + error.localizedDescription + "\n").utf8))
        exit(4)
      }
    }
  }
  completion.wait()
}

@main
struct ZtermDaemonEntry {
  static func main() {
    let args = CommandLine.arguments
    if args.dropFirst().first == "--permission-probe" {
      guard hasScreenCapturePermission() else {
        fail("Screen Recording permission is required; grant zterm-daemon in macOS Privacy settings", code: 5)
      }
      exit(0)
    }

    if args.count >= 3 && args[1] == "capture-screen" {
      var windowId: String?
      var rect: CaptureRect?
      var index = 3
      while index < args.count {
        let option = args[index]
        if option == "--window-id" {
          guard index + 1 < args.count else {
            fail("missing --window-id value", code: 64)
          }
          windowId = args[index + 1]
          index += 2
          continue
        }
        if option == "--rect" {
          guard index + 1 < args.count else {
            fail("missing --rect value", code: 64)
          }
          rect = parseRect(args[index + 1])
          index += 2
          continue
        }
        fail("unknown capture-screen option: \(option)", code: 64)
      }
      captureScreen(to: args[2], windowId: windowId, rect: rect)
      exit(0)
    }

    if args.count == 2 && args[1] == "remote-window-capture" {
      startRemoteWindowCaptureProcess()
    }

    fail("usage: zterm-daemon --permission-probe | capture-screen <output.png> [...] | remote-window-capture", code: 64)
  }
}

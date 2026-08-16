import Foundation

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

func captureScreen(to outputPath: String, windowId: String? = nil, rect: CaptureRect? = nil) {
  if windowId != nil && rect != nil {
    fail("capture-screen accepts only one of --window-id or --rect", code: 64)
  }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  var arguments = ["-x"]
  if let windowId = windowId {
    _ = parsePositiveInt(windowId, label: "window id")
    arguments.append("-o")
    arguments.append("-l\(windowId)")
  }
  if let rect = rect {
    arguments.append("-R\(rect.x),\(rect.y),\(rect.width),\(rect.height)")
  }
  arguments.append(outputPath)
  process.arguments = arguments

  let stderrPipe = Pipe()
  process.standardError = stderrPipe

  do {
    try process.run()
  } catch {
    fail("zterm-daemon could not start system screenshot capture: \(error)")
  }

  process.waitUntilExit()
  if process.terminationStatus != 0 {
    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
    let stderrText = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    fail(stderrText.isEmpty ? "zterm-daemon screenshot capture failed" : stderrText, code: process.terminationStatus)
  }
}

let args = CommandLine.arguments
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

fail("usage: zterm-daemon capture-screen <output.png> [--window-id <id> | --rect <x,y,w,h>]", code: 64)

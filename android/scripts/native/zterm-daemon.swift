import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func captureScreen(to outputPath: String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", outputPath]

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
if args.count == 3 && args[1] == "capture-screen" {
  captureScreen(to: args[2])
  exit(0)
}

fail("usage: zterm-daemon capture-screen <output.png>", code: 64)

import { spawn, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';
import type {
  ClientMessage,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
  ServerMessage,
} from '../src/lib/types';

const { RTCPeerConnection, RTCSessionDescription } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
};

const DAEMON_WS_URL = process.env.ZTERM_REMOTE_WINDOW_PROBE_WS_URL || 'ws://127.0.0.1:3333';
const PROBE_TITLE = `ZTERM_REMOTE_INPUT_PROBE_${Date.now()}`;
const REQUEST_PREFIX = `rw-live-input-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-remote-window-live-input-'));
const swiftPath = join(tempRoot, 'RemoteWindowInputProbe.swift');
const appPath = join(tempRoot, 'RemoteWindowInputProbe.app');
const appContentsPath = join(appPath, 'Contents');
const appMacosPath = join(appContentsPath, 'MacOS');
const probeExecutablePath = join(appMacosPath, 'RemoteWindowInputProbe');
const appPlistPath = join(appContentsPath, 'Info.plist');
const probeBundleId = `cc.codewhisper.zterm.RemoteWindowInputProbe.${Date.now()}`;

const swiftSource = String.raw`
import AppKit
import Foundation

func probePrint(_ line: String) {
    print(line)
    fflush(stdout)
}

final class ProbeView: NSView {
    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
    }

    override func mouseDown(with event: NSEvent) {
        probePrint("PROBE_MOUSE_DOWN")
    }

    override func mouseUp(with event: NSEvent) {
        probePrint("PROBE_MOUSE_UP")
    }

    override func scrollWheel(with event: NSEvent) {
        probePrint("PROBE_SCROLL dx=\(Int(event.scrollingDeltaX.rounded())) dy=\(Int(event.scrollingDeltaY.rounded()))")
    }

    override func keyDown(with event: NSEvent) {
        probePrint("PROBE_KEY_DOWN chars=\(event.charactersIgnoringModifiers ?? "")")
    }

    override func keyUp(with event: NSEvent) {
        probePrint("PROBE_KEY_UP chars=\(event.charactersIgnoringModifiers ?? "")")
    }
}

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let title = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ZTERM_REMOTE_INPUT_PROBE"
        let rect = NSRect(x: 220, y: 220, width: 520, height: 372)
        let window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentView = ProbeView(frame: NSRect(x: 0, y: 0, width: 520, height: 372))
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(window.contentView)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        probePrint("PROBE_READY title=\(title) pid=\(getpid())")
    }
}

let app = NSApplication.shared
let delegate = ProbeDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
`;

function requestId(suffix: string) {
  return `${REQUEST_PREFIX}-${suffix}`;
}

function fail(message: string): never {
  throw new Error(message);
}

function send(ws: WebSocket, message: ClientMessage) {
  ws.send(JSON.stringify(message));
}

async function waitForWebSocketOpen(ws: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket open timeout: ${DAEMON_WS_URL}`));
    }, 8000);
    function cleanup() {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
    }
    function onOpen() {
      cleanup();
      resolve();
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

async function waitForServerMessage(
  messages: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
  label: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    for (; cursor < messages.length; cursor += 1) {
      const message = messages[cursor]!;
      if (predicate(message)) {
        return message;
      }
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForProbeLine(lines: string[], marker: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (line.includes(marker)) {
        return line;
      }
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for probe marker ${marker}; seen=${JSON.stringify(lines)}`);
}

function countProbeLines(lines: string[], marker: string) {
  return lines.filter((line) => line.includes(marker)).length;
}

async function waitForProbeLineCount(lines: string[], marker: string, minCount: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = countProbeLines(lines, marker);
    if (count >= minCount) {
      return count;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for probe marker ${marker} count ${minCount}; seen=${JSON.stringify(lines)}`);
}

function targetCenter(target: RemoteWindowStreamTargetManifest) {
  const rect = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    fail(`target has invalid rect: ${target.streamTargetId}`);
  }
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    width: rect.width,
    height: rect.height,
  };
}

async function sendInputAndRequireAccepted(
  ws: WebSocket,
  messages: ServerMessage[],
  payload: RemoteWindowInputEventPayload,
) {
  send(ws, { type: 'remote-window-input', payload });
  const response = await waitForServerMessage(
    messages,
    (message) => (
      (message.type === 'remote-window-input-result' || message.type === 'remote-window-error')
      && 'requestId' in message.payload
      && message.payload.requestId === payload.requestId
    ),
    payload.requestId,
  );
  if (response.type !== 'remote-window-input-result' || response.payload.accepted !== true) {
    throw new Error(`remote input rejected: ${JSON.stringify(response)}`);
  }
  return response.payload;
}

async function main() {
  writeFileSync(swiftPath, swiftSource);
  mkdirSync(appMacosPath, { recursive: true });
  writeFileSync(appPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>RemoteWindowInputProbe</string>
  <key>CFBundleIdentifier</key>
  <string>${probeBundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>RemoteWindowInputProbe</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
`);
  const compile = spawnSync('swiftc', [swiftPath, '-o', probeExecutablePath], { encoding: 'utf8' });
  if (compile.status !== 0) {
    fail(`swiftc probe compile failed: ${compile.stderr || compile.stdout}`);
  }

  const probe = spawn(probeExecutablePath, [PROBE_TITLE], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const probeLines: string[] = [];
  let probeStdoutBuffer = '';
  let probeStderr = '';
  probe.stdout.setEncoding('utf8');
  probe.stderr.setEncoding('utf8');
  probe.stdout.on('data', (chunk: string) => {
    probeStdoutBuffer += chunk;
    const parts = probeStdoutBuffer.split(/\r?\n/);
    probeStdoutBuffer = parts.pop() || '';
    for (const part of parts) {
      if (part.trim()) {
        probeLines.push(part.trim());
      }
    }
  });
  probe.stderr.on('data', (chunk: string) => {
    probeStderr += chunk;
  });

  const cleanup = async () => {
    if (!probe.killed) {
      probe.kill('SIGTERM');
      await delay(300);
      if (probe.exitCode === null) {
        probe.kill('SIGKILL');
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    const readyLine = await waitForProbeLine(probeLines, 'PROBE_READY', 20_000);
    const ws = new WebSocket(DAEMON_WS_URL);
    const messages: ServerMessage[] = [];
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString('utf8')) as ServerMessage);
    });
    await waitForWebSocketOpen(ws);

    const catalogRequestId = requestId('catalog');
    send(ws, { type: 'remote-window-targets-request', payload: { requestId: catalogRequestId } });
    const catalog = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-targets-response' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === catalogRequestId
      ),
      'remote window target catalog',
    );
    if (catalog.type !== 'remote-window-targets-response') {
      fail(`catalog failed: ${JSON.stringify(catalog)}`);
    }
    const target = catalog.payload.targets.find((candidate) => (
      candidate.videoTarget.kind === 'app-window'
      && candidate.videoTarget.title.includes(PROBE_TITLE)
      && candidate.streamMode === 'interactive'
      && candidate.inputRoute === 'os-event'
    ));
    if (!target) {
      fail(`probe target not found; targetCount=${catalog.payload.targets.length}; ready=${readyLine}; stderr=${probeStderr}`);
    }

    const peerConnection = new RTCPeerConnection({ iceServers: [] });
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    let trackSeen = false;
    peerConnection.ontrack = () => {
      trackSeen = true;
    };
    const streamId = requestId('stream');
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      const candidate = event.candidate.toJSON();
      if (!candidate.candidate) {
        return;
      }
      send(ws, {
        type: 'remote-window-stream-ice-candidate',
        payload: {
          requestId: requestId('candidate'),
          streamId,
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            usernameFragment: candidate.usernameFragment ?? null,
          },
        },
      });
    };

    const offer = await peerConnection.createOffer();
    if (offer.type !== 'offer') {
      fail(`unexpected remote-window live probe offer type: ${offer.type}`);
    }
    await peerConnection.setLocalDescription(offer);
    send(ws, {
      type: 'remote-window-stream-start-request',
      payload: {
        requestId: requestId('start'),
        streamId,
        target,
        offer: {
          type: offer.type,
          sdp: offer.sdp || '',
        },
        videoBitrate: {
          preset: '2mbps',
          bitrateMbps: 2,
          maxBitrateBps: 2_000_000,
          maxFrameRateFps: 5,
        },
      },
    });
    const started = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-stream-started' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === requestId('start')
      ),
      'remote window stream start',
      20_000,
    );
    if (started.type !== 'remote-window-stream-started') {
      fail(`stream start failed: ${JSON.stringify(started)}`);
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(started.payload.answer));
    await waitForServerMessage(
      messages,
      (message) => (
        message.type === 'remote-window-stream-status'
        && message.payload.streamId === streamId
        && message.payload.phase === 'streaming'
      ),
      'remote window stream status',
      20_000,
    );

    const center = targetCenter(target);
    const baseInput = {
      streamId,
      targetId: target.streamTargetId,
      clientSentAt: Date.now(),
    };
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('focus'),
      event: { kind: 'focus' },
    });
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('pointer-down'),
      clientSentAt: Date.now(),
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 1,
        button: 'left',
        buttons: 1,
        x: center.x,
        y: center.y,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    });
    await waitForProbeLine(probeLines, 'PROBE_MOUSE_DOWN');
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('pointer-up'),
      clientSentAt: Date.now(),
      event: {
        kind: 'pointer',
        phase: 'up',
        pointerId: 1,
        button: 'left',
        buttons: 0,
        x: center.x,
        y: center.y,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    });
    await waitForProbeLine(probeLines, 'PROBE_MOUSE_UP');
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('scroll'),
      clientSentAt: Date.now(),
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 96,
        x: center.x,
        y: center.y,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    });
    await waitForProbeLineCount(probeLines, 'PROBE_SCROLL', 1);
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('gesture'),
      clientSentAt: Date.now(),
      event: {
        kind: 'gesture',
        gesture: 'swipe',
        phase: 'end',
        unit: 'pixel',
        pointerId: 1,
        startX: center.x,
        startY: center.y + Math.round(center.height * 0.1),
        x: center.x,
        y: center.y - Math.round(center.height * 0.1),
        startNormalizedX: 0.5,
        startNormalizedY: 0.6,
        normalizedX: 0.5,
        normalizedY: 0.4,
        deltaX: 0,
        deltaY: Math.round(center.height * 0.2),
        durationMs: 180,
        velocityX: 0,
        velocityY: Math.round(center.height * 0.2 / 0.18),
      },
    });
    await waitForProbeLineCount(probeLines, 'PROBE_SCROLL', 2);
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('key-down'),
      clientSentAt: Date.now(),
      event: {
        kind: 'key',
        phase: 'down',
        key: 'z',
        code: 'KeyZ',
        text: 'z',
      },
    });
    await waitForProbeLine(probeLines, 'PROBE_KEY_DOWN');
    await sendInputAndRequireAccepted(ws, messages, {
      ...baseInput,
      requestId: requestId('key-up'),
      clientSentAt: Date.now(),
      event: {
        kind: 'key',
        phase: 'up',
        key: 'z',
        code: 'KeyZ',
        text: 'z',
      },
    });
    await waitForProbeLine(probeLines, 'PROBE_KEY_UP');

    send(ws, {
      type: 'remote-window-stream-stop-request',
      payload: {
        requestId: requestId('stop'),
        streamId,
      },
    });
    const stopped = await waitForServerMessage(
      messages,
      (message) => (
        message.type === 'remote-window-stream-status'
        && message.payload.streamId === streamId
        && message.payload.phase === 'stopped'
      ),
      'remote window stream stop',
    );
    if (stopped.type !== 'remote-window-stream-status') {
      fail(`unexpected stop response: ${JSON.stringify(stopped)}`);
    }
    peerConnection.close();
    ws.close();

    console.log(JSON.stringify({
      ok: true,
      daemonWsUrl: DAEMON_WS_URL,
      targetId: target.streamTargetId,
      targetTitle: target.videoTarget.title,
      capture: started.payload.capture,
      trackSeen,
      stopped: stopped.payload,
      probeLines,
    }, null, 2));
  } finally {
    await cleanup();
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  rmSync(tempRoot, { recursive: true, force: true });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

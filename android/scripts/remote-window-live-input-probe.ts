import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const DAEMON_WS_URL = process.env.ZTERM_REMOTE_WINDOW_PROBE_WS_URL || 'ws://127.0.0.1:3333';
const USE_MUX = process.env.ZTERM_REMOTE_WINDOW_PROBE_MUX === '1';
const BURST_INPUT = process.env.ZTERM_REMOTE_WINDOW_PROBE_BURST === '1';
const PROBE_MUX_SESSION = process.env.ZTERM_REMOTE_WINDOW_PROBE_SESSION || 'zterm';
const DEFOCUS_BUNDLE_ID = (process.env.ZTERM_REMOTE_WINDOW_PROBE_DEFOCUS_BUNDLE || 'com.apple.finder').trim();
const CLIENT_CLOCK_OFFSET_MS = Number.parseInt(
  process.env.ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS || '0',
  10,
) || 0;
const PROBE_RUN_ID = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const PROBE_MUX_CHANNEL_ID = `rw-live-input-channel-${PROBE_RUN_ID}`;
const PROBE_MUX_CLIENT_ID = `rw-live-input-client-${PROBE_RUN_ID}`;
const PROBE_TITLE = `ZTERM_REMOTE_INPUT_PROBE_${PROBE_RUN_ID}`;
const REQUEST_PREFIX = `rw-live-input-${PROBE_RUN_ID}`;
const KEEP_TEMP = process.env.ZTERM_REMOTE_WINDOW_PROBE_KEEP_TMP === '1';
const REMOTE_WINDOW_LIVE_CATALOG_TIMEOUT_MS = 30_000;
const REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS = 40_000;
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-remote-window-live-input-'));
const probeSourcePath = join(tempRoot, 'RemoteWindowInputProbe.m');
const probeLogPath = join(tempRoot, 'probe-events.log');
const appPath = join(tempRoot, 'RemoteWindowInputProbe.app');
const appContentsPath = join(appPath, 'Contents');
const appMacosPath = join(appContentsPath, 'MacOS');
const probeExecutablePath = join(appMacosPath, 'RemoteWindowInputProbe');
const appPlistPath = join(appContentsPath, 'Info.plist');
const probeBundleId = `cc.codewhisper.zterm.RemoteWindowInputProbe.${PROBE_RUN_ID.replace(/-/g, '.')}`;

const objcSource = String.raw`
#import <Cocoa/Cocoa.h>
#include <math.h>
#include <unistd.h>

static NSString *ProbeLogPath = @"";

static void ProbePrint(NSString *line) {
    printf("%s\n", [line UTF8String]);
    fflush(stdout);
    if ([ProbeLogPath length] == 0) {
        return;
    }
    NSData *data = [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:ProbeLogPath];
    if (handle != nil) {
        [handle seekToEndOfFile];
        [handle writeData:data];
        [handle closeFile];
    } else {
        [data writeToFile:ProbeLogPath atomically:YES];
    }
}

@interface ProbeView : NSView
@property(nonatomic, strong) NSTimer *animationTimer;
@property(nonatomic, assign) NSInteger animationTick;
@end

@implementation ProbeView
- (BOOL)acceptsFirstResponder {
    return YES;
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    [[self window] makeFirstResponder:self];
    if (self.animationTimer == nil) {
        self.animationTimer = [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
            self.animationTick += 1;
            [self setNeedsDisplay:YES];
            [self displayIfNeeded];
            [[self window] displayIfNeeded];
            if (self.animationTick % 10 == 0) {
                ProbePrint([NSString stringWithFormat:@"PROBE_ANIMATION_TICK %ld", (long)self.animationTick]);
            }
        }];
    }
}

- (void)dealloc {
    [self.animationTimer invalidate];
}

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];
    CGFloat phase = (CGFloat)(self.animationTick % 60) / 60.0;
    NSColor *background = [NSColor colorWithCalibratedRed:(0.12 + phase * 0.45)
                                                    green:(0.20 + (1.0 - phase) * 0.35)
                                                     blue:0.42
                                                    alpha:1.0];
    [background setFill];
    NSRectFill(self.bounds);
    NSRect pulse = NSMakeRect(24 + phase * 360, 120, 120, 120);
    [[NSColor colorWithCalibratedRed:0.95 green:0.82 blue:0.16 alpha:1.0] setFill];
    NSRectFill(pulse);
    NSString *label = [NSString stringWithFormat:@"FRAME %ld", (long)self.animationTick];
    NSDictionary *attributes = @{
        NSFontAttributeName: [NSFont boldSystemFontOfSize:42],
        NSForegroundColorAttributeName: [NSColor whiteColor]
    };
    [label drawAtPoint:NSMakePoint(32, 300) withAttributes:attributes];
}

- (void)mouseDown:(NSEvent *)event {
    ProbePrint(@"PROBE_MOUSE_DOWN");
}

- (void)mouseDragged:(NSEvent *)event {
    ProbePrint(@"PROBE_MOUSE_DRAGGED");
}

- (void)mouseUp:(NSEvent *)event {
    ProbePrint(@"PROBE_MOUSE_UP");
}

- (void)scrollWheel:(NSEvent *)event {
    ProbePrint([NSString stringWithFormat:@"PROBE_SCROLL dx=%ld dy=%ld",
        lround([event scrollingDeltaX]),
        lround([event scrollingDeltaY])
    ]);
}

- (void)keyDown:(NSEvent *)event {
    NSString *chars = [event charactersIgnoringModifiers] ?: @"";
    ProbePrint([NSString stringWithFormat:@"PROBE_KEY_DOWN chars=%@", chars]);
}

- (void)keyUp:(NSEvent *)event {
    NSString *chars = [event charactersIgnoringModifiers] ?: @"";
    ProbePrint([NSString stringWithFormat:@"PROBE_KEY_UP chars=%@", chars]);
}
@end

@interface ProbeDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, assign) BOOL didCreateWindow;
@end

@implementation ProbeDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    if (self.didCreateWindow) {
        return;
    }
    self.didCreateWindow = YES;
    NSRect rect = NSMakeRect(220, 220, 520, 372);
    ProbeView *view = [[ProbeView alloc] initWithFrame:NSMakeRect(0, 0, 520, 372)];
    self.window = [[NSWindow alloc]
        initWithContentRect:rect
        styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable)
        backing:NSBackingStoreBuffered
        defer:NO
    ];
    [self.window setTitle:self.title];
    [self.window setContentView:view];
    [self.window makeKeyAndOrderFront:nil];
    [self.window makeFirstResponder:view];
    [NSApp activateIgnoringOtherApps:YES];
    ProbePrint([NSString stringWithFormat:@"PROBE_READY title=%@ pid=%d", self.title, getpid()]);
}
@end

static ProbeDelegate *ProbeAppDelegate;

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *title = argc > 1
            ? [NSString stringWithUTF8String:argv[1]]
            : @"ZTERM_REMOTE_INPUT_PROBE";
        ProbeLogPath = argc > 2
            ? [NSString stringWithUTF8String:argv[2]]
            : @"";
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        ProbeAppDelegate = [ProbeDelegate new];
        ProbeAppDelegate.title = title;
        [app setDelegate:ProbeAppDelegate];
        [ProbeAppDelegate applicationDidFinishLaunching:nil];
        [app run];
    }
    return 0;
}
`;

function requestId(suffix: string) {
  return `${REQUEST_PREFIX}-${suffix}`;
}

function fail(message: string): never {
  throw new Error(message);
}

function summarizeQualityUpdate(message: ServerMessage) {
  if (message.type === 'remote-window-stream-quality-result') {
    return {
      accepted: message.payload.status === 'applied',
      videoBitrate: message.payload.appliedVideoBitrate,
      groupBudget: message.payload.appliedGroupBudget,
      error: message.payload.error,
    };
  }
  if (message.type === 'remote-window-error' && message.payload.code === 'remote_window_stream_quality_failed') {
    return {
      accepted: false,
      code: message.payload.code,
      message: message.payload.message,
    };
  }
  fail(`unexpected remote window quality update response: ${JSON.stringify(message)}`);
}

function assertQualityUpdateContract(message: ServerMessage, label: string) {
  if (message.type === 'remote-window-stream-quality-result' && message.payload.status === 'applied') {
    return;
  }
  if (message.type === 'remote-window-error' && message.payload.code === 'remote_window_stream_quality_failed') {
    return;
  }
  fail(`${label} quality update returned invalid response: ${JSON.stringify(message)}`);
}

function appleScriptStringLiteral(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runAppleScript(source: string) {
  const result = spawnSync('osascript', ['-e', source], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`osascript failed: ${result.stderr || result.stdout || source}`);
  }
  return result.stdout.trim();
}

function readFrontmostBundleId() {
  return runAppleScript('tell application "System Events" to get bundle identifier of first application process whose frontmost is true');
}

function readFrontmostPid() {
  const raw = runAppleScript('tell application "System Events" to get unix id of first application process whose frontmost is true');
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid)) {
    fail(`frontmost app pid is invalid: ${raw || 'empty'}`);
  }
  return pid;
}

async function waitForFrontmostBundleId(bundleId: string, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = readFrontmostBundleId();
    if (last === bundleId) {
      return last;
    }
    await delay(50);
  }
  fail(`frontmost app did not become ${bundleId} after ${label}; last=${last || 'unknown'}`);
}

async function waitForFrontmostPid(pid: number, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = readFrontmostPid();
    if (last === pid) {
      return last;
    }
    await delay(50);
  }
  fail(`frontmost app pid did not become ${pid} after ${label}; last=${last ?? 'unknown'}`);
}

async function activateBundleId(bundleId: string) {
  runAppleScript(`tell application id "${appleScriptStringLiteral(bundleId)}" to activate`);
  await waitForFrontmostBundleId(bundleId, `activate ${bundleId}`);
}

async function defocusTargetBeforeRemoteInput(targetPid: number, targetBundleId: string) {
  if (!DEFOCUS_BUNDLE_ID || DEFOCUS_BUNDLE_ID === targetBundleId) {
    return null;
  }
  await activateBundleId(DEFOCUS_BUNDLE_ID);
  const frontmost = {
    bundleId: readFrontmostBundleId(),
    pid: readFrontmostPid(),
  };
  if (frontmost.pid === targetPid) {
    fail(`defocus failed: target pid ${targetPid} is still frontmost before remote focus`);
  }
  return frontmost;
}

function send(ws: WebSocket, message: ClientMessage) {
  if (USE_MUX) {
    ws.send(JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: PROBE_MUX_CHANNEL_ID,
        message,
      },
    }));
    return;
  }
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

async function waitForReceiverTrack(
  peerConnection: RTCPeerConnection,
  messages: ServerMessage[],
  streamId: string,
  hasTrack: () => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const appliedCandidates = new Set<string>();
  while (Date.now() < deadline) {
    for (const message of messages) {
      if (
        message.type !== 'remote-window-stream-ice-candidate'
        || message.payload.streamId !== streamId
      ) {
        continue;
      }
      const candidateKey = JSON.stringify(message.payload.candidate);
      if (appliedCandidates.has(candidateKey)) {
        continue;
      }
      appliedCandidates.add(candidateKey);
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.payload.candidate as RTCIceCandidateInit));
    }
    if (hasTrack()) {
      return;
    }
    await delay(25);
  }
  const receivers = typeof peerConnection.getReceivers === 'function'
    ? peerConnection.getReceivers().map((receiver) => ({
      kind: receiver.track?.kind,
      id: receiver.track?.id,
      readyState: receiver.track?.readyState,
    }))
    : [];
  throw new Error(`timed out waiting for remote window receiver ontrack event; candidates=${appliedCandidates.size}; state=${peerConnection.connectionState}; ice=${peerConnection.iceConnectionState}; signaling=${peerConnection.signalingState}; receivers=${JSON.stringify(receivers)}`);
}

async function waitForRawMuxFrame(
  frames: any[],
  predicate: (frame: any) => boolean,
  label: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    for (; cursor < frames.length; cursor += 1) {
      const frame = frames[cursor]!;
      if (predicate(frame)) {
        return frame;
      }
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}; frames=${JSON.stringify(frames.slice(-8))}`);
}

async function waitForProbeLine(lines: string[], marker: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    const currentLines = readProbeLines(lines);
    for (; cursor < currentLines.length; cursor += 1) {
      const line = currentLines[cursor]!;
      if (line.includes(marker)) {
        return line;
      }
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for probe marker ${marker}; seen=${JSON.stringify(readProbeLines(lines))}`);
}

function countProbeLines(lines: string[], marker: string) {
  return readProbeLines(lines).filter((line) => line.includes(marker)).length;
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
  throw new Error(`timed out waiting for probe marker ${marker} count ${minCount}; seen=${JSON.stringify(readProbeLines(lines))}`);
}

function readProbeLines(fallbackLines: string[]) {
  if (!existsSync(probeLogPath)) {
    return fallbackLines;
  }
  const fileLines = readFileSync(probeLogPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return fileLines.length > 0 ? fileLines : fallbackLines;
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

function clientSentAt() {
  return Date.now() + CLIENT_CLOCK_OFFSET_MS;
}

function buildInputPayload(
  streamId: string,
  target: RemoteWindowStreamTargetManifest,
  suffix: string,
  event: RemoteWindowInputEventPayload['event'],
): RemoteWindowInputEventPayload {
  return {
    requestId: requestId(suffix),
    streamId,
    targetId: target.streamTargetId,
    clientSentAt: clientSentAt(),
    event,
  };
}

async function sendActionEventAndRequireFocus(
  ws: WebSocket,
  messages: ServerMessage[],
  streamId: string,
  target: RemoteWindowStreamTargetManifest,
  targetPid: number,
  suffix: string,
  event: RemoteWindowInputEventPayload['event'],
) {
  const result = await sendInputAndRequireAccepted(ws, messages, buildInputPayload(streamId, target, suffix, event));
  await waitForFrontmostPid(targetPid, `${suffix} action accepted`);
  return result;
}

async function waitForInputAccepted(
  messages: ServerMessage[],
  payload: RemoteWindowInputEventPayload,
) {
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

async function sendInputAndRequireAccepted(
  ws: WebSocket,
  messages: ServerMessage[],
  payload: RemoteWindowInputEventPayload,
) {
  send(ws, { type: 'remote-window-input', payload });
  return waitForInputAccepted(messages, payload);
}

async function main() {
  writeFileSync(probeSourcePath, objcSource);
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
  const compile = spawnSync('clang', [
    '-fobjc-arc',
    probeSourcePath,
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    probeExecutablePath,
  ], { encoding: 'utf8' });
  if (compile.status !== 0) {
    fail(`clang probe compile failed: ${compile.stderr || compile.stdout}`);
  }

  const probe = spawn('/usr/bin/open', ['-n', '-a', appPath, '--args', PROBE_TITLE, probeLogPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const probeLines: string[] = [];
  let probeStdoutBuffer = '';
  let probeStderr = '';
  let probePid: number | null = null;
  let probeSpawnError: string | null = null;
  let probeExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
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
  probe.on('error', (error) => {
    probeSpawnError = error instanceof Error ? error.message : String(error);
  });
  probe.on('exit', (code, signal) => {
    probeExit = { code, signal };
  });

  const cleanup = async () => {
    if (probePid && Number.isInteger(probePid)) {
      try {
        process.kill(probePid, 'SIGTERM');
      } catch {
        // already exited
      }
      await delay(300);
      try {
        process.kill(probePid, 0);
        process.kill(probePid, 'SIGKILL');
      } catch {
        // exited after SIGTERM
      }
    }
    spawnSync('osascript', ['-e', `tell application id "${probeBundleId}" to quit`], { encoding: 'utf8' });
    if (!KEEP_TEMP) {
      rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.error(`keeping remote-window live probe temp root: ${tempRoot}`);
    }
  };

  try {
    let readyLine: string;
    try {
      readyLine = await waitForProbeLine(probeLines, 'PROBE_READY', 20_000);
    } catch (error) {
      fail(`probe app did not become ready: ${error instanceof Error ? error.message : String(error)}; exit=${JSON.stringify(probeExit)}; spawnError=${probeSpawnError || 'none'}; stderr=${probeStderr || 'none'}`);
    }
    const readyPid = Number.parseInt(readyLine.match(/pid=(\d+)/)?.[1] || '', 10);
    probePid = Number.isFinite(readyPid) ? readyPid : probePid;
    const ws = new WebSocket(DAEMON_WS_URL);
    const messages: ServerMessage[] = [];
    const rawFrames: any[] = [];
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (USE_MUX) {
        rawFrames.push(parsed);
        if (
          parsed?.type === 'mux-channel-message'
          && parsed.payload?.channelId === PROBE_MUX_CHANNEL_ID
          && parsed.payload?.message?.type
        ) {
          messages.push(parsed.payload.message as ServerMessage);
        }
        return;
      }
      messages.push(parsed as ServerMessage);
    });
    await waitForWebSocketOpen(ws);
    if (USE_MUX) {
      ws.send(JSON.stringify({
        type: 'mux-hello',
        payload: {
          version: 1,
          clientInstanceId: PROBE_MUX_CLIENT_ID,
        },
      }));
      await waitForRawMuxFrame(
        rawFrames,
        (frame) => frame?.type === 'mux-ready',
        'mux-ready',
      );
      ws.send(JSON.stringify({
        type: 'mux-channel-open',
        payload: {
          channelId: PROBE_MUX_CHANNEL_ID,
          sessionName: PROBE_MUX_SESSION,
          bodySubscribed: false,
        },
      }));
      await waitForRawMuxFrame(
        rawFrames,
        (frame) => (
          frame?.type === 'mux-channel-opened'
          && frame.payload?.channelId === PROBE_MUX_CHANNEL_ID
        ),
        `mux-channel-opened:${PROBE_MUX_CHANNEL_ID}`,
      );
    }

    const catalogRequestId = requestId('catalog');
    send(ws, {
      type: 'remote-window-targets-request',
      payload: {
        requestId: catalogRequestId,
        forceRefresh: true,
      },
    });
    const catalog = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-targets-response' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === catalogRequestId
      ),
      'remote window target catalog',
      REMOTE_WINDOW_LIVE_CATALOG_TIMEOUT_MS,
    );
    if (catalog.type !== 'remote-window-targets-response') {
      fail(`catalog failed: ${JSON.stringify(catalog)}`);
    }
    const target = catalog.payload.targets.find((candidate) => (
      candidate.videoTarget.kind === 'app-window'
      && candidate.videoTarget.pid === probePid
      && candidate.videoTarget.title.includes(PROBE_TITLE)
      && candidate.streamMode === 'interactive'
      && candidate.inputRoute === 'os-event'
    ));
    if (!target) {
      const matchingTitles = catalog.payload.targets
        .filter((candidate) => (
          candidate.videoTarget.kind === 'app-window'
          && candidate.videoTarget.title.includes(PROBE_TITLE)
        ))
        .map((candidate) => ({
          id: candidate.streamTargetId,
          pid: candidate.videoTarget.pid,
          title: candidate.videoTarget.title,
          streamMode: candidate.streamMode,
          inputRoute: candidate.inputRoute,
        }));
      fail(`probe target not found for pid=${probePid}; targetCount=${catalog.payload.targets.length}; matchingTitles=${JSON.stringify(matchingTitles)}; ready=${readyLine}; stderr=${probeStderr}`);
    }
    const targetBundleId = target.videoTarget.appBundleId || probeBundleId;
    if (!targetBundleId) {
      fail(`probe target missing bundle id: ${target.streamTargetId}`);
    }
    const targetPid = target.videoTarget.pid;
    if (!Number.isFinite(targetPid) || targetPid !== probePid) {
      fail(`probe target pid mismatch: target=${targetPid} ready=${probePid} targetId=${target.streamTargetId}`);
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
        mediaPlan: 'single-focus',
        mediaPlanVersion: 1,
        target,
        offer: {
          type: offer.type,
          sdp: offer.sdp || '',
        },
        videoBitrate: {
          preset: '2mbps',
          bitrateMbps: 2,
          maxBitrateBps: 2_000_000,
          maxFrameRateFps: 30,
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
      REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
    );
    if (started.type !== 'remote-window-stream-started') {
      fail(`stream start failed: ${JSON.stringify(started)}`);
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(started.payload.answer));
    await waitForReceiverTrack(peerConnection, messages, streamId, () => trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
    trackSeen = true;
    await waitForServerMessage(
      messages,
      (message) => (
        message.type === 'remote-window-stream-status'
        && message.payload.streamId === streamId
        && message.payload.phase === 'streaming'
      ),
      'remote window stream status',
      REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
    );

    const degradedQualityRequestId = requestId('quality-degraded');
    send(ws, {
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: degradedQualityRequestId,
        streamId,
        streamGroupId: streamId,
        mediaPlan: 'single-focus',
        mediaPlanVersion: 1 as const,
        revision: 1,
        targetId: target.streamTargetId,
        videoBitrate: {
          preset: '2mbps',
          bitrateMbps: 2,
          maxBitrateBps: 500_000,
          maxFrameRateFps: 15,
        },
      },
    });
    const degradedQuality = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-stream-quality-result' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === degradedQualityRequestId
      ),
      'remote window degraded quality update',
    );
    assertQualityUpdateContract(degradedQuality, 'degraded');

    const restoredQualityRequestId = requestId('quality-restored');
    send(ws, {
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: restoredQualityRequestId,
        streamId,
        streamGroupId: streamId,
        mediaPlan: 'single-focus',
        mediaPlanVersion: 1 as const,
        revision: 2,
        targetId: target.streamTargetId,
        videoBitrate: {
          preset: '2mbps',
          bitrateMbps: 2,
          maxBitrateBps: 2_000_000,
          maxFrameRateFps: 30,
        },
      },
    });
    const restoredQuality = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-stream-quality-result' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === restoredQualityRequestId
      ),
      'remote window restored quality update',
    );
    assertQualityUpdateContract(restoredQuality, 'restored');

    const center = targetCenter(target);
    const frontmostBeforeDefocus = {
      bundleId: readFrontmostBundleId(),
      pid: readFrontmostPid(),
    };
    const frontmostAfterDefocus = await defocusTargetBeforeRemoteInput(targetPid, targetBundleId);
    const inputActions: Array<{ suffix: string; event: RemoteWindowInputEventPayload['event'] }> = [
      {
        suffix: 'click',
        event: {
          kind: 'click',
          pointerId: 1,
          button: 'left',
          clickCount: 1,
          x: center.x,
          y: center.y,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      },
      {
        suffix: 'gesture-swipe',
        event: {
          kind: 'gesture',
          gesture: 'swipe',
          phase: 'end',
          unit: 'pixel',
          pointerId: 3,
          startX: center.x,
          startY: center.y + Math.round(center.height * 0.2),
          x: center.x,
          y: center.y - Math.round(center.height * 0.2),
          startNormalizedX: 0.5,
          startNormalizedY: 0.7,
          normalizedX: 0.5,
          normalizedY: 0.3,
          deltaX: 0,
          deltaY: -Math.max(1, Math.round(center.height * 0.4)),
          durationMs: 420,
          velocityX: 0,
          velocityY: -Math.max(1, Math.round(center.height * 0.4)) / 420,
        },
      },
      {
        suffix: 'scroll',
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
      },
      {
        suffix: 'key-down',
        event: {
          kind: 'key',
          phase: 'down',
          key: 'z',
          code: 'KeyZ',
          text: 'z',
        },
      },
      {
        suffix: 'key-up',
        event: {
          kind: 'key',
          phase: 'up',
          key: 'z',
          code: 'KeyZ',
          text: 'z',
        },
      },
    ];

    if (BURST_INPUT) {
      const payloads = inputActions.map((action) => buildInputPayload(streamId, target, action.suffix, action.event));
      payloads.forEach((payload) => send(ws, { type: 'remote-window-input', payload }));
      await Promise.all(payloads.map((payload) => waitForInputAccepted(messages, payload)));
      await waitForFrontmostPid(targetPid, 'burst actions accepted');
    } else {
      await sendActionEventAndRequireFocus(ws, messages, streamId, target, targetPid, 'click', inputActions[0]!.event);
      await waitForProbeLineCount(probeLines, 'PROBE_MOUSE_DOWN', 1);
      await waitForProbeLineCount(probeLines, 'PROBE_MOUSE_UP', 1);
      await sendActionEventAndRequireFocus(ws, messages, streamId, target, targetPid, 'gesture-swipe', inputActions[1]!.event);
      await waitForProbeLineCount(probeLines, 'PROBE_SCROLL', 1);
      await sendActionEventAndRequireFocus(ws, messages, streamId, target, targetPid, 'scroll', inputActions[2]!.event);
      await waitForProbeLineCount(probeLines, 'PROBE_SCROLL', 2);
      await sendActionEventAndRequireFocus(ws, messages, streamId, target, targetPid, 'key-down', inputActions[3]!.event);
      await waitForProbeLine(probeLines, 'PROBE_KEY_DOWN');
      await sendActionEventAndRequireFocus(ws, messages, streamId, target, targetPid, 'key-up', inputActions[4]!.event);
      await waitForProbeLine(probeLines, 'PROBE_KEY_UP');
    }

    await waitForProbeLineCount(probeLines, 'PROBE_MOUSE_DOWN', 1);
    await waitForProbeLineCount(probeLines, 'PROBE_MOUSE_UP', 1);
    await waitForProbeLineCount(probeLines, 'PROBE_SCROLL', 2);
    await waitForProbeLine(probeLines, 'PROBE_KEY_DOWN');
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
    const framesSent = stopped.payload.framesSent ?? 0;
    if (framesSent < 3) {
      fail(`remote window video did not refresh multiple frames; framesSent=${framesSent}; probeLines=${JSON.stringify(readProbeLines(probeLines).slice(-12))}`);
    }
    peerConnection.close();
    ws.close();

    console.log(JSON.stringify({
      ok: true,
      daemonWsUrl: DAEMON_WS_URL,
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      burstInput: BURST_INPUT,
      clientClockOffsetMs: CLIENT_CLOCK_OFFSET_MS,
      defocusBundleId: DEFOCUS_BUNDLE_ID || undefined,
      frontmostBeforeDefocus,
      frontmostAfterDefocus,
      frontmostAfterInput: {
        bundleId: readFrontmostBundleId(),
        pid: readFrontmostPid(),
      },
      muxSession: USE_MUX ? PROBE_MUX_SESSION : undefined,
      muxChannelId: USE_MUX ? PROBE_MUX_CHANNEL_ID : undefined,
      targetId: target.streamTargetId,
      targetPid,
      targetTitle: target.videoTarget.title,
      capture: started.payload.capture,
      qualityUpdates: [
        summarizeQualityUpdate(degradedQuality),
        summarizeQualityUpdate(restoredQuality),
      ],
      trackSeen,
      stopped: stopped.payload,
      probeLines: readProbeLines(probeLines),
    }, null, 2));
  } finally {
    await cleanup();
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  if (!KEEP_TEMP) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`keeping remote-window live probe temp root: ${tempRoot}`);
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

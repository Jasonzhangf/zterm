import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import wrtc from '@roamhq/wrtc';
import type {
  BridgeSocketCloseLike,
  BridgeSocketMessageLike,
  BridgeTransportSocket,
  TraversalDiagnostics,
} from '../src/lib/traversal/types';
import type { RemoteWindowInputDeliveryOutcomeV1 } from '../src/lib/remote-window-message-runtime';
import {
  createRemoteWindowMessageRuntime,
  isRemoteWindowControlMessage,
  type RemoteWindowMessageRuntime,
} from '../src/lib/remote-window-message-runtime';
import { resolveDaemonRuntimeConfig } from '../src/server/daemon-config';
import { buildRemoteWindowVideoProfile } from '../src/lib/remote-window-video-quality';
import {
  buildRemoteWindowTextInputEvents,
  buildRemoteWindowKeyInputEventsFromSequence,
} from '../src/lib/remote-window-input-mapping';
import type {
  RemoteWindowInputEventPayload,
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamStatusPayload,
  ServerMessage,
} from '../src/lib/types';

interface RTCVideoFrameLike {
  width: number;
  height: number;
  data: Uint8Array;
}

interface RTCVideoSinkLike {
  onframe: ((event: { frame: RTCVideoFrameLike }) => void) | null;
  stop(): void;
  readonly stopped: boolean;
}

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
  nonstandard: {
    RTCVideoSink: new (track: MediaStreamTrack) => RTCVideoSinkLike;
  };
};
const { RTCVideoSink } = nonstandard;
const requireFromProbe = createRequire(import.meta.url);

const RUN_ID = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const DOC_NAME = `ZTERM_INPUT_DELIVERY_${RUN_ID}.txt`;
const REQUEST_PREFIX = `rw-client-delivery-${RUN_ID}`;
const DEFAULT_DAEMON_URL = 'ws://127.0.0.1:3333';
const KEEP_TMP = process.env.ZTERM_INPUT_PROBE_KEEP_TMP === '1';
const OWNED_STREAM_STARTUP_TIMEOUT_MS = 20_000;
const OWNED_STREAM_SHUTDOWN_TIMEOUT_MS = 5_000;

function requestId(suffix: string) {
  return `${REQUEST_PREFIX}-${suffix}`;
}

function fail(message: string): never {
  throw new Error(message);
}

class FatalProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalProbeError';
  }
}

function failFatal(message: string): never {
  throw new FatalProbeError(message);
}

interface SerializedProbeError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedProbeError;
}

function errorSummary(error: unknown): SerializedProbeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause ? { cause: errorSummary(error.cause) } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function currentScriptSha256() {
  return createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
}

function wrtcPackagePath() {
  try {
    return requireFromProbe.resolve('@roamhq/wrtc');
  } catch {
    return null;
  }
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

function resolveDaemonWebSocketUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) {
    return url.toString();
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const explicitToken = process.env.ZTERM_INPUT_PROBE_AUTH_TOKEN?.trim();
  const token = explicitToken || (loopback ? resolveDaemonRuntimeConfig({ homeDir: homedir() }).authToken : '');
  if (!token) {
    throw new Error('remote-window client delivery probe requires ZTERM_INPUT_PROBE_AUTH_TOKEN for a non-loopback daemon URL');
  }
  url.searchParams.set('token', token);
  return url.toString();
}

function redactUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) {
    url.searchParams.set('token', '<redacted>');
  }
  return url.toString();
}

function readTextEditPid() {
  const raw = runAppleScript('tell application "System Events" to get unix id of process "TextEdit"');
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid)) {
    fail(`TextEdit pid is invalid: ${raw || 'empty'}`);
  }
  return pid;
}

function openOwnedDocument(dir: string, seed: string) {
  const path = join(dir, DOC_NAME);
  writeFileSync(path, seed, 'utf8');
  const result = spawnSync('/usr/bin/open', ['-a', 'TextEdit', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`open TextEdit failed: ${result.stderr || result.stdout}`);
  }
}

function textEditIsRunning() {
  return runAppleScript('application "TextEdit" is running').toLowerCase() === 'true';
}

function ownedDocumentNames() {
  if (!textEditIsRunning()) {
    return [];
  }
  const raw = runAppleScript(
    `tell application "TextEdit"
       set matches to {}
       repeat with d in documents
         if (name of d) is "${appleScriptStringLiteral(DOC_NAME)}" then set end of matches to name of d
       end repeat
       set AppleScript's text item delimiters to linefeed
       return matches as text
     end tell`,
  );
  return raw ? raw.split('\n').filter(Boolean) : [];
}

function ownedDocumentExists() {
  return ownedDocumentNames().includes(DOC_NAME);
}

function closeOwnedDocument() {
  if (!textEditIsRunning()) {
    return false;
  }
  const raw = runAppleScript(
    `tell application "TextEdit"
       set owned to {}
       repeat with d in documents
         if (name of d) is "${appleScriptStringLiteral(DOC_NAME)}" then set end of owned to d
       end repeat
       if (count of owned) is 0 then return "0"
       if (count of owned) is not 1 then
         error "ambiguous owned TextEdit documents: " & (count of owned)
       end if
       close (item 1 of owned) saving no
       return "1"
     end tell`,
  );
  return Number.parseInt(raw, 10) > 0;
}

function readOwnedDocumentBody() {
  return runAppleScript(
    `tell application "TextEdit"
       set foundDoc to missing value
       repeat with d in documents
         if (name of d) is "${appleScriptStringLiteral(DOC_NAME)}" then
           set foundDoc to d
           exit repeat
         end if
       end repeat
       if foundDoc is missing value then error "owned TextEdit document missing"
       return text of foundDoc
     end tell`,
  );
}

function pickOwnedTarget(targets: RemoteWindowStreamTargetManifest[], pid: number) {
  const matches = targets.filter((target) => (
    target.videoTarget.kind === 'app-window'
    && target.videoTarget.pid === pid
    && target.videoTarget.title === DOC_NAME
    && target.streamMode === 'interactive'
    && target.inputRoute === 'os-event'
    && target.focusPolicy === 'bring-to-focus'
  ));
  if (matches.length === 0) {
    fail(`no owned TextEdit target for pid=${pid}; title=${DOC_NAME}; candidates=${JSON.stringify(targets.map((target) => ({
      bundle: target.videoTarget.appBundleId,
      pid: target.videoTarget.pid,
      title: target.videoTarget.title,
      mode: target.streamMode,
      route: target.inputRoute,
      focus: target.focusPolicy,
    })).slice(0, 20))}`);
  }
  if (matches.length !== 1) {
    failFatal(`ambiguous owned TextEdit target for pid=${pid}; title=${DOC_NAME}; matches=${JSON.stringify(matches)}`);
  }
  return matches[0]!;
}

interface WireRecord {
  atMs: number;
  direction: 'client-to-daemon' | 'daemon-to-client';
  message: unknown;
}

function isReliableInputMessage(message: unknown): message is { control: { sequence: string } } {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === 'remote-window-input'
    && typeof (message as { control?: { sequence?: unknown } }).control?.sequence === 'string',
  );
}

function isInputAckMessage(message: unknown): message is { type: 'remote-window-input-ack'; control: { sequence: string } } {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === 'remote-window-input-ack'
    && typeof (message as { control?: { sequence?: unknown } }).control?.sequence === 'string',
  );
}

// ---------------------------------------------------------------------------
// Real WS delay/drop proxy. Only this run's matching ACKs are delayed/held;
// every other frame is forwarded verbatim to the canonical daemon.
// ---------------------------------------------------------------------------

interface DeliveryProxyPolicy {
  match: 'none' | 'all' | 'sequence';
  sequence?: string;
  mode: 'forward' | 'delay' | 'hold';
  delayMs?: number;
}

interface DeliveryProxy {
  readonly url: string;
  readonly records: WireRecord[];
  readonly heldAcks: Array<{ raw: string; message: unknown }>;
  readonly heldAckCount: number;
  readonly error: Error | null;
  setPolicy(policy: DeliveryProxyPolicy): void;
  releaseHeldAcks(): void;
  close(): Promise<void>;
}

async function closeWebSocketWithin(socket: WebSocket | null, timeoutMs: number) {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return null;
  }
  return await new Promise<{ code: number; reason: string } | null>((resolve) => {
    let settled = false;
    const finish = (value: { code: number; reason: string } | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('close', onClose);
      resolve(value);
    };
    const onClose = (code: number, reason: Buffer) => {
      finish({ code, reason: reason.toString() });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('close', onClose);
    try {
      socket.close();
    } catch {
      finish(null);
    }
  });
}

async function startDeliveryProxy(daemonUrl: string): Promise<DeliveryProxy> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (error) => reject(error));
  });
  const records: WireRecord[] = [];
  const heldAcks: Array<{ raw: string; message: unknown; timer: NodeJS.Timeout | null }> = [];
  const upstreamBuffer: string[] = [];
  let client: WebSocket | null = null;
  let upstream: WebSocket | null = null;
  let upstreamError: Error | null = null;
  let policy: DeliveryProxyPolicy = { match: 'none', mode: 'forward' };

  const record = (direction: WireRecord['direction'], message: unknown) => {
    records.push({ atMs: Date.now(), direction, message });
  };
  const sendToClient = (raw: string) => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  };
  const holdAck = (raw: string, message: unknown, delayMs: number | null) => {
    const entry: { raw: string; message: unknown; timer: NodeJS.Timeout | null } = { raw, message, timer: null };
    if (delayMs !== null) {
      entry.timer = setTimeout(() => {
        const index = heldAcks.indexOf(entry);
        if (index !== -1) {
          heldAcks.splice(index, 1);
        }
        sendToClient(raw);
      }, delayMs);
    }
    heldAcks.push(entry);
  };
  const handleDownstream = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    record('daemon-to-client', parsed);
    const sequence = isInputAckMessage(parsed) ? parsed.control.sequence : null;
    const matched = policy.mode !== 'forward'
      && sequence !== null
      && (policy.match === 'all' || (policy.match === 'sequence' && sequence === policy.sequence));
    if (!matched) {
      sendToClient(raw);
      return;
    }
    holdAck(raw, parsed, policy.mode === 'delay' ? (policy.delayMs ?? 0) : null);
  };
  const handleUpstream = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    record('client-to-daemon', parsed);
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(raw);
    } else {
      upstreamBuffer.push(raw);
    }
  };

  server.on('connection', (socket) => {
    if (client) {
      socket.close(1008, 'single client');
      return;
    }
    client = socket;
    const daemon = new WebSocket(daemonUrl);
    upstream = daemon;
    daemon.on('open', () => {
      upstreamBuffer.splice(0).forEach((raw) => daemon.send(raw));
    });
    daemon.on('message', (data) => handleDownstream(data.toString()));
    daemon.on('error', (error) => {
      upstreamError = error instanceof Error ? error : new Error(String(error));
    });
    socket.on('message', (data) => handleUpstream(data.toString()));
    socket.on('error', () => {});
    socket.on('close', () => {
      client = null;
      daemon.close();
      upstream = null;
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    records,
    get heldAcks() {
      return heldAcks.map(({ raw, message }) => ({ raw, message }));
    },
    get heldAckCount() {
      return heldAcks.length;
    },
    get error() {
      return upstreamError;
    },
    setPolicy(next) {
      policy = next;
    },
    releaseHeldAcks() {
      const held = heldAcks.splice(0, heldAcks.length);
      held.forEach((entry) => {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        sendToClient(entry.raw);
      });
    },
    async close() {
      heldAcks.splice(0).forEach((entry) => {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
      });
      await Promise.all([
        closeWebSocketWithin(client, OWNED_STREAM_SHUTDOWN_TIMEOUT_MS),
        closeWebSocketWithin(upstream, OWNED_STREAM_SHUTDOWN_TIMEOUT_MS),
      ]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class ProbeBridgeSocket implements BridgeTransportSocket {
  readyState: number;
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;
  readonly transportOwnership = 'client' as const;

  constructor(
    private readonly socket: WebSocket,
    private readonly onSend?: (data: string | ArrayBuffer) => void,
  ) {
    this.readyState = socket.readyState;
    socket.on('message', (data: RawData) => {
      this.readyState = socket.readyState;
      this.onmessage?.({ data: data.toString() });
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.readyState = socket.readyState;
      this.onclose?.({ code, reason: reason.toString() });
    });
    socket.on('error', (error: Error) => {
      this.onerror?.(error as unknown as Event);
    });
  }

  send(data: string | ArrayBuffer): void {
    this.onSend?.(data);
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  reportFailure(reason: string): void {
    this.onerror?.(new Error(reason) as unknown as Event);
  }

  getDiagnostics(): TraversalDiagnostics {
    return {
      mode: 'websocket',
      stage: this.readyState === WebSocket.OPEN ? 'open' : 'closed',
      attempts: [],
    };
  }
}

function sendSocketPayload(_sessionId: string, socket: BridgeTransportSocket, data: string | ArrayBuffer) {
  socket.send(data);
}

async function waitForWebSocketOpen(socket: WebSocket, url: string, timeoutMs = 8000) {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onOpen = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      reject(error);
    };
    timer = setTimeout(() => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      reject(new Error(`websocket open timeout: ${redactUrl(url)}`));
    }, timeoutMs);
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function readFrontmostPid() {
  const raw = runAppleScript('tell application "System Events" to get unix id of first application process whose frontmost is true');
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid)) {
    fail(`frontmost app pid is invalid: ${raw || 'empty'}`);
  }
  return pid;
}

// ---------------------------------------------------------------------------
// Controlled input-acceptance fixture. The owned TextEdit document is only the
// TARGET for real OS-event injection; the canonical daemon still performs the
// real focus + CGEvent injection. macOS TextEdit leaves the caret at paragraph
// start after `open` and applies first-letter autocapitalization there, so a
// raw lowercase paste is rendered "Highrtt8" (r5 baseline). That is a
// TextEdit/system editor contract, not the product's. We therefore pin the
// editor contract deterministically: read the raw AX text-area value/caret and
// force AXSelectedTextRange to end-of-document so injected input appends
// mid-paragraph verbatim, then re-read the raw AX caret/value as causal
// evidence. This never rewrites the injected input, never case-folds or strips
// the result, and never changes a global system preference; the assertion
// stays EXACT.
// ---------------------------------------------------------------------------
const AX_FIXTURE_SWIFT = String.raw`
import AppKit
import ApplicationServices
import Foundation
func a(_ e: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil }
func s(_ e: AXUIElement, _ n: String) -> String? { a(e, n) as? String }
func find(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
    if d > 8 { return nil }
    if s(e, kAXRoleAttribute) == "AXTextArea" { return e }
    if let k = a(e, kAXChildrenAttribute) as? [AXUIElement] { for c in k { if let f = find(c, d + 1) { return f } } }
    return nil
}
func emit(_ o: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let t = String(data: d, encoding: .utf8) { print(t) } else { print("{\"ok\":false}") } }
let args = CommandLine.arguments
let pid = Int32(args.count > 1 ? args[1] : "0") ?? 0
let titleMatch = args.count > 2 ? args[2] : ""
let action = args.count > 3 ? args[3] : "read"
let offsetArg = args.count > 4 ? args[4] : "end"
var out: [String: Any] = ["pid": Int(pid), "ok": false, "action": action]
let app = AXUIElementCreateApplication(pid)
var matched = false
if let wins = a(app, kAXWindowsAttribute) as? [AXUIElement] {
    for w in wins {
        let title = s(w, kAXTitleAttribute) ?? ""
        if !titleMatch.isEmpty && !title.contains(titleMatch) { continue }
        guard let ta = find(w, 0) else { continue }
        matched = true
        out["title"] = title
        out["value"] = s(ta, kAXValueAttribute)
        var count = 0
        if let n = a(ta, kAXNumberOfCharactersAttribute) as? NSNumber { count = n.intValue; out["numberOfCharacters"] = count }
        if let r = a(ta, "AXSelectedTextRange") { var g = CFRange(); if AXValueGetValue(r as! AXValue, .cfRange, &g) { out["caret"] = [g.location, g.length] } }
        if action == "set-caret" {
            let target = offsetArg == "end" ? count : (offsetArg as NSString).integerValue
            out["targetOffset"] = target
            var g = CFRange(location: target, length: 0)
            if let v = AXValueCreate(.cfRange, &g) {
                let res = AXUIElementSetAttributeValue(ta, "AXSelectedTextRange" as CFString, v)
                out["setResult"] = Int(res.rawValue)
                out["ok"] = res == .success
                if let r2 = a(ta, "AXSelectedTextRange") { var g2 = CFRange(); if AXValueGetValue(r2 as! AXValue, .cfRange, &g2) { out["caretAfter"] = [g2.location, g2.length] } }
            }
        } else { out["ok"] = true }
        break
    }
}
if !matched { out["error"] = "no-text-area-for-title" }
emit(out)
`;
const AX_FIXTURE_CACHE_DIR = join(tmpdir(), 'zterm-input-delivery-ax-fixture');
let axFixtureBinaryPath: string | null = null;

function ensureAxFixtureBinary() {
  if (axFixtureBinaryPath && existsSync(axFixtureBinaryPath)) {
    return axFixtureBinaryPath;
  }
  mkdirSync(AX_FIXTURE_CACHE_DIR, { recursive: true });
  const digest = createHash('sha256').update(AX_FIXTURE_SWIFT).digest('hex').slice(0, 16);
  const binaryPath = join(AX_FIXTURE_CACHE_DIR, `ax-fixture-${digest}`);
  if (!existsSync(binaryPath)) {
    const sourcePath = join(AX_FIXTURE_CACHE_DIR, `ax-fixture-${digest}.swift`);
    writeFileSync(sourcePath, AX_FIXTURE_SWIFT, 'utf8');
    const compile = spawnSync('swiftc', ['-O', '-o', binaryPath, sourcePath], { encoding: 'utf8' });
    if (compile.status !== 0) {
      fail(`AX fixture compile failed: ${compile.stderr || compile.stdout}`);
    }
  }
  axFixtureBinaryPath = binaryPath;
  return binaryPath;
}

interface AxTextAreaState {
  ok: boolean;
  action?: string;
  title?: string;
  value?: string;
  numberOfCharacters?: number;
  caret?: [number, number];
  caretAfter?: [number, number];
  targetOffset?: number;
  setResult?: number;
  error?: string;
}

function runAxFixture(pid: number, action: 'read' | 'set-caret'): AxTextAreaState {
  const result = spawnSync(ensureAxFixtureBinary(), [String(pid), DOC_NAME, action], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`AX fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout.trim()) as AxTextAreaState;
  } catch (error) {
    fail(`AX fixture ${action} produced invalid JSON: ${result.stdout.trim()} (${errorSummary(error).message})`);
  }
}

async function forceOwnedCaretToEnd(pid: number): Promise<AxTextAreaState> {
  const deadline = Date.now() + 8_000;
  let last: AxTextAreaState | null = null;
  for (;;) {
    const state = runAxFixture(pid, 'set-caret');
    last = state;
    if (state.ok && state.caretAfter && state.caretAfter[0] === state.numberOfCharacters) {
      return state;
    }
    if (Date.now() >= deadline) {
      fail(`could not force owned TextEdit caret to end-of-document: ${JSON.stringify(last)}`);
    }
    await delay(250);
  }
}

// ---------------------------------------------------------------------------
// Real client runtime session: the probe drives createRemoteWindowMessageRuntime
// directly and consumes the public subscribeInputOutcome results.
// ---------------------------------------------------------------------------

interface ProbeRuntime {
  ws: WebSocket;
  bridge: ProbeBridgeSocket;
  runtime: RemoteWindowMessageRuntime;
  outcomes: RemoteWindowInputDeliveryOutcomeV1[];
  listenerErrors: Array<{ phase: string; message: string }>;
  statuses: RemoteWindowStreamStatusPayload[];
  iceQueue: RemoteWindowStreamIceCandidatePayload[];
  wireRecords: WireRecord[];
}

function parseWireMessage(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function connectRuntime(ws: WebSocket): ProbeRuntime {
  const wireRecords: WireRecord[] = [];
  const bridge = new ProbeBridgeSocket(ws, (data) => {
    wireRecords.push({
      atMs: Date.now(),
      direction: 'client-to-daemon',
      message: parseWireMessage(data.toString()),
    });
  });
  const outcomes: RemoteWindowInputDeliveryOutcomeV1[] = [];
  const listenerErrors: Array<{ phase: string; message: string }> = [];
  const statuses: RemoteWindowStreamStatusPayload[] = [];
  const iceQueue: RemoteWindowStreamIceCandidatePayload[] = [];
  const runtime = createRemoteWindowMessageRuntime({
    onStreamIceCandidate: (payload) => {
      iceQueue.push(payload);
    },
    onStreamStatus: (payload) => {
      statuses.push(payload);
    },
    onListenerError: (phase, error) => {
      listenerErrors.push({ phase, message: error instanceof Error ? error.message : String(error) });
    },
  });
  runtime.subscribeInputOutcome((outcome) => {
    outcomes.push(outcome);
  });
  ws.on('message', (data) => {
    const raw = data.toString();
    wireRecords.push({
      atMs: Date.now(),
      direction: 'daemon-to-client',
      message: parseWireMessage(raw),
    });
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (isRemoteWindowControlMessage(parsed)) {
      runtime.dispatch(parsed);
    }
  });
  return { ws, bridge, runtime, outcomes, listenerErrors, statuses, iceQueue, wireRecords };
}

async function waitForOwnedTarget(
  session: ProbeRuntime,
  sessionId: string,
  textEditPid: number,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const catalog = await session.runtime.requestTargets(sessionId, {
        ws: session.bridge,
        sendSocketPayload,
      });
      return pickOwnedTarget(catalog.targets, textEditPid);
    } catch (error) {
      if (error instanceof FatalProbeError) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      await delay(500);
    }
  }
  fail(`owned TextEdit target not found within ${timeoutMs}ms: ${lastError}`);
}

async function applyIceCandidates(
  peerConnection: RTCPeerConnection,
  iceQueue: RemoteWindowStreamIceCandidatePayload[],
  streamId: string,
  applied: Set<string>,
) {
  for (const payload of iceQueue) {
    if (payload.streamId !== streamId) {
      continue;
    }
    const key = JSON.stringify(payload.candidate);
    if (applied.has(key)) {
      continue;
    }
    applied.add(key);
    await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate as RTCIceCandidateInit));
  }
}

async function waitForReceiverTrack(
  peerConnection: RTCPeerConnection,
  iceQueue: RemoteWindowStreamIceCandidatePayload[],
  streamId: string,
  hasTrack: () => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  const applied = new Set<string>();
  while (Date.now() < deadline) {
    await applyIceCandidates(peerConnection, iceQueue, streamId, applied);
    if (hasTrack()) {
      return;
    }
    await delay(25);
  }
  fail(`timed out waiting for remote window receiver track; streamId=${streamId}; state=${peerConnection.connectionState}`);
}

async function waitForStreamingStatus(
  statuses: RemoteWindowStreamStatusPayload[],
  streamId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const streaming = statuses.find((status) => status.streamId === streamId && status.phase === 'streaming');
    if (streaming) {
      return streaming;
    }
    await delay(25);
  }
  fail(`timed out waiting for streaming status; streamId=${streamId}; seen=${JSON.stringify(statuses)}`);
}

interface OwnedFrameEvidence {
  at: string;
  elapsedMs: number;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
}

interface OwnedStreamResources {
  streamId: string;
  peerConnection: RTCPeerConnection;
  videoSink: RTCVideoSinkLike | null;
  receiverTrack: MediaStreamTrack | null;
  frameCount: number;
  firstFrame: OwnedFrameEvidence | null;
  lastFrame: Omit<OwnedFrameEvidence, 'sha256'> | null;
  frameErrors: string[];
  requestedAtMs: number;
}

function createOwnedStreamResources(streamId: string, peerConnection: RTCPeerConnection): OwnedStreamResources {
  return {
    streamId,
    peerConnection,
    videoSink: null,
    receiverTrack: null,
    frameCount: 0,
    firstFrame: null,
    lastFrame: null,
    frameErrors: [],
    requestedAtMs: 0,
  };
}

function frameEvidence(resources: OwnedStreamResources) {
  return {
    streamId: resources.streamId,
    frameCount: resources.frameCount,
    firstFrame: resources.firstFrame,
    lastFrame: resources.lastFrame,
    frameErrors: resources.frameErrors,
    receiverTrack: resources.receiverTrack
      ? {
        id: resources.receiverTrack.id,
        kind: resources.receiverTrack.kind,
        readyState: resources.receiverTrack.readyState,
      }
      : null,
    sink: resources.videoSink
      ? {
        stopped: resources.videoSink.stopped,
      }
      : null,
  };
}

async function waitForDecodedVideoFrame(resources: OwnedStreamResources, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (resources.firstFrame) {
      return resources.firstFrame;
    }
    if (resources.frameErrors.length > 0) {
      fail(`RTCVideoSink frame error before first complete frame: ${resources.frameErrors.join('; ')}`);
    }
    await delay(25);
  }
  fail(
    `timed out waiting for first complete RTCVideoSink frame; streamId=${resources.streamId}; `
    + `frames=${resources.frameCount}; errors=${JSON.stringify(resources.frameErrors)}; `
    + `sinkStopped=${resources.videoSink?.stopped ?? 'no-sink'}; `
    + `peerState=${resources.peerConnection.connectionState}/${resources.peerConnection.iceConnectionState}`,
  );
}

async function startOwnedStream(
  session: ProbeRuntime,
  sessionId: string,
  target: RemoteWindowStreamTargetManifest,
  resources: OwnedStreamResources,
) {
  const { streamId, peerConnection } = resources;
  peerConnection.ontrack = (event) => {
    const track = event.track;
    if (!track || track.kind !== 'video') {
      resources.frameErrors.push(`ontrack did not provide a video track: ${track?.kind ?? 'missing'}`);
      return;
    }
    if (resources.receiverTrack && resources.receiverTrack !== track) {
      resources.frameErrors.push(`ontrack provided a second video track: ${track.id}`);
      return;
    }
    resources.receiverTrack = track;
    if (resources.videoSink) {
      return;
    }
    const sink = new RTCVideoSink(track);
    resources.videoSink = sink;
    sink.onframe = (frameEvent) => {
      const frame = frameEvent?.frame;
      if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !frame.data) {
        resources.frameErrors.push(`RTCVideoSink emitted an invalid frame: ${JSON.stringify(frame)}`);
        return;
      }
      const expectedBytes = Math.floor(frame.width * frame.height * 1.5);
      if (frame.data.byteLength !== expectedBytes) {
        resources.frameErrors.push(
          `RTCVideoSink emitted incomplete I420 frame: ${frame.width}x${frame.height} `
          + `bytes=${frame.data.byteLength} expected=${expectedBytes}`,
        );
        return;
      }
      const now = Date.now();
      const elapsedMs = now - resources.requestedAtMs;
      resources.frameCount += 1;
      resources.lastFrame = {
        at: new Date(now).toISOString(),
        elapsedMs,
        width: frame.width,
        height: frame.height,
        byteLength: frame.data.byteLength,
      };
      if (!resources.firstFrame) {
        resources.firstFrame = {
          ...resources.lastFrame,
          sha256: createHash('sha256').update(frame.data).digest('hex'),
        };
      }
    };
  };
  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || !event.candidate.candidate) {
      return;
    }
    session.runtime.sendStreamIceCandidate(sessionId, {
      ws: session.bridge,
      streamId,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        usernameFragment: event.candidate.usernameFragment ?? null,
      },
      sendSocketPayload,
    });
  };
  resources.requestedAtMs = Date.now();
  const started = await session.runtime.requestStreamStart(sessionId, {
    ws: session.bridge,
    streamId,
    target,
    mediaPlan: 'single-focus',
    mediaPlanVersion: 2,
    videoProfile: buildRemoteWindowVideoProfile('smooth'),
    sendSocketPayload,
  });
  if (!('offer' in started)) {
    fail(`remote window stream start did not return an offer-v2 payload: ${JSON.stringify(started)}`);
  }
  await peerConnection.setRemoteDescription(new RTCSessionDescription(started.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  session.runtime.sendStreamAnswerV2(sessionId, {
    ws: session.bridge,
    payload: {
      requestId: started.requestId,
      streamId: started.streamId,
      mediaPlanVersion: 2,
      answer: {
        type: 'answer',
        sdp: peerConnection.localDescription?.sdp || answer.sdp || '',
      },
    },
    sendSocketPayload,
  });
  await waitForReceiverTrack(
    peerConnection,
    session.iceQueue,
    streamId,
    () => Boolean(resources.receiverTrack),
    OWNED_STREAM_STARTUP_TIMEOUT_MS,
  );
  await waitForStreamingStatus(session.statuses, streamId, OWNED_STREAM_STARTUP_TIMEOUT_MS);
  await waitForDecodedVideoFrame(resources, OWNED_STREAM_STARTUP_TIMEOUT_MS);
  return resources;
}

function sendAction(
  session: ProbeRuntime,
  sessionId: string,
  streamId: string,
  targetId: string,
  event: RemoteWindowInputEventPayload['event'],
) {
  return session.runtime.sendInputEvent(sessionId, {
    ws: session.bridge,
    payload: { streamId, targetId, event },
    sendSocketPayload,
  });
}

async function waitForOutcomes(
  session: ProbeRuntime,
  sequences: string[],
  timeoutMs: number,
) {
  const wanted = new Set(sequences);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settled = session.outcomes.filter((outcome) => wanted.has(outcome.sequence));
    if (settled.length >= sequences.length) {
      return settled;
    }
    await delay(25);
  }
  fail(`timed out waiting for ${sequences.length} input outcomes; settled=${JSON.stringify(session.outcomes)}`);
}

function assertOutcome(
  outcome: RemoteWindowInputDeliveryOutcomeV1 | undefined,
  expected: {
    status: RemoteWindowInputDeliveryOutcomeV1['status'];
    source: RemoteWindowInputDeliveryOutcomeV1['source'];
    execution: RemoteWindowInputDeliveryOutcomeV1['execution'];
  },
  label: string,
) {
  if (!outcome) {
    fail(`${label}: missing outcome`);
  }
  if (
    outcome.status !== expected.status
    || outcome.source !== expected.source
    || outcome.execution !== expected.execution
  ) {
    fail(`${label}: expected ${expected.status}/${expected.source}/${expected.execution}, got ${JSON.stringify(outcome)}`);
  }
}

function assertAllDelivered(outcomes: RemoteWindowInputDeliveryOutcomeV1[], label: string) {
  outcomes.forEach((outcome, index) => {
    assertOutcome(outcome, { status: 'delivered', source: 'daemon-ack', execution: 'confirmed' }, `${label}[${index}]`);
  });
}

// Editor-contract fixture. The probe injects into a real TextEdit document, which is
// an editor with its own deterministic input contract; the product's own contract is
// the wire input (exact lowercase, one ACK per action) plus the real OS events it
// posts. We pin those two contracts instead of trusting a fuzzy text projection:
//
//  1. Caret position: `open -a TextEdit <file>` leaves the insertion point at
//     paragraph start (AXSelectedTextRange=[0,0]), where macOS auto-capitalizes the
//     first letter ("h"->"H"). We pin AXSelectedTextRange=end-of-document before
//     injection so the appended lowercase text is verbatim, and read the raw AX
//     value as causal evidence.
//  2. The trailing Return is consumed by TextEdit's inline word completion: with the
//     caret directly after a token, `Enter` accepts the completion instead of
//     inserting a newline (verified: text+Return -> no newline; spaced text+Return ->
//     newline; Return,Return -> newline). The product's single bulk-unicode key-down
//     ("highrtt8") leaves the Return unconsumed, so the newline IS produced — the
//     AX text area (the authoritative in-app document buffer) reports
//     `seedhighrtt8\n` (13 chars, caret 13). The trailing newline is real document
//     content, not cosmetic.
//  3. The AppleScript `text of document` projection below returns paragraphs joined
//     by newline and DROPS a trailing empty paragraph, so it can never surface the
//     trailing newline; the probe therefore asserts the EXACT body against the AX
//     value and records the AppleScript projection as cross-check evidence only.
//
// The assertion stays EXACT (no casefold, no newline strip): AX body must equal
// `seed` + `highrtt8` + `\n`. The lowercase text and the 4 confirmed ACKs are the
// product's input contract; the editor's completion behavior on the Return key is
// the editor's contract, documented here with raw caret/AX evidence.
const CAPITALIZATION_NEUTRAL_SEED = 'seed';
const TEXT = 'highrtt8';
const EXPECTED_BASELINE_BODY = `${CAPITALIZATION_NEUTRAL_SEED}${TEXT}\n`;

function assertTextInsertedVerbatimOnce(body: string, expected: string, label: string) {
  if (body !== expected) {
    fail(`${label}: expected owned TextEdit body ${JSON.stringify(expected)} exactly, got ${JSON.stringify(body)}`);
  }
}

// The AX text area value is TextEdit's authoritative in-app document buffer and is
// the only projection that preserves a trailing empty paragraph (the AppleScript
// `text of document` projection drops it). Assert against this exact value and keep
// the AppleScript projection as recorded cross-check evidence.
function assertOwnedBodyFromAx(axAfter: AxTextAreaState, expected: string, label: string) {
  if (!axAfter.ok || typeof axAfter.value !== 'string') {
    fail(`${label}: AX read of the owned TextEdit document failed: ${JSON.stringify(axAfter)}`);
  }
  assertTextInsertedVerbatimOnce(axAfter.value, expected, label);
}

function dispatchTimesBySequence(records: WireRecord[]) {
  const dispatchTimes = new Map<string, number>();
  for (const record of records) {
    if (record.direction !== 'client-to-daemon' || !isReliableInputMessage(record.message)) {
      continue;
    }
    const sequence = record.message.control.sequence;
    if (!dispatchTimes.has(sequence)) {
      dispatchTimes.set(sequence, record.atMs);
    }
  }
  return dispatchTimes;
}

const HIGH_RTT_ACK_DELAY_MS = 900;
const QUEUED_CANCEL_ACK_DELAY_MS = 2500;
const LEGACY_RELIABLE_AGE_DEADLINE_MS = 8000;

type CaseName = 'baseline-burst' | 'queued-cancel' | 'ack-drop' | 'high-rtt-burst';
const CASE_NAMES: CaseName[] = ['baseline-burst', 'queued-cancel', 'ack-drop', 'high-rtt-burst'];

interface CleanupEvidence {
  stopResult: unknown;
  stopError: unknown;
  runtimeDisposeError: unknown;
  pendingCountAfterDispose: number | null;
  pendingRequestIdsAfterDispose: string[] | null;
  sink: { stopped: boolean; stopError: unknown } | null;
  peer: {
    connectionState: string;
    iceConnectionState: string;
    signalingState: string;
    closeError: unknown;
  } | null;
  socket: {
    readyStateBefore: number | null;
    closeEvent: { code: number; reason: string } | null;
    closeError: unknown;
  } | null;
  proxy: {
    heldAckCountAfterClose: number | null;
    closeError: unknown;
  } | null;
  document: {
    closed: boolean;
    existsAfter: boolean;
    closeError: unknown;
  };
  tmp: {
    path: string;
    kept: boolean;
    existsAfter: boolean;
    removeError: unknown;
  };
  errors: Array<{ stage: string; error: unknown }>;
}

async function cleanupOwnedResources(args: {
  session: ProbeRuntime | null;
  sessionId: string;
  streamResources: OwnedStreamResources | null;
  peerConnection: RTCPeerConnection | null;
  sessionSocket: WebSocket | null;
  proxy: DeliveryProxy | null;
  docDir: string;
}): Promise<CleanupEvidence> {
  const cleanup: CleanupEvidence = {
    stopResult: null,
    stopError: null,
    runtimeDisposeError: null,
    pendingCountAfterDispose: null,
    pendingRequestIdsAfterDispose: null,
    sink: null,
    peer: null,
    socket: null,
    proxy: null,
    document: {
      closed: false,
      existsAfter: false,
      closeError: null,
    },
    tmp: {
      path: args.docDir,
      kept: KEEP_TMP,
      existsAfter: false,
      removeError: null,
    },
    errors: [],
  };
  const recordError = (stage: string, error: unknown) => {
    cleanup.errors.push({ stage, error: errorSummary(error) });
  };

  if (args.session && args.streamResources) {
    try {
      const stopResult = await args.session.runtime.stopStream(args.sessionId, {
        ws: args.session.bridge,
        streamId: args.streamResources.streamId,
        sendSocketPayload,
      });
      cleanup.stopResult = stopResult;
      if (stopResult.phase !== 'stopped') {
        recordError('stream-stop', new Error(`unexpected stop phase: ${stopResult.phase}`));
      }
    } catch (error) {
      cleanup.stopError = errorSummary(error);
      recordError('stream-stop', error);
    }
  }

  if (args.session) {
    try {
      args.session.runtime.dispose('remote-window client delivery probe cleanup');
      cleanup.pendingCountAfterDispose = args.session.runtime.getPendingCount();
      cleanup.pendingRequestIdsAfterDispose = args.session.runtime.getPendingRequestIds();
      if (cleanup.pendingCountAfterDispose !== 0) {
        recordError(
          'runtime-dispose',
          new Error(`runtime still has ${cleanup.pendingCountAfterDispose} pending requests after dispose`),
        );
      }
    } catch (error) {
      cleanup.runtimeDisposeError = errorSummary(error);
      recordError('runtime-dispose', error);
    }
  }

  if (args.streamResources?.videoSink) {
    try {
      args.streamResources.videoSink.stop();
      cleanup.sink = {
        stopped: args.streamResources.videoSink.stopped,
        stopError: null,
      };
      if (!cleanup.sink.stopped) {
        recordError('video-sink-stop', new Error('RTCVideoSink reported stopped=false after stop()'));
      }
    } catch (error) {
      cleanup.sink = {
        stopped: args.streamResources.videoSink.stopped,
        stopError: errorSummary(error),
      };
      recordError('video-sink-stop', error);
    }
  }

  if (args.peerConnection) {
    const peerConnection = args.peerConnection;
    let closeError: unknown = null;
    try {
      peerConnection.close();
    } catch (error) {
      closeError = errorSummary(error);
      recordError('peer-close', error);
    }
    cleanup.peer = {
      connectionState: peerConnection.connectionState,
      iceConnectionState: peerConnection.iceConnectionState,
      signalingState: peerConnection.signalingState,
      closeError,
    };
  }

  if (args.sessionSocket) {
    const readyStateBefore = args.sessionSocket.readyState;
    try {
      const closeEvent = await closeWebSocketWithin(args.sessionSocket, OWNED_STREAM_SHUTDOWN_TIMEOUT_MS);
      cleanup.socket = {
        readyStateBefore,
        closeEvent,
        closeError: closeEvent ? null : errorSummary(new Error('websocket close timed out')),
      };
      if (!closeEvent && args.sessionSocket.readyState !== WebSocket.CLOSED) {
        recordError('socket-close', new Error(`websocket did not emit close; readyState=${args.sessionSocket.readyState}`));
      }
    } catch (error) {
      cleanup.socket = {
        readyStateBefore,
        closeEvent: null,
        closeError: errorSummary(error),
      };
      recordError('socket-close', error);
    }
  }

  if (args.proxy) {
    try {
      await args.proxy.close();
      cleanup.proxy = {
        heldAckCountAfterClose: args.proxy.heldAckCount,
        closeError: null,
      };
      if (args.proxy.heldAckCount !== 0) {
        recordError('proxy-close', new Error(`proxy retained ${args.proxy.heldAckCount} held ACKs after close`));
      }
    } catch (error) {
      cleanup.proxy = {
        heldAckCountAfterClose: args.proxy.heldAckCount,
        closeError: errorSummary(error),
      };
      recordError('proxy-close', error);
    }
  }

  try {
    cleanup.document.closed = closeOwnedDocument();
    cleanup.document.existsAfter = ownedDocumentExists();
    if (cleanup.document.existsAfter) {
      recordError('document-close', new Error(`owned TextEdit document still exists: ${DOC_NAME}`));
    }
  } catch (error) {
    cleanup.document.closeError = errorSummary(error);
    try {
      cleanup.document.existsAfter = ownedDocumentExists();
    } catch {
      cleanup.document.existsAfter = true;
    }
    recordError('document-close', error);
  }

  try {
    if (!KEEP_TMP) {
      rmSync(args.docDir, { recursive: true, force: true });
    }
    cleanup.tmp.existsAfter = existsSync(args.docDir);
    if (!KEEP_TMP && cleanup.tmp.existsAfter) {
      recordError('tmp-remove', new Error(`probe temp dir still exists: ${args.docDir}`));
    }
  } catch (error) {
    cleanup.tmp.removeError = errorSummary(error);
    cleanup.tmp.existsAfter = existsSync(args.docDir);
    recordError('tmp-remove', error);
  }

  return cleanup;
}

async function runCase(caseName: CaseName, daemonUrl: string, outputDir: string) {
  const docDir = mkdtempSync(join(tmpdir(), `zterm-input-delivery-${caseName}-`));
  const sessionId = `zterm-input-delivery-${RUN_ID}`;
  const evidencePath = join(outputDir, `input-delivery-${caseName}-${RUN_ID}.json`);
  mkdirSync(outputDir, { recursive: true });
  const evidence: Record<string, unknown> = {
    case: caseName,
    runId: RUN_ID,
    daemonUrl: redactUrl(daemonUrl),
    startedAt: new Date().toISOString(),
    documentName: DOC_NAME,
    documentDir: docDir,
    candidate: {
      scriptSha256: currentScriptSha256(),
      wrtcPackagePath: wrtcPackagePath(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  let proxy: DeliveryProxy | null = null;
  let session: ProbeRuntime | null = null;
  let sessionSocket: WebSocket | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let streamResources: OwnedStreamResources | null = null;
  let failure: unknown = null;
  try {
    const fixtureSeed = (caseName === 'baseline-burst' || caseName === 'high-rtt-burst')
      ? CAPITALIZATION_NEUTRAL_SEED
      : '';
    evidence.fixtureSeed = fixtureSeed;
    openOwnedDocument(docDir, fixtureSeed);
    await delay(1200);
    const textEditPid = readTextEditPid();
    evidence.textEditPid = textEditPid;
    const caretBefore = await forceOwnedCaretToEnd(textEditPid);
    evidence.axBefore = caretBefore;
    evidence.axCaretBefore = caretBefore.caretAfter ?? caretBefore.caret ?? null;

    const wsUrl = caseName === 'baseline-burst'
      ? daemonUrl
      : (proxy = await startDeliveryProxy(daemonUrl)).url;
    evidence.wsUrl = redactUrl(wsUrl);
    evidence.proxyUrl = proxy ? redactUrl(proxy.url) : null;

    sessionSocket = new WebSocket(wsUrl);
    await waitForWebSocketOpen(sessionSocket, wsUrl);
    session = connectRuntime(sessionSocket);
    const target = await waitForOwnedTarget(session, sessionId, textEditPid);
    evidence.targetId = target.streamTargetId;
    evidence.targetPid = target.videoTarget.pid;
    evidence.targetWindowId = target.videoTarget.windowId;
    evidence.targetTitle = target.videoTarget.title;
    evidence.targetManifest = target;

    peerConnection = new RTCPeerConnection({ iceServers: [] });
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    streamResources = createOwnedStreamResources(requestId('stream'), peerConnection);
    await startOwnedStream(session, sessionId, target, streamResources);
    evidence.streamId = streamResources.streamId;
    evidence.videoFrames = frameEvidence(streamResources);

    const focusEvent: RemoteWindowInputEventPayload['event'] = { kind: 'focus' };

    if (caseName === 'baseline-burst') {
      const sequences: string[] = [];
      sequences.push(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, focusEvent));
      for (const event of buildRemoteWindowTextInputEvents(TEXT)) {
        sequences.push(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, event));
      }
      for (const event of buildRemoteWindowKeyInputEventsFromSequence('\r')) {
        sequences.push(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, event));
      }
      const settled = await waitForOutcomes(session, sequences, 30000);
      assertAllDelivered(settled, 'baseline-burst');
      await delay(800);
      const axAfter = runAxFixture(textEditPid, 'read');
      const body = readOwnedDocumentBody();
      evidence.axAfter = axAfter;
      evidence.axCaretAfter = axAfter.caret ?? null;
      evidence.osBody = body;
      evidence.axBody = axAfter.value ?? null;
      evidence.outcomes = settled;
      assertOwnedBodyFromAx(axAfter, EXPECTED_BASELINE_BODY, 'baseline-burst');
    } else if (caseName === 'high-rtt-burst') {
      if (!proxy) {
        fail('high-rtt-burst requires the delay proxy');
      }
      proxy.setPolicy({ match: 'all', mode: 'delay', delayMs: HIGH_RTT_ACK_DELAY_MS });
      const sequences: string[] = [];
      const enqueuedAt = new Map<string, number>();
      const enqueue = (sequence: string) => {
        enqueuedAt.set(sequence, Date.now());
        sequences.push(sequence);
      };
      enqueue(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, focusEvent));
      for (const char of TEXT) {
        for (const event of buildRemoteWindowTextInputEvents(char)) {
          enqueue(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, event));
        }
      }
      for (const event of buildRemoteWindowKeyInputEventsFromSequence('\r')) {
        enqueue(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, event));
      }
      const settled = await waitForOutcomes(session, sequences, 60000);
      assertAllDelivered(settled, 'high-rtt-burst');
      await delay(800);
      const axAfter = runAxFixture(textEditPid, 'read');
      const body = readOwnedDocumentBody();
      evidence.axAfter = axAfter;
      evidence.axCaretAfter = axAfter.caret ?? null;
      evidence.osBody = body;
      evidence.axBody = axAfter.value ?? null;
      assertOwnedBodyFromAx(axAfter, EXPECTED_BASELINE_BODY, 'high-rtt-burst');
      const dispatchTimes = dispatchTimesBySequence(proxy.records);
      const queueWaits = sequences.map((sequence) => ({
        sequence,
        waitMs: (dispatchTimes.get(sequence) ?? 0) - (enqueuedAt.get(sequence) ?? 0),
      }));
      const maxQueueWaitMs = Math.max(...queueWaits.map((entry) => entry.waitMs));
      evidence.maxQueueWaitMs = maxQueueWaitMs;
      evidence.queueWaits = queueWaits;
      evidence.osBody = body;
      evidence.outcomes = settled;
      if (maxQueueWaitMs <= LEGACY_RELIABLE_AGE_DEADLINE_MS) {
        fail(`high-rtt-burst did not queue any input past the legacy ${LEGACY_RELIABLE_AGE_DEADLINE_MS}ms age deadline; maxQueueWaitMs=${maxQueueWaitMs}`);
      }
    } else if (caseName === 'queued-cancel') {
      if (!proxy) {
        fail('queued-cancel requires the delay proxy');
      }
      const focusSequence = sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, focusEvent);
      proxy.setPolicy({
        match: 'sequence',
        sequence: focusSequence,
        mode: 'delay',
        delayMs: QUEUED_CANCEL_ACK_DELAY_MS,
      });
      const textSequences: string[] = [];
      for (const char of 'queued') {
        for (const event of buildRemoteWindowTextInputEvents(char)) {
          textSequences.push(sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, event));
        }
      }
      const stopPromise = session.runtime.stopStream(sessionId, {
        ws: session.bridge,
        streamId: streamResources.streamId,
        sendSocketPayload,
      });
      const settled = await waitForOutcomes(session, [focusSequence, ...textSequences], 15000);
      try {
        evidence.caseStopResult = await stopPromise;
      } catch (error) {
        evidence.caseStopError = errorSummary(error);
      }
      assertOutcome(settled.find((outcome) => outcome.sequence === focusSequence), {
        status: 'cancelled',
        source: 'client-teardown',
        execution: 'unconfirmed',
      }, 'queued-cancel focus');
      textSequences.forEach((sequence, index) => {
        assertOutcome(settled.find((outcome) => outcome.sequence === sequence), {
          status: 'cancelled',
          source: 'client-teardown',
          execution: 'not-dispatched',
        }, `queued-cancel text[${index}]`);
      });
      const textWire = proxy.records.filter((record) => (
        record.direction === 'client-to-daemon'
        && isReliableInputMessage(record.message)
        && textSequences.includes(record.message.control.sequence)
      ));
      if (textWire.length > 0) {
        fail(`queued-cancel text actions reached the wire: ${JSON.stringify(textWire)}`);
      }
      const axAfter = runAxFixture(textEditPid, 'read');
      const body = readOwnedDocumentBody();
      evidence.axAfter = axAfter;
      evidence.axCaretAfter = axAfter.caret ?? null;
      evidence.axBody = axAfter.value ?? null;
      if (!axAfter.ok || typeof axAfter.value !== 'string' || axAfter.value.length > 0) {
        fail(`queued-cancel produced OS text in the AX document buffer: ${JSON.stringify(axAfter)}`);
      }
      proxy.releaseHeldAcks();
      await delay(500);
      const focusOutcomes = session.outcomes.filter((outcome) => outcome.sequence === focusSequence);
      if (focusOutcomes.length !== 1) {
        fail(`queued-cancel late focus ACK produced ${focusOutcomes.length} outcomes`);
      }
      evidence.focusSequence = focusSequence;
      evidence.textSequences = textSequences;
      evidence.outcomes = session.outcomes;
      evidence.osBody = body;
    } else {
      if (!proxy) {
        fail('ack-drop requires the delay proxy');
      }
      const focusSequence = sendAction(session, sessionId, streamResources.streamId, target.streamTargetId, focusEvent);
      proxy.setPolicy({ match: 'sequence', sequence: focusSequence, mode: 'hold' });
      const settled = await waitForOutcomes(session, [focusSequence], 15000);
      assertOutcome(settled[0], {
        status: 'failed',
        source: 'client-timeout',
        execution: 'unconfirmed',
      }, 'ack-drop focus');
      const attempts = proxy.records.filter((record) => (
        record.direction === 'client-to-daemon'
        && isReliableInputMessage(record.message)
        && record.message.control.sequence === focusSequence
      ));
      if (attempts.length !== 2) {
        fail(`ack-drop expected exactly 2 same-sequence attempts, got ${attempts.length}`);
      }
      const acks = proxy.records.filter((record) => (
        record.direction === 'daemon-to-client'
        && isInputAckMessage(record.message)
        && record.message.control.sequence === focusSequence
      ));
      const duplicateAcks = acks.filter((record) => (
        (record.message as { control?: { duplicate?: boolean } }).control?.duplicate === true
      ));
      if (duplicateAcks.length < 1) {
        fail(`ack-drop did not observe a daemon dedupe ACK; acks=${JSON.stringify(acks)}`);
      }
      proxy.releaseHeldAcks();
      await delay(500);
      const focusOutcomes = session.outcomes.filter((outcome) => outcome.sequence === focusSequence);
      if (focusOutcomes.length !== 1) {
        fail(`ack-drop late ACK produced ${focusOutcomes.length} outcomes`);
      }
      evidence.focusSequence = focusSequence;
      evidence.attemptCount = attempts.length;
      evidence.attempts = attempts;
      evidence.acks = acks;
      evidence.outcomes = session.outcomes;
      evidence.frontmostPidAfter = readFrontmostPid();
    }

    evidence.listenerErrors = session.listenerErrors;
    if (session.listenerErrors.length > 0) {
      fail(`unexpected runtime listener errors: ${JSON.stringify(session.listenerErrors)}`);
    }
    if (proxy?.error) {
      fail(`delivery proxy upstream error: ${proxy.error.message}`);
    }
  } catch (error) {
    failure = error;
    evidence.failure = errorSummary(error);
  }

  evidence.videoFrames = streamResources ? frameEvidence(streamResources) : null;
  evidence.statuses = session?.statuses ?? [];
  evidence.wireRecords = session?.wireRecords ?? [];
  evidence.outcomes = session?.outcomes ?? [];
  evidence.listenerErrors = session?.listenerErrors ?? [];
  evidence.completedAt = new Date().toISOString();

  let cleanup: CleanupEvidence;
  try {
    cleanup = await cleanupOwnedResources({
      session,
      sessionId,
      streamResources,
      peerConnection,
      sessionSocket,
      proxy,
      docDir,
    });
  } catch (error) {
    cleanup = {
      stopResult: null,
      stopError: null,
      runtimeDisposeError: null,
      pendingCountAfterDispose: null,
      pendingRequestIdsAfterDispose: null,
      sink: null,
      peer: null,
      socket: null,
      proxy: null,
      document: {
        closed: false,
        existsAfter: true,
        closeError: errorSummary(error),
      },
      tmp: {
        path: docDir,
        kept: KEEP_TMP,
        existsAfter: existsSync(docDir),
        removeError: null,
      },
      errors: [{ stage: 'cleanup-fatal', error: errorSummary(error) }],
    };
  }
  evidence.cleanup = cleanup;
  evidence.ok = failure === null && cleanup.errors.length === 0;
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');

  if (failure) {
    throw failure;
  }
  if (cleanup.errors.length > 0) {
    throw new Error(`probe cleanup failed; evidence=${evidencePath}; errors=${JSON.stringify(cleanup.errors)}`);
  }
  console.log(JSON.stringify({ ok: true, case: caseName, evidencePath, evidence }, null, 2));
}

function printHelp() {
  console.log(`Remote window client delivery live probe

Usage:
  pnpm --dir android exec tsx scripts/remote-window-client-delivery-live-probe.ts \\
    --case <case> [--output-dir <dir>]

Cases:
  baseline-burst   No proxy; full text + Enter through the real client delivery owner.
  queued-cancel    Delay the first focus action ACK, queue text actions, then stop; queued text cancels with no wire/OS text.
  ack-drop         Hold both same-sequence ACK attempts past the retry bound, then release the late ACK.
  high-rtt-burst   Delay every ACK so later queued items wait past the legacy 8s age deadline, then dispatch.

Environment:
  ZTERM_INPUT_PROBE_WS_URL        Daemon WebSocket URL (default ws://127.0.0.1:3333).
  ZTERM_INPUT_PROBE_AUTH_TOKEN    Token for a non-loopback daemon URL.
  ZTERM_INPUT_PROBE_KEEP_TMP=1    Keep the probe temp dir instead of removing it.

This probe drives the real createRemoteWindowMessageRuntime + subscribeInputOutcome against the
canonical daemon and an owned TextEdit document; it never mocks daemon ACKs or reads private state.
Live cases must run serially, one case per invocation.`);
}

function parseArgs(argv: string[]) {
  let caseName: string | undefined;
  let outputDir: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--case') {
      caseName = argv[index += 1];
    } else if (arg.startsWith('--case=')) {
      caseName = arg.slice('--case='.length);
    } else if (arg === '--output-dir') {
      outputDir = argv[index += 1];
    } else if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { help, caseName, outputDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.caseName) {
    printHelp();
    fail('missing required --case');
  }
  if (!CASE_NAMES.includes(args.caseName as CaseName)) {
    fail(`unknown case: ${args.caseName}; expected one of ${CASE_NAMES.join(', ')}`);
  }
  const daemonUrl = resolveDaemonWebSocketUrl(process.env.ZTERM_INPUT_PROBE_WS_URL || DEFAULT_DAEMON_URL);
  const outputDir = args.outputDir || join(tmpdir(), `zterm-input-delivery-evidence-${RUN_ID}`);
  await runCase(args.caseName as CaseName, daemonUrl, outputDir);
}

// Native teardown guard. The probe holds a real @roamhq/wrtc RTCVideoSink +
// RTCRtpReceiver on a live receiver track. @roamhq/wrtc 0.10.0's native
// MediaStreamTrack RefPtr finalizer crashes inside node::CleanupQueue::Drain()
// at process exit (SIGSEGV / rc 139) once the sink was created, even though the
// probe already stops the sink, closes the peer connection and releases every
// pending request. This is an upstream native teardown bug, not product input
// logic. Draining the V8 heap here makes the receiver-track finalizer run while
// the event loop is still alive (it is then a no-op) instead of during
// CleanupQueue::Drain. This does NOT fake the exit code: the process still
// returns rc 0/1 through the normal `process.exitCode` path and all probe
// assertions/cleanup above are already complete.
function drainNativeTeardown() {
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as (() => void) | undefined;
    gc?.();
    gc?.();
  } catch {
    // Non-fatal: on a runtime without GC access the upstream teardown bug may
    // still surface as rc 139; never mask a real probe result with this guard.
  }
}

main().then(() => {
  drainNativeTeardown();
  process.exitCode = 0;
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  drainNativeTeardown();
  process.exitCode = 1;
});

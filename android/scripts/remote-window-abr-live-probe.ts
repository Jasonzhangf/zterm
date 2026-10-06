#!/usr/bin/env node
/**
 * Remote window ABR live consumer probe.
 *
 * Owner/scope: sole artifact of the ABR public-consumer task. Drives only the
 * REAL public client surfaces (hook / message-runtime / receiver-runtime) against
 * a live daemon; never touches product hook/quality/backend/lockfiles/native.
 *
 * Transport: plain legacy WebSocket (no mux negotiation) - documented allowed
 * when the client has not negotiated mux; a negotiated mux transport must use
 * the existing wrapper instead (this probe never negotiates).
 *
 * Cases: `baseline` (real manual 8Mbps/30FPS hook intent + matching ACK +
 * continuity + stop/error), `pressure-recovery` (owned stdlib dgram UDP relay
 * signals the two public peers to opposite relay candidates; real bounded
 * delay/drop produce real receiving stats -> adaptive quality request ->
 * matching installed ACK -> decoded frames -> >12s real recovery), and
 * `manual-inflight` (a manual hook intent is queued behind a real in-flight
 * adaptive request; a controlled signal-transport hold orders the real ACKs so
 * the stale adaptive completion cannot replace the newer manual policy).
 *
 * This is a consumer definition, never an ABR functional PASS. Only Root runs
 * the installed E2E after the final daemon restart.
 *
 * Definition checks (no live run): --help (0), --preflight (0), invalid args (1).
 * Live run (Root after installed daemon B): --case <case> --daemon-url ...
 * --session-id <existing-actual> --target-id <owned-canonical>
 * --wrtc-package-root <explicit-genuine> [--addon-path <actual-compiled-addon>]
 * --output-dir <dir>.
 */
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { act, createElement, useState } from 'react';
import type { RawData, WebSocket as WsWebSocket } from 'ws';

import { createRemoteWindowMessageRuntime, isRemoteWindowControlMessage } from '../src/lib/remote-window-message-runtime';
import { createRemoteWindowReceiverRuntime, type RemoteWindowReceiverStartResult } from '../src/lib/remote-window-receiver-runtime';
import { resolveDaemonRuntimeConfig } from '../src/server/daemon-config';
import { buildRemoteWindowVideoProfile, type RemoteWindowVideoStatsSample } from '../src/lib/remote-window-video-quality';
import { useRemoteWindowQuality, type UseRemoteWindowQualityOptions } from '../src/components/terminal/useRemoteWindowQuality';
import type {
  BridgeSocketCloseLike, BridgeSocketMessageLike, BridgeTransportSocket, TraversalDiagnostics,
} from '../src/lib/traversal/types';
import type {
  RemoteWindowStreamIceCandidatePayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamStatusPayload,
} from '../src/lib/types';

const RUN_ID = `${Date.now()}-${process.pid}`;
const DEFAULT_DAEMON_URL = 'ws://127.0.0.1:3333';
const STREAM_READY_TIMEOUT_MS = 25_000;
const QUALITY_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 20_000;
const WS_READY_STATE_CLOSED = 3;
const SOCKET_CLOSE_TIMEOUT_MS = 10_000;
const PEER_CONNECTION_CLOSE_TIMEOUT_MS = 5_000;

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

interface RTCVideoFrameLike { width: number; height: number; data: Uint8Array }
interface RTCVideoSinkLike { onframe: ((e: { frame: RTCVideoFrameLike }) => void) | null; stop(): void; readonly stopped: boolean }
interface WrtcModule {
  RTCPeerConnection: typeof RTCPeerConnection;
  MediaStream: typeof MediaStream;
  nonstandard: { RTCVideoSink: new (track: MediaStreamTrack) => RTCVideoSinkLike };
}
interface LoadedWrtc { wrtc: WrtcModule; packageRoot: string; addonPath: string; addonRealPath: string; addonSha256: string; addonBytes: number }

const PRODUCT_PUBLIC_FILES = [
  'src/components/terminal/useRemoteWindowQuality.ts',
  'src/lib/remote-window-message-runtime.ts',
  'src/lib/remote-window-receiver-runtime.ts',
] as const;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sha256File = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');

function scriptSha256(): string { return sha256File(new URL(import.meta.url).pathname); }
function productDigest(): Record<string, string> {
  const here = dirname(new URL(import.meta.url).pathname);
  const result: Record<string, string> = {};
  for (const relative of PRODUCT_PUBLIC_FILES) {
    const full = resolve(here, '..', relative);
    result[relative] = existsSync(full) ? sha256File(full) : 'missing';
  }
  return result;
}

function parseNonNegativeInt(raw: string | null, name: string): number {
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) { throw new UsageError(`${name} must be a non-negative integer; got ${raw ?? '<missing>'}`); }
  return value;
}

function parsePositiveInt(raw: string | null, name: string): number {
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) { throw new UsageError(`${name} must be a positive integer; got ${raw ?? '<missing>'}`); }
  return value;
}

function parseRatio(raw: string | null, name: string): number {
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) { throw new UsageError(`${name} must be a ratio in [0,1]; got ${raw ?? '<missing>'}`); }
  return value;
}

interface AbrProbeArgs {
  mode: 'help' | 'preflight' | 'live';
  caseName: string | null;
  daemonUrl: string | null;
  sessionId: string | null;
  targetId: string | null;
  wrtcPackageRoot: string | null;
  addonPath: string | null;
  outputDir: string | null;
  pressureDelayMs: number | null;
  pressureDropRatio: number | null;
  recoverySeconds: number | null;
  manualCapBps: number | null;
}

function parseArgs(argv: string[]): AbrProbeArgs {
  const args: AbrProbeArgs = { mode: 'live', caseName: null, daemonUrl: null, sessionId: null, targetId: null, wrtcPackageRoot: null, addonPath: null, outputDir: null, pressureDelayMs: null, pressureDropRatio: null, recoverySeconds: null, manualCapBps: null };
  let help = false;
  let preflight = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') { help = true; }
    else if (arg === '--preflight') { preflight = true; }
    else if (arg === '--case' || arg.startsWith('--case=')) { args.caseName = arg === '--case' ? (argv[++i] ?? null) : arg.slice(7); }
    else if (arg === '--daemon-url' || arg.startsWith('--daemon-url=')) { args.daemonUrl = arg === '--daemon-url' ? (argv[++i] ?? null) : arg.slice(13); }
    else if (arg === '--session-id' || arg.startsWith('--session-id=')) { args.sessionId = arg === '--session-id' ? (argv[++i] ?? null) : arg.slice(13); }
    else if (arg === '--target-id' || arg.startsWith('--target-id=')) { args.targetId = arg === '--target-id' ? (argv[++i] ?? null) : arg.slice(12); }
    else if (arg === '--wrtc-package-root' || arg.startsWith('--wrtc-package-root=')) { args.wrtcPackageRoot = arg === '--wrtc-package-root' ? (argv[++i] ?? null) : arg.slice(20); }
    else if (arg === '--addon-path' || arg.startsWith('--addon-path=')) { args.addonPath = arg === '--addon-path' ? (argv[++i] ?? null) : arg.slice(13); }
    else if (arg === '--output-dir' || arg.startsWith('--output-dir=')) { args.outputDir = arg === '--output-dir' ? (argv[++i] ?? null) : arg.slice(13); }
    else if (arg === '--pressure-delay-ms' || arg.startsWith('--pressure-delay-ms=')) { args.pressureDelayMs = parseNonNegativeInt(arg === '--pressure-delay-ms' ? (argv[++i] ?? null) : arg.slice(19), '--pressure-delay-ms'); }
    else if (arg === '--pressure-drop-ratio' || arg.startsWith('--pressure-drop-ratio=')) { args.pressureDropRatio = parseRatio(arg === '--pressure-drop-ratio' ? (argv[++i] ?? null) : arg.slice(21), '--pressure-drop-ratio'); }
    else if (arg === '--recovery-seconds' || arg.startsWith('--recovery-seconds=')) { args.recoverySeconds = parsePositiveInt(arg === '--recovery-seconds' ? (argv[++i] ?? null) : arg.slice(18), '--recovery-seconds'); }
    else if (arg === '--manual-cap-bps' || arg.startsWith('--manual-cap-bps=')) { args.manualCapBps = parsePositiveInt(arg === '--manual-cap-bps' ? (argv[++i] ?? null) : arg.slice(17), '--manual-cap-bps'); }
    else { throw new UsageError(`unknown argument: ${arg}`); }
  }
  if (help) { args.mode = 'help'; return args; }
  args.mode = preflight ? 'preflight' : 'live';
  if (args.mode === 'live' || args.mode === 'preflight') {
    const CASES = new Set(['baseline', 'pressure-recovery', 'manual-inflight']);
    if (!args.caseName || !CASES.has(args.caseName)) { throw new UsageError(`--case must be one of baseline|pressure-recovery|manual-inflight; got ${args.caseName ?? '<missing>'}`); }
    for (const [name, value] of [['--daemon-url', args.daemonUrl], ['--session-id', args.sessionId], ['--target-id', args.targetId], ['--wrtc-package-root', args.wrtcPackageRoot], ['--output-dir', args.outputDir]] as const) {
      if (!value || value.trim() === '') { throw new UsageError(`missing required ${name}`); }
    }
    if (args.sessionId!.trim() === '' || args.targetId!.trim() === '') { throw new UsageError('--session-id and --target-id must be non-empty'); }
    try {
      const url = new URL(args.daemonUrl!);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') { throw new Error('not ws(s)'); }
    } catch { throw new UsageError(`--daemon-url must be ws:// or wss://; got ${args.daemonUrl}`); }
  }
  return args;
}

const SELF_CHECK_ARGV = ['--preflight', '--case', 'baseline', '--daemon-url', DEFAULT_DAEMON_URL, '--session-id', 'self-check-session', '--target-id', 'self-check-target', '--wrtc-package-root', 'self-check-root', '--output-dir', 'self-check-out'];

function printHelp(): void {
  console.log(`Remote window ABR live consumer probe

Usage:
  node --import tsx scripts/remote-window-abr-live-probe.ts --help
  node --import tsx scripts/remote-window-abr-live-probe.ts --preflight \\
    --case baseline --daemon-url ws://127.0.0.1:3333 --session-id <id> --target-id <id> \\
    --wrtc-package-root <dir> [--addon-path <file>] --output-dir <dir>
  ... --case baseline --daemon-url <ws-url> --session-id <existing-actual> \\
    --target-id <owned-canonical> --wrtc-package-root <dir> \\
    [--addon-path <actual-compiled-addon>] --output-dir <dir>
  ... --case pressure-recovery [--pressure-delay-ms 250] [--pressure-drop-ratio 0.8] \\
    [--recovery-seconds 13] <same required flags>
  ... --case manual-inflight [--manual-cap-bps 6000000] <same required flags>

--help       Print help and exit (no native/network/DOM side effects).
--preflight  Bounded read-only dependency + CLI verification; exit 0 on OK.
--case       baseline | pressure-recovery | manual-inflight.
--daemon-url Daemon WebSocket URL. Loopback auth comes from the daemon runtime
             config; the token is never printed.
--session-id Existing/actual session id to carry remote-window control.
--target-id  Owned canonical target id from the daemon target catalog.
--wrtc-package-root  Directory used to resolve @roamhq/wrtc JS.
--addon-path Optional exact compiled addon (.node); exact bytes are loaded and
             digested with no prebuilt fallback. Omitted -> unique wrtc.node in
             the resolved platform package is used.
--output-dir Evidence JSON + raw wire JSON output directory.
--pressure-delay-ms  pressure-recovery only: bounded one-way relay delay in ms
             applied to real packets (default 400).
--pressure-drop-ratio pressure-recovery only: fraction of relay B->A packets
             deliberately dropped to create real receiving pressure (default 0.8).
--recovery-seconds pressure-recovery only: real recovery window observed after
             pressure clears (default 13; >12 proves restore policy).
--manual-cap-bps manual-inflight only: manual group total cap in bits/s
             submitted while a real adaptive request is in flight (default 6000000).

Baseline: plain legacy WS -> receiver.startStream(v2) -> RTCVideoSink full I420
-> mount useRemoteWindowQuality -> user manual 8Mbps/30FPS intent via the hook ->
correlate requestId/revision/group/target ACK + applied projection ->
>=3 dynamic complete frames before/after + same peer/MID/ICE -> public stop ->
real quality-after-stop error -> natural cleanup (no process.exit).

pressure-recovery: baseline session -> two owned stdlib dgram UDP4 relays signal
the real client/daemon peers to opposite relay candidates (selected pair and
relay counters prove no direct bypass) -> real delay/drop -> real receiving
stats -> adaptive quality request -> matching installed ACK -> decoded frames ->
pressure cleared -> >12s real recovery observes the restore policy.

manual-inflight: real adaptive update in flight -> a controlled signal-transport
hold orders the real ACKs -> manual hook intent queued behind it -> matching
manual ACK/frames -> controlled replay of the older adaptive ACK bytes cannot
replace the manual cap/revision or emit a new quality request -> continuing
decoded frames. Held and replayed payloads/results are actual daemon values;
the replay is recorded separately from network reception.`);
}

function runPreflight(args: AbrProbeArgs): number {
  const requireFromScript = createRequire(import.meta.url);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: 'node', ok: true, detail: process.version },
    { name: 'platform', ok: true, detail: `${process.platform}/${process.arch}` },
  ];
  for (const spec of ['ws', 'react', 'react-dom', 'react-dom/client', 'jsdom', '@zterm/shared/protocol'] as const) {
    try { checks.push({ name: `resolve:${spec}`, ok: true, detail: requireFromScript.resolve(spec) }); }
    catch (error) { checks.push({ name: `resolve:${spec}`, ok: false, detail: messageOf(error) }); }
  }
  try {
    const anchored = createRequire(join(resolve(args.wrtcPackageRoot!), 'package.json'));
    const wrtcMain = anchored.resolve('@roamhq/wrtc');
    const platformMain = createRequire(wrtcMain).resolve('@roamhq/wrtc-darwin-arm64');
    const candidate = args.addonPath ? resolve(args.addonPath) : join(dirname(platformMain), 'wrtc.node');
    const exists = existsSync(candidate);
    checks.push({ name: 'wrtc', ok: exists, detail: exists ? `${realpathSync(candidate)} sha256=${sha256File(candidate)} bytes=${statSync(candidate).size}` : `missing addon: ${candidate}` });
  } catch (error) { checks.push({ name: 'wrtc', ok: false, detail: messageOf(error) }); }
  try {
    const parsed = parseArgs(SELF_CHECK_ARGV);
    if (parsed.mode !== 'preflight' || parsed.caseName !== 'baseline') { throw new Error(`self-check parse mismatch: ${JSON.stringify(parsed)}`); }
    checks.push({ name: 'cli:self-check', ok: true, detail: 'canonical CLI parsed OK' });
  } catch (error) { checks.push({ name: 'cli:self-check', ok: false, detail: messageOf(error) }); }
  try {
    const pressure = parseArgs(['--case', 'pressure-recovery', '--daemon-url', DEFAULT_DAEMON_URL, '--session-id', 'self-check-session', '--target-id', 'self-check-target', '--wrtc-package-root', 'self-check-root', '--output-dir', 'self-check-out', '--pressure-delay-ms', '250', '--pressure-drop-ratio', '0.8', '--recovery-seconds', '13']);
    const manual = parseArgs(['--case', 'manual-inflight', '--daemon-url', DEFAULT_DAEMON_URL, '--session-id', 'self-check-session', '--target-id', 'self-check-target', '--wrtc-package-root', 'self-check-root', '--output-dir', 'self-check-out', '--manual-cap-bps', '6000000']);
    if (pressure.pressureDelayMs !== 250 || pressure.pressureDropRatio !== 0.8 || pressure.recoverySeconds !== 13 || manual.manualCapBps !== 6_000_000) { throw new Error('case option parse mismatch'); }
    checks.push({ name: 'cli:self-check-cases', ok: true, detail: 'pressure-recovery/manual-inflight CLI parsed OK' });
  } catch (error) { checks.push({ name: 'cli:self-check-cases', ok: false, detail: messageOf(error) }); }
  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, mode: 'preflight', checks }, null, 2));
  return ok ? 0 : 1;
}

class ProbeBridgeSocket implements BridgeTransportSocket {
  readyState: number;
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;
  readonly transportOwnership = 'client' as const;
  constructor(private readonly socket: WsWebSocket, private readonly onSend?: (data: string | ArrayBuffer) => void) {
    this.readyState = socket.readyState;
    socket.on('message', (data: RawData) => { this.readyState = socket.readyState; this.onmessage?.({ data: data.toString() }); });
    socket.on('close', (code: number, reason: Buffer) => { this.readyState = socket.readyState; this.onclose?.({ code, reason: reason.toString() }); });
    socket.on('error', (error: Error) => { this.onerror?.(error as unknown as Event); });
  }
  send(data: string | ArrayBuffer): void { this.onSend?.(data); this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
  reportFailure(reason: string): void { this.onerror?.(new Error(reason) as unknown as Event); }
  getDiagnostics(): TraversalDiagnostics { return { mode: 'websocket', stage: this.readyState === 1 ? 'open' : 'closed', attempts: [] }; }
}

const sendSocketPayload = (_sessionId: string, socket: BridgeTransportSocket, data: string | ArrayBuffer) => { socket.send(data); };

async function waitForWebSocketOpen(socket: WsWebSocket, url: string, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === 1) { return; }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let timer: NodeJS.Timeout;
    const onOpen = () => { clearTimeout(timer); socket.off('error', onError); resolvePromise(); };
    const onError = (error: Error) => { clearTimeout(timer); socket.off('open', onOpen); rejectPromise(error); };
    timer = setTimeout(() => { socket.off('open', onOpen); socket.off('error', onError); rejectPromise(new Error(`websocket open timeout: ${url}`)); }, timeoutMs);
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function resolveDaemonWebSocketUrl(rawUrl: string): { url: string; tokenSource: string } {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) { return { url: url.toString(), tokenSource: 'url' }; }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const explicitToken = process.env.ZTERM_ABR_PROBE_AUTH_TOKEN?.trim();
  const token = explicitToken || (loopback ? resolveDaemonRuntimeConfig({ homeDir: homedir() }).authToken : '');
  if (!token) { throw new UsageError('requires ZTERM_ABR_PROBE_AUTH_TOKEN for a non-loopback daemon URL'); }
  url.searchParams.set('token', token);
  return { url: url.toString(), tokenSource: explicitToken ? 'env' : loopback ? 'loopback-config' : 'none' };
}

const redactUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) { url.searchParams.set('token', '<redacted>'); }
  return url.toString();
};

function loadWrtc(wrtcPackageRoot: string, explicitAddonPath: string | null): LoadedWrtc {
  const anchored = createRequire(join(resolve(wrtcPackageRoot), 'package.json'));
  const wrtcMain = anchored.resolve('@roamhq/wrtc');
  const platformMain = createRequire(wrtcMain).resolve('@roamhq/wrtc-darwin-arm64');
  const candidateAddon = explicitAddonPath ? resolve(explicitAddonPath) : join(dirname(platformMain), 'wrtc.node');
  if (!existsSync(candidateAddon)) { throw new Error(`wrtc addon not found: ${candidateAddon}`); }
  // Refuse a prebuilt shadow that binding.js would load before the explicit
  // addon; never silently load the wrong binary.
  const wrtcPkgDir = resolve(dirname(wrtcMain), '..');
  const shadow = join(wrtcPkgDir, `build-${process.platform}-${process.arch}`, 'wrtc.node');
  if (existsSync(shadow) && realpathSync(shadow) !== realpathSync(candidateAddon)) {
    throw new Error(`prebuilt shadow would win over explicit addon: ${shadow} vs ${candidateAddon}`);
  }
  const addonRealPath = realpathSync(candidateAddon);
  const addonSha256 = sha256File(addonRealPath);
  const addonBytes = statSync(addonRealPath).size;
  const platformExports = anchored(candidateAddon) as unknown;
  anchored.cache[platformMain] = { id: platformMain, filename: platformMain, loaded: true, exports: platformExports, children: [], paths: [] } as unknown as NodeModule;
  const wrtc = anchored('@roamhq/wrtc') as unknown as WrtcModule;
  const usedEntry = anchored.cache[platformMain];
  if (!usedEntry || usedEntry.exports !== platformExports) { throw new Error('failed to prove the explicit addon was loaded by @roamhq/wrtc'); }
  return { wrtc, packageRoot: resolve(wrtcPackageRoot), addonPath: candidateAddon, addonRealPath, addonSha256, addonBytes };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      if (predicate()) { resolvePromise(); return; }
      if (Date.now() - startedAt >= timeoutMs) { rejectPromise(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(poll, 100);
    };
    poll();
  });
}

const parseWire = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return raw; } };

interface WireRecord { atMs: number; direction: 'client-to-daemon' | 'daemon-to-client'; message: unknown }
interface FrameLogEntry { atMs: number; frameId: number; sha256: string; committed: boolean }

function recentDistinctShas(log: FrameLogEntry[], filter: (entry: FrameLogEntry) => boolean, n: number): string[] {
  return [...new Set(log.filter(filter).slice(-n).map((entry) => entry.sha256))];
}

async function installDom(): Promise<{ window: Window & typeof globalThis; close: () => boolean }> {
  interface JsdomLike { window: Record<string, unknown> & { document: Document; close(): void } }
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: Record<string, unknown>) => JsdomLike };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
  const window = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as Record<string, unknown>;
  for (const [name, value] of [['window', window], ['document', window.document], ['navigator', window.navigator], ['HTMLElement', window.HTMLElement], ['Element', window.Element], ['Node', window.Node], ['Event', window.Event], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  }
  return {
    window,
    close: () => {
      let documentReleased = false;
      try {
        dom.window.close();
        documentReleased = (dom.window as { document?: unknown }).document === undefined;
      } catch { documentReleased = false; }
      for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT']) {
        try { delete (globalThis as Record<string, unknown>)[name]; } catch { /* ignore */ }
      }
      const globals = globalThis as Record<string, unknown>;
      return documentReleased && globals.window === undefined && globals.document === undefined;
    },
  };
}

type Root = { render(element: unknown): void; unmount(): void };
interface HookHarness {
  latest: ReturnType<typeof useRemoteWindowQuality> | null;
  update(next: Partial<UseRemoteWindowQualityOptions>): Promise<void>;
  unmount(): Promise<void>;
}
function createHookHarness(initial: UseRemoteWindowQualityOptions): { harness: HookHarness; mount: (container: HTMLElement, createRootFn: (c: HTMLElement) => Root) => Promise<void> } {
  const propsRef: { current: UseRemoteWindowQualityOptions } = { current: initial };
  let published: ReturnType<typeof useRemoteWindowQuality> | null = null;
  let root: Root = { render: () => {}, unmount: () => {} };
  let forceRender: () => void = () => {};
  const harness: HookHarness = {
    latest: null,
    async update(next) {
      propsRef.current = { ...propsRef.current, ...next };
      await act(async () => { forceRender(); });
    },
    async unmount() { await act(async () => { root.unmount(); }); },
  };
  const Consumer = () => {
    const [, setTick] = useState(0);
    forceRender = () => setTick((tick) => tick + 1);
    published = useRemoteWindowQuality(propsRef.current);
    harness.latest = published;
    return null;
  };
  const mount = async (container: HTMLElement, createRootFn: (c: HTMLElement) => Root) => {
    root = createRootFn(container);
    await act(async () => { root.render(createElement(Consumer)); });
  };
  return { harness, mount };
}

interface CleanupStepEvidence { invoked: boolean; released: boolean; detail: string }
interface CleanupEvidence {
  relay: CleanupStepEvidence;
  heldWire: CleanupStepEvidence;
  peerConnection: CleanupStepEvidence;
  sink: CleanupStepEvidence;
  track: CleanupStepEvidence;
  receiver: CleanupStepEvidence;
  message: CleanupStepEvidence;
  hook: CleanupStepEvidence;
  socket: CleanupStepEvidence;
  dom: CleanupStepEvidence;
  errors: string[];
  remainingResources: string[];
  released: boolean;
}
interface PendingHeldWire { raw: string; parsed: { type?: string; payload?: { requestId?: string } }; atMs: number }
interface LiveResources {
  relay: SignalRelay | null;
  heldWire: PendingHeldWire[];
  peerConnection: RTCPeerConnection | null;
  socket: WsWebSocket | null;
  bridge: ProbeBridgeSocket | null;
  messageRuntime: ReturnType<typeof createRemoteWindowMessageRuntime> | null;
  receiverRuntime: ReturnType<typeof createRemoteWindowReceiverRuntime> | null;
  stream: RemoteWindowReceiverStartResult | null;
  sink: RTCVideoSinkLike | null;
  track: MediaStreamTrack | null;
  hook: HookHarness | null;
  domClose: (() => boolean) | null;
}
async function cleanupResources(r: LiveResources): Promise<CleanupEvidence> {
  const errors: string[] = [];
  const remainingResources: string[] = [];
  const step = (name: string, run: () => CleanupStepEvidence): CleanupStepEvidence => {
    let result: CleanupStepEvidence;
    try { result = run(); }
    catch (error) {
      const detail = messageOf(error);
      errors.push(`${name}: ${detail}`);
      remainingResources.push(name);
      return { invoked: true, released: false, detail: `error: ${detail}` };
    }
    if (!result.released) { remainingResources.push(name); }
    return result;
  };
  const asyncStep = async (name: string, run: () => Promise<CleanupStepEvidence>): Promise<CleanupStepEvidence> => {
    let result: CleanupStepEvidence;
    try { result = await run(); }
    catch (error) {
      const detail = messageOf(error);
      errors.push(`${name}: ${detail}`);
      remainingResources.push(name);
      return { invoked: true, released: false, detail: `error: ${detail}` };
    }
    if (!result.released) { remainingResources.push(name); }
    return result;
  };
  const absent = (): CleanupStepEvidence => ({ invoked: false, released: true, detail: 'absent' });
  const relay = r.relay
    ? await asyncStep('relay', async () => {
        await r.relay!.stop();
        const released = r.relay!.released;
        return { invoked: true, released, detail: `released=${released}; pendingTimers=${r.relay!.pendingTimerCount}` };
      })
    : absent();
  const heldWire = step('heldWire', () => {
    const pending = r.heldWire.splice(0);
    return pending.length === 0
      ? { invoked: false, released: true, detail: 'none-held' }
      : { invoked: true, released: true, detail: `dropped=${pending.length}` };
  });
  const sink = step('sink', () => {
    if (!r.sink) { return absent(); }
    r.sink.onframe = null;
    r.sink.stop();
    return { invoked: true, released: r.sink.stopped === true, detail: `stopped=${r.sink.stopped}` };
  });
  const track = step('track', () => {
    if (!r.track) { return absent(); }
    r.track.stop();
    return { invoked: true, released: r.track.readyState === 'ended', detail: `readyState=${r.track.readyState}` };
  });
  const receiver = step('receiver', () => {
    if (!r.receiverRuntime) { return absent(); }
    let stoppedStream = false;
    if (r.stream) { stoppedStream = r.receiverRuntime.stopStream(r.stream.streamId); }
    r.receiverRuntime.dispose('probe cleanup');
    const active = r.receiverRuntime.getActiveStreamIds();
    return { invoked: true, released: active.length === 0, detail: `stopStream=${stoppedStream}; activeStreams=${active.length}` };
  });
  const peerConnection = await asyncStep('peerConnection', async () => {
    if (!r.peerConnection) { return absent(); }
    const pc = r.peerConnection;
    const isClosed = () => String(pc.connectionState) === 'closed';
    if (isClosed()) { return { invoked: false, released: true, detail: 'already-closed' }; }
    pc.close();
    try { await waitFor(() => String(pc.connectionState) === 'closed', 'peer connection closed', PEER_CONNECTION_CLOSE_TIMEOUT_MS); }
    catch { /* the state read below decides release */ }
    return { invoked: true, released: isClosed(), detail: `connectionState=${pc.connectionState}` };
  });
  const message = step('message', () => {
    if (!r.messageRuntime) { return absent(); }
    r.messageRuntime.dispose('probe cleanup');
    const pending = r.messageRuntime.getPendingCount();
    return { invoked: true, released: pending === 0, detail: `pendingRequests=${pending}` };
  });
  const hook = r.hook
    ? await asyncStep('hook', async () => {
        await r.hook!.unmount();
        return { invoked: true, released: true, detail: 'unmounted' };
      })
    : absent();
  const socket = await asyncStep('socket', async () => {
    if (!r.socket) { return absent(); }
    const socket = r.socket;
    const socketClosed = () => (socket.readyState as number) === WS_READY_STATE_CLOSED;
    if (socketClosed()) { return { invoked: false, released: true, detail: 'already-closed' }; }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let timer: NodeJS.Timeout;
      const onClose = () => { clearTimeout(timer); resolvePromise(); };
      timer = setTimeout(() => { socket.off('close', onClose); rejectPromise(new Error(`websocket did not emit close within ${SOCKET_CLOSE_TIMEOUT_MS}ms`)); }, SOCKET_CLOSE_TIMEOUT_MS);
      socket.once('close', onClose);
      try { socket.close(); }
      catch (error) { clearTimeout(timer); socket.off('close', onClose); rejectPromise(error instanceof Error ? error : new Error(messageOf(error))); }
    });
    return { invoked: true, released: socketClosed(), detail: `readyState=${socket.readyState}` };
  });
  const dom = step('dom', () => {
    if (!r.domClose) { return absent(); }
    const released = r.domClose();
    return { invoked: true, released, detail: released ? 'document-closed; globals-removed' : 'jsdom document or probe globals not released' };
  });
  const released = errors.length === 0 && remainingResources.length === 0;
  return { relay, heldWire, peerConnection, sink, track, receiver, message, hook, socket, dom, errors, remainingResources, released };
}

const plainSample = (s: RemoteWindowVideoStatsSample) => ({
  lane: s.lane, mediaEpoch: s.mediaEpoch, trackId: s.trackId, ssrc: s.ssrc, mid: s.mid,
  transportId: s.transportId, selectedCandidatePairId: s.selectedCandidatePairId,
  receivedBitrateBps: s.receivedBitrateBps ?? null, rttMs: s.rttMs ?? null, framesPerSecond: s.framesPerSecond ?? null,
  framesDropped: s.framesDropped ?? null, freezeCount: s.freezeCount ?? null, jitterBufferDelayMs: s.jitterBufferDelayMs ?? null,
  receivedPacketLossRatio: s.receivedPacketLossRatio ?? null, availableIncomingBitrateBps: s.availableIncomingBitrateBps ?? null,
});

const SDP_CRLF = '\r\n';
const END_OF_CANDIDATES = 'a=end-of-candidates';

function stripSdpCandidates(sdp: string): string {
  return sdp.split(SDP_CRLF).filter((line) => !line.startsWith('a=candidate:')).join(SDP_CRLF);
}

function rewriteUdpCandidate(raw: string, ip: string, port: number): string | null {
  const match = /^(candidate:\S+\s+\d+\s+udp\s+)\d+\s+\S+\s+\d+/.exec(raw);
  if (!match) { return null; }
  return `${match[1]}2122260223 ${ip} ${port}${raw.slice(match[0].length)}`;
}

function parseUdpHostCandidate(raw: string): { ip: string; port: number } | null {
  const match = /^candidate:\S+\s+\d+\s+udp\s+\d+\s+([^ ]+)\s+(\d+)\s+typ\s+host/.exec(raw);
  if (!match) { return null; }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0) { return null; }
  return { ip: match[1], port };
}

function injectCandidateLine(sdp: string, candidateLine: string, sdpMid: string | null): string {
  const lines = sdp.split(SDP_CRLF);
  const mediaBlocks: Array<{ start: number; end: number }> = [];
  let currentStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^m=/.test(lines[i]!)) {
      if (currentStart >= 0) { mediaBlocks[mediaBlocks.length - 1]!.end = i; }
      currentStart = i;
      mediaBlocks.push({ start: i, end: lines.length });
    }
  }
  if (currentStart < 0) {
    lines.splice(lines.length, 0, candidateLine);
    return lines.join(SDP_CRLF);
  }
  let target = 0;
  if (sdpMid !== null) {
    const found = mediaBlocks.findIndex((block) => lines.slice(block.start, block.end).some((line) => line === `a=mid:${sdpMid}`));
    if (found >= 0) { target = found; }
  }
  const block = mediaBlocks[target]!;
  const clean = lines.slice(block.start, block.end).filter((line) => !line.startsWith('a=candidate:') && line !== END_OF_CANDIDATES);
  const midAt = clean.findIndex((line) => line.startsWith('a=mid:'));
  clean.splice(midAt >= 0 ? midAt + 1 : 1, 0, candidateLine, END_OF_CANDIDATES);
  lines.splice(block.start, block.end - block.start, ...clean);
  return lines.join(SDP_CRLF);
}

function sdpCandidateLines(sdp: string): string[] {
  return sdp.split(SDP_CRLF)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.slice('a=candidate:'.length));
}

function firstSdpMid(sdp: string): string | null {
  const match = /^a=mid:([^\s]+)/m.exec(sdp);
  return match ? match[1]! : null;
}

interface RelayEndpoint { ip: string; port: number }
interface RelayCounters { recvA: number; recvB: number; txA: number; txB: number; dropB: number; dropA: number; delayedB: number; delayedA: number }
interface DgramSocket {
  address(): { address: string; port: number };
  bind(port: number, address?: string, callback?: () => void): void;
  close(callback?: () => void): void;
  on(event: 'message', listener: (msg: Buffer, rinfo: Record<string, unknown>) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  send(buf: Buffer, offset: number, length: number, port: number, address: string, callback?: (error: Error | null, bytes: number) => void): void;
}

const bindDgram = (): Promise<DgramSocket> => new Promise((resolvePromise, rejectPromise) => {
  const socket = createSocket('udp4') as unknown as DgramSocket;
  socket.once('error', rejectPromise);
  socket.bind(0, '127.0.0.1', () => resolvePromise(socket));
});

const DGRAM_ALREADY_CLOSED = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
/**
 * Release one owned dgram socket and wait for the real `close` completion via
 * its callback. Only the documented already-closed condition
 * (`ERR_SOCKET_DGRAM_NOT_RUNNING`) is accepted as a true release; every other
 * close error is propagated, never swallowed into a fake success.
 */
const closeDgram = (socket: DgramSocket): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  let settled = false;
  const onClosed = () => { if (!settled) { settled = true; resolvePromise(); } };
  try {
    socket.close(onClosed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === DGRAM_ALREADY_CLOSED) { onClosed(); return; }
    if (!settled) { settled = true; rejectPromise(error instanceof Error ? error : new Error(messageOf(error))); }
  }
});

/**
 * Owned stdlib dgram UDP relay. Both public peers are signalled to exactly one
 * rewritten IPv4 host candidate per side = the opposite relay bind endpoint, so
 * the selected media pair and these counters prove no direct bypass. It applies
 * bounded real delay/drop to actual packets; it is test-network shaping only and
 * never mutates a product payload.
 */
class SignalRelay {
  readonly relayA: RelayEndpoint;
  readonly relayB: RelayEndpoint;
  readonly counters: RelayCounters = { recvA: 0, recvB: 0, txA: 0, txB: 0, dropB: 0, dropA: 0, delayedB: 0, delayedA: 0 };
  private realA: RelayEndpoint | null = null;
  private realB: RelayEndpoint | null = null;
  get endpointA(): RelayEndpoint | null { return this.realA; }
  get endpointB(): RelayEndpoint | null { return this.realB; }
  private delayMs = 0;
  private dropRatioBtoA = 0;
  private dropRatioAtoB = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private socketsReleased = false;
  /** Number of relay delay timers still pending (must be 0 after stop()). */
  get pendingTimerCount(): number { return this.timers.size; }
  /** Public release state: both dgram sockets actually closed and no pending timers. */
  get released(): boolean { return this.socketsReleased && this.timers.size === 0; }
  constructor(private readonly sockA: DgramSocket, private readonly sockB: DgramSocket) {
    this.relayA = { ip: sockA.address().address, port: sockA.address().port };
    this.relayB = { ip: sockB.address().address, port: sockB.address().port };
    sockA.on('message', (buf: Buffer) => this.forwardBtoA(buf));
    sockB.on('message', (buf: Buffer) => this.forwardAtoB(buf));
  }
  setRealA(ip: string, port: number): void { this.realA = { ip, port }; }
  setRealB(ip: string, port: number): void { this.realB = { ip, port }; }
  setPressure(options: { delayMs?: number; dropRatioBtoA?: number; dropRatioAtoB?: number }): void {
    if (options.delayMs !== undefined) { this.delayMs = Math.max(0, options.delayMs); }
    if (options.dropRatioBtoA !== undefined) { this.dropRatioBtoA = Math.min(1, Math.max(0, options.dropRatioBtoA)); }
    if (options.dropRatioAtoB !== undefined) { this.dropRatioAtoB = Math.min(1, Math.max(0, options.dropRatioAtoB)); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) { clearTimeout(timer); }
    this.timers.clear();
    const releases = await Promise.allSettled([closeDgram(this.sockA), closeDgram(this.sockB)]);
    const failures = releases.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    this.socketsReleased = failures.length === 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, 'owned relay socket release failed');
    }
  }
  // sockA is advertised to the client (relayA); sockB is advertised to the
  // daemon (relayB). realA = client real endpoint (answer host candidate);
  // realB = daemon real endpoint (offer host candidate).
  private sendA(buf: Buffer): void { if (!this.realB) { return; } this.counters.txA += 1; this.sockB.send(buf, 0, buf.length, this.realB.port, this.realB.ip, () => {}); }
  private sendB(buf: Buffer): void { if (!this.realA) { return; } this.counters.txB += 1; this.sockA.send(buf, 0, buf.length, this.realA.port, this.realA.ip, () => {}); }
  // sockA receives client -> daemon (control/RTCP path).
  private forwardBtoA(buf: Buffer): void {
    if (this.stopped) { return; }
    this.counters.recvA += 1;
    if (this.dropRatioBtoA > 0 && Math.random() < this.dropRatioBtoA) { this.counters.dropA += 1; return; }
    this.sendA(buf);
  }
  // sockB receives daemon -> client (media path). Bounded delay/loss here
  // produces real received-bitrate / rtt pressure at the client receiver.
  private forwardAtoB(buf: Buffer): void {
    if (this.stopped) { return; }
    this.counters.recvB += 1;
    if (this.dropRatioAtoB > 0 && Math.random() < this.dropRatioAtoB) { this.counters.dropB += 1; return; }
    if (this.delayMs > 0) {
      this.counters.delayedB += 1;
      const timer = setTimeout(() => { this.timers.delete(timer); this.sendB(buf); }, this.delayMs);
      this.timers.add(timer);
      return;
    }
    this.sendB(buf);
  }
}

function isQualityResult(message: unknown): boolean {
  return (message as { type?: string }).type === 'remote-window-stream-quality-result';
}

function rewriteOfferForRelay(rawOffer: unknown, realDaemonEndpoint: RelayEndpoint | null, relay: SignalRelay): unknown {
  if (typeof rawOffer !== 'string') { return rawOffer; }
  let offer = stripSdpCandidates(rawOffer);
  const real = realDaemonEndpoint ?? parseUdpHostCandidate(sdpCandidateLines(rawOffer)[0] ?? '');
  if (real) { realDaemonEndpoint = real; }
  const line = sdpCandidateLines(rawOffer)[0] ?? (real ? `candidate:1 1 udp 2122260223 ${real.ip} ${real.port} typ host` : '');
  const rewritten = line ? rewriteUdpCandidate(line, relay.relayA.ip, relay.relayA.port) : null;
  if (!real || !rewritten) { return rawOffer; }
  return injectCandidateLine(offer, rewritten, firstSdpMid(offer));
}

function rewriteAnswerForRelay(rawAnswer: unknown, realClientEndpoint: RelayEndpoint | null, relay: SignalRelay): unknown {
  if (typeof rawAnswer !== 'string') { return rawAnswer; }
  let answer = stripSdpCandidates(rawAnswer);
  const real = realClientEndpoint ?? parseUdpHostCandidate(sdpCandidateLines(rawAnswer)[0] ?? '');
  if (real) { realClientEndpoint = real; }
  const line = sdpCandidateLines(rawAnswer)[0] ?? (real ? `candidate:1 1 udp 2122260223 ${real.ip} ${real.port} typ host` : '');
  const rewritten = line ? rewriteUdpCandidate(line, relay.relayB.ip, relay.relayB.port) : null;
  if (!real || !rewritten) { return rawAnswer; }
  return injectCandidateLine(answer, rewritten, firstSdpMid(answer));
}

function isPressureSample(sample: RemoteWindowVideoStatsSample, minimumLatencyMs: number): boolean {
  const rttMs = sample.rttMs ?? null;
  const jitterMs = sample.jitterBufferDelayMs ?? null;
  const dropped = sample.framesDropped ?? null;
  const freezes = sample.freezeCount ?? null;
  const rawLoss = sample.receivedPacketLossRatio;
  const loss = typeof rawLoss === 'number' && Number.isFinite(rawLoss) ? rawLoss : null;
  if (loss !== null && loss >= 0.05) { return true; }
  if ((dropped !== null && dropped >= 3) || (freezes !== null && freezes > 0)) { return true; }
  return (rttMs !== null && rttMs >= Math.max(350, minimumLatencyMs))
    || (jitterMs !== null && jitterMs >= Math.max(250, minimumLatencyMs));
}

function collectPressureSamples(collectStats: () => Promise<RemoteWindowVideoStatsSample | null>, minimumLatencyMs: number, minimumSamples: number): Promise<Array<{ sample: RemoteWindowVideoStatsSample; reads: number }>> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const samples: Array<{ sample: RemoteWindowVideoStatsSample; reads: number }> = [];
    let reads = 0;
    const readNext = async () => {
      reads += 1;
      if (Date.now() - startedAt > 45_000) { rejectPromise(new Error('timed out collecting real stats samples')); return; }
      let sample: RemoteWindowVideoStatsSample | null = null;
      try { sample = await collectStats(); } catch (error) { rejectPromise(error); return; }
      if (sample && isPressureSample(sample, minimumLatencyMs)) { samples.push({ sample, reads }); }
      if (samples.length >= minimumSamples) { resolvePromise(samples); return; }
      setTimeout(() => { void readNext(); }, 400);
    };
    void readNext();
  });
}

function isHealthyRecoverySample(sample: RemoteWindowVideoStatsSample): boolean {
  const rttMs = sample.rttMs ?? null;
  const jitterMs = sample.jitterBufferDelayMs ?? null;
  const dropped = sample.framesDropped ?? null;
  const freezes = sample.freezeCount ?? null;
  const bitrate = sample.receivedBitrateBps ?? null;
  return bitrate !== null
    && bitrate > 0
    && (rttMs === null || rttMs < 350)
    && (jitterMs === null || jitterMs < 250)
    && (dropped === null || dropped < 3)
    && (freezes === null || freezes === 0);
}

function collectHealthySamples(collectStats: () => Promise<RemoteWindowVideoStatsSample | null>, durationMs: number): Promise<Array<{ sample: RemoteWindowVideoStatsSample; reads: number }>> {
  const endsAt = Date.now() + durationMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const samples: Array<{ sample: RemoteWindowVideoStatsSample; reads: number }> = [];
    let reads = 0;
    let healthySinceMs: number | null = null;
    const readNext = async () => {
      reads += 1;
      if (Date.now() > endsAt + 20_000) { rejectPromise(new Error('timed out collecting healthy recovery samples')); return; }
      let sample: RemoteWindowVideoStatsSample | null = null;
      try { sample = await collectStats(); } catch (error) { rejectPromise(error); return; }
      if (!sample || !isHealthyRecoverySample(sample)) {
        healthySinceMs = null;
      } else {
        healthySinceMs ??= Date.now();
        samples.push({ sample, reads });
      }
      if (Date.now() >= endsAt && healthySinceMs !== null && Date.now() - healthySinceMs >= durationMs) {
        resolvePromise(samples);
        return;
      }
      setTimeout(() => { void readNext(); }, 500);
    };
    void readNext();
  });
}

async function waitDistinctFrames(frameLog: FrameLogEntry[], sinceMs: number, afterFrameId: number, count: number): Promise<number> {
  await waitFor(() => {
    const matches = frameLog.filter((entry) => entry.committed && entry.atMs > sinceMs && entry.frameId > afterFrameId);
    return new Set(matches.map((entry) => entry.sha256)).size >= count;
  }, `>=${count} dynamic frames after event`, FRAME_TIMEOUT_MS);
  return new Set(frameLog.filter((entry) => entry.committed && entry.atMs > sinceMs && entry.frameId > afterFrameId).map((entry) => entry.sha256)).size;
}

interface NominatedPair {
  pairId: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  packetsSent: number | null;
  packetsReceived: number | null;
  totalRoundTripTime: number | null;
}

function statAddress(stat: Record<string, unknown> | undefined): string {
  if (!stat) { return ''; }
  if (typeof stat.address === 'string') { return stat.address; }
  if (typeof stat.ip === 'string') { return stat.ip; }
  if (typeof stat.address === 'number') { return String(stat.address); }
  return '';
}

async function readNominatedRelayPair(peerConnection: RTCPeerConnection): Promise<NominatedPair[]> {
  const report = await peerConnection.getStats();
  const candidates = new Map<string, { address: string; port: number }>();
  const pairs: Array<Record<string, unknown>> = [];
  report.forEach((stat) => {
    const item = stat as unknown as Record<string, unknown>;
    if (item.type === 'local-candidate' || item.type === 'remote-candidate') {
      candidates.set(String(item.id), { address: statAddress(item), port: typeof item.port === 'number' ? item.port : Number.NaN });
    } else if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated === true) {
      pairs.push(item);
    }
  });
  return pairs.map((pair) => {
    const local = candidates.get(String(pair.localCandidateId));
    const remote = candidates.get(String(pair.remoteCandidateId));
    return {
      pairId: String(pair.id),
      localAddress: local?.address ?? '',
      localPort: local?.port ?? Number.NaN,
      remoteAddress: remote?.address ?? '',
      remotePort: remote?.port ?? Number.NaN,
      packetsSent: typeof pair.packetsSent === 'number' ? pair.packetsSent : null,
      packetsReceived: typeof pair.packetsReceived === 'number' ? pair.packetsReceived : null,
      totalRoundTripTime: typeof pair.totalRoundTripTime === 'number' ? pair.totalRoundTripTime : null,
    };
  });
}

function pairUsesBothRelays(pair: NominatedPair, relay: SignalRelay): boolean {
  const want = [`${relay.relayA.ip}:${relay.relayA.port}`, `${relay.relayB.ip}:${relay.relayB.port}`].sort();
  const observed = [`${pair.localAddress}:${pair.localPort}`, `${pair.remoteAddress}:${pair.remotePort}`].sort();
  return observed[0] === want[0] && observed[1] === want[1];
}

async function waitForRelayNomination(peerConnection: RTCPeerConnection, relay: SignalRelay, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const pairs = await readNominatedRelayPair(peerConnection);
    if (pairs.some((pair) => pairUsesBothRelays(pair, relay))) { return; }
    if (Date.now() - startedAt >= timeoutMs) { throw new Error('nominated candidate pair did not select both relay endpoints'); }
    await delay(250);
  }
}

async function runLiveCase(args: AbrProbeArgs): Promise<{ evidence: Record<string, unknown> }> {
  const outputDir = resolve(args.outputDir!);
  mkdirSync(outputDir, { recursive: true });
  const { url: wsUrl, tokenSource } = resolveDaemonWebSocketUrl(args.daemonUrl!);
  const wire: WireRecord[] = [];
  const listenerErrors: Array<{ phase: string; message: string }> = [];
  const frameErrors: string[] = [];
  const relay = (args.caseName === 'pressure-recovery' || args.caseName === 'manual-inflight')
    ? new SignalRelay(await bindDgram(), await bindDgram())
    : null;
  let holdQualityAcks = false;
  const r: LiveResources = { relay, heldWire: [], peerConnection: null, socket: null, bridge: null, messageRuntime: null, receiverRuntime: null, stream: null, sink: null, track: null, hook: null, domClose: null };
  const evidence: Record<string, unknown> = {
    runId: RUN_ID, case: args.caseName, startedAt: new Date().toISOString(), daemonUrl: redactUrl(wsUrl), tokenSource, route: 'plain-legacy-ws',
    probe: { scriptSha256: scriptSha256(), productPublicDigests: productDigest(), node: process.version, platform: process.platform, arch: process.arch },
  };
  let ok = false;
  let failure: unknown = null;
  try {
    const { WebSocket: WebSocketCtor } = await import('ws');
    r.socket = new WebSocketCtor(wsUrl);
    await waitForWebSocketOpen(r.socket, redactUrl(wsUrl));
    r.bridge = new ProbeBridgeSocket(r.socket, (data) => wire.push({ atMs: Date.now(), direction: 'client-to-daemon', message: parseWire(data.toString()) }));
    const statuses: RemoteWindowStreamStatusPayload[] = [];
    const iceQueue: RemoteWindowStreamIceCandidatePayload[] = [];
    r.messageRuntime = createRemoteWindowMessageRuntime({
      onStreamIceCandidate: (payload) => {
        if (relay) {
          const real = parseUdpHostCandidate(payload.candidate?.candidate ?? '');
          if (real) { relay.setRealB(real.ip, real.port); }
          const rewritten = rewriteUdpCandidate(payload.candidate?.candidate ?? '', relay.relayA.ip, relay.relayA.port);
          if (rewritten) { payload = { ...payload, candidate: { ...payload.candidate, candidate: rewritten } }; }
        }
        iceQueue.push(payload);
        void r.receiverRuntime?.addIceCandidate(payload).catch((error) => { listenerErrors.push({ phase: 'ice', message: messageOf(error) }); });
      },
      onStreamStatus: (payload) => { statuses.push(payload); },
      onListenerError: (phase, error) => { listenerErrors.push({ phase, message: messageOf(error) }); },
    });
    const handleDaemonWire = (raw: string, recordWire = true) => {
      const parsed = parseWire(raw);
      if (recordWire) { wire.push({ atMs: Date.now(), direction: 'daemon-to-client', message: parsed }); }
      let parsedMessage: { type: string } | null = null;
      try { parsedMessage = JSON.parse(raw) as { type: string }; } catch { return; }
      if (!isRemoteWindowControlMessage(parsedMessage as never)) { return; }
      if (holdQualityAcks && isQualityResult(parsedMessage)) {
        r.heldWire.push({ atMs: Date.now(), raw, parsed: parsedMessage });
        return;
      }
      r.messageRuntime?.dispatch(parsedMessage as never);
    };
    r.socket.on('message', (data: RawData) => handleDaemonWire(data.toString()));

    const catalog = await r.messageRuntime.requestTargets(args.sessionId!, { ws: r.bridge, sendSocketPayload });
    const target = catalog.targets.find((candidate) => candidate.streamTargetId === args.targetId!);
    if (!target) { throw new Error(`target not found in daemon catalog: ${args.targetId}`); }
    if ((target.compositeWindows ?? []).length > 0) { throw new Error(`baseline requires a single-focus target; got compositeWindows for ${args.targetId}`); }
    const mediaPlan = 'single-focus' as const;
    evidence.target = { targetId: target.streamTargetId, bundle: target.videoTarget.appBundleId, pid: target.videoTarget.pid, title: target.videoTarget.title, mode: target.streamMode };

    const wrtcInfo = loadWrtc(args.wrtcPackageRoot!, args.addonPath);
    evidence.wrtc = { packageRoot: wrtcInfo.packageRoot, addonPath: wrtcInfo.addonPath, addonRealPath: wrtcInfo.addonRealPath, addonSha256: wrtcInfo.addonSha256, addonBytes: wrtcInfo.addonBytes };
    const { RTCPeerConnection } = wrtcInfo.wrtc;
    const { RTCVideoSink } = wrtcInfo.wrtc.nonstandard;
    r.receiverRuntime = createRemoteWindowReceiverRuntime({
      peerConnectionFactory: (configuration) => {
        const peerConnection = new RTCPeerConnection(configuration);
        r.peerConnection = peerConnection;
        return peerConnection;
      },
      mediaStreamFactory: () => new wrtcInfo.wrtc.MediaStream(),
    });

    const streamId = `rw-abr-${args.caseName}-${RUN_ID}`;
    const frameLog: FrameLogEntry[] = [];
    let committedFrames = 0;
    const frameIds = new Map<string, number>();
    r.stream = await r.receiverRuntime.startStream({
      streamId, target, iceServers: [], protocolVersion: 2,
      sendIceCandidate: (candidate, requestId) => {
        let outgoingCandidate = candidate;
        if (relay) {
          const real = parseUdpHostCandidate(candidate?.candidate ?? '');
          if (real) { relay.setRealA(real.ip, real.port); }
          const rewritten = rewriteUdpCandidate(candidate?.candidate ?? '', relay.relayB.ip, relay.relayB.port);
          if (rewritten) { outgoingCandidate = { ...candidate, candidate: rewritten }; }
        }
        r.messageRuntime?.sendStreamIceCandidate(args.sessionId!, { ws: r.bridge!, streamId, ...(requestId ? { requestId } : {}), candidate: outgoingCandidate, sendSocketPayload });
      },
      startRemote: async () => {
        const started = await r.messageRuntime!.requestStreamStart(args.sessionId!, { ws: r.bridge!, streamId, target, mediaPlan, mediaPlanVersion: 2, videoProfile: buildRemoteWindowVideoProfile('smooth', { target }), sendSocketPayload }) as RemoteWindowStreamStartedOfferV2Payload;
        if (relay && 'offer' in started) {
          const offerPayload = started as RemoteWindowStreamStartedOfferV2Payload;
          const real = parseUdpHostCandidate(sdpCandidateLines(offerPayload.offer.sdp)[0] ?? '');
          relay.setRealB(real?.ip ?? '127.0.0.1', real?.port ?? 0);
          offerPayload.offer = { ...offerPayload.offer, sdp: rewriteOfferForRelay(offerPayload.offer.sdp, real, relay) as string };
        }
        return started;
      },
      sendAnswer: (answer) => {
        if (relay) {
          const real = parseUdpHostCandidate(sdpCandidateLines(answer.answer.sdp)[0] ?? '');
          relay.setRealA(real?.ip ?? '127.0.0.1', real?.port ?? 0);
          answer = { ...answer, answer: { ...answer.answer, sdp: rewriteAnswerForRelay(answer.answer.sdp, real, relay) as string } };
        }
        return r.messageRuntime!.sendStreamAnswerV2(args.sessionId!, { ws: r.bridge!, payload: answer, sendSocketPayload });
      },
    });
    evidence.started = { requestId: r.stream.started.requestId, mediaPlan: r.stream.started.mediaPlan, mediaPlanVersion: r.stream.started.mediaPlanVersion, capture: r.stream.started.capture, transport: r.stream.started.transport, bindings: r.stream.bindings.map((b) => ({ lane: b.lane, mediaEpoch: b.mediaEpoch, trackId: b.trackId })) };

    const binding = r.stream.bindings.find((entry) => entry.lane === 'focus');
    if (!binding) { throw new Error('receiver runtime returned no focus binding'); }
    r.track = binding.mediaStream.getTracks().find((candidate) => candidate.id === binding.trackId) ?? (binding.mediaStream.getTracks().length === 1 ? binding.mediaStream.getTracks()[0] : null);
    if (!r.track) { throw new Error('receiver focus binding exposes no track'); }
    r.sink = new RTCVideoSink(r.track);
    r.sink.onframe = (frameEvent) => {
      const frame = frameEvent?.frame;
      if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !frame.data) { frameErrors.push('invalid frame'); return; }
      const expected = Math.floor(frame.width * frame.height * 1.5);
      if (frame.data.byteLength !== expected) { frameErrors.push(`incomplete I420 ${frame.width}x${frame.height} bytes=${frame.data.byteLength} expected=${expected}`); return; }
      const frameId = (frameIds.get(binding.lane) ?? 0) + 1;
      frameIds.set(binding.lane, frameId);
      const committed = r.stream!.commitDecodedFrame({ streamId, mediaPlanVersion: 2, lane: binding.lane, mediaEpoch: binding.mediaEpoch, trackId: binding.trackId, frameId, width: frame.width, height: frame.height });
      if (committed) { committedFrames += 1; }
      frameLog.push({ atMs: Date.now(), frameId, sha256: createHash('sha256').update(frame.data).digest('hex'), committed });
    };

    await waitFor(() => Boolean(statuses.find((s) => s.streamId === streamId && s.phase === 'streaming')), 'streaming status', STREAM_READY_TIMEOUT_MS);
    await waitFor(() => committedFrames >= 3, '>=3 decoded frames', FRAME_TIMEOUT_MS);
    await delay(1_500);
    await waitFor(() => committedFrames >= 3, '>=3 decoded frames after stats warmup', FRAME_TIMEOUT_MS);
    evidence.ice = { candidateCount: iceQueue.length, candidateTypes: [...new Set(iceQueue.map((entry) => (entry.candidate?.candidate ?? '').split(' ')[0]).filter(Boolean))] };
    if (relay) {
      if (!r.peerConnection) { throw new Error('receiver runtime did not expose the owned peer connection'); }
      await waitForRelayNomination(r.peerConnection, relay, STREAM_READY_TIMEOUT_MS);
      const nominated = await readNominatedRelayPair(r.peerConnection);
      const matching = nominated.filter((pair) => pairUsesBothRelays(pair, relay));
      evidence.relay = { selectedRelayEndpoints: [`${relay.relayA.ip}:${relay.relayA.port}`, `${relay.relayB.ip}:${relay.relayB.port}`].sort(), realClientEndpoint: relay.endpointA ? `${relay.endpointA.ip}:${relay.endpointA.port}` : null, realDaemonEndpoint: relay.endpointB ? `${relay.endpointB.ip}:${relay.endpointB.port}` : null, nominated, chosen: matching, counters: relay.counters };
      if (!relay.endpointA || !relay.endpointB || relay.counters.recvA === 0 || relay.counters.recvB === 0 || matching.length === 0) { throw new Error('relay did not establish both selected directions'); }
    }

    // Read public RTP counters as diagnostic evidence. These observations do
    // not alter the product sample or its adaptation baseline.
    const inboundPacketObservations: Array<Record<string, unknown>> = [];
    evidence.inboundPacketObservations = inboundPacketObservations;
    const collectProductStats = r.stream.collectStats ?? (() => Promise.resolve(null));
    const collectStats = async () => {
      const sample = await collectProductStats();
      if (r.peerConnection) {
        const report = await r.peerConnection.getStats();
        report.forEach((stat) => {
          const item = stat as unknown as Record<string, unknown>;
          if (item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video')) {
            inboundPacketObservations.push({
              observedAtMs: Date.now(),
              id: item.id, timestamp: item.timestamp, ssrc: item.ssrc,
              mid: item.mid, transportId: item.transportId,
              packetsLost: item.packetsLost, packetsReceived: item.packetsReceived,
              relayCounters: relay ? { ...relay.counters } : null,
            });
          }
        });
      }
      return sample;
    };
    const statsRef: UseRemoteWindowQualityOptions['collectStatsRef'] = { current: collectStats };
    const { harness, mount } = createHookHarness({
      activeSessionId: args.sessionId, streamId, targetId: args.targetId, mediaPlan,
      streamReady: true, qualityStreamActive: true, videoPreference: 'smooth', maxFrameRateFps: 30, target,
      updateStreamQuality: (sid, payload) => r.messageRuntime!.sendStreamQuality(sid, { ws: r.bridge!, payload, sendSocketPayload }),
      collectStatsRef: statsRef,
    });
    r.hook = harness;
    const dom = await installDom();
    r.domClose = dom.close;
    const { createRoot } = await import('react-dom/client');
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    await mount(container, (element) => createRoot(element));

    await waitFor(() => harness.latest?.qualityStatus === 'applied', 'initial applied quality', QUALITY_TIMEOUT_MS);
    const initialState = harness.latest?.qualityApplyState;
    evidence.initialApplied = initialState?.phase === 'applied'
      ? { revision: initialState.revision, appliedVideoProfile: initialState.applied, qualityKey: initialState.qualityKey }
      : null;
    let statsBefore = await collectStats();
    for (let i = 0; i < 2 && !statsBefore; i += 1) { await delay(400); statsBefore = await collectStats(); }
    const framesBefore = recentDistinctShas(frameLog, (entry) => entry.committed && entry.atMs <= Date.now(), 3);
    evidence.before = { statsBefore: statsBefore ? plainSample(statsBefore) : null, framesBefore };

    await harness.update({ videoPreference: 'quality', maxFrameRateFps: 30 });
    const intentAtMs = Date.now();
    await waitFor(() => harness.latest?.qualityStatus === 'applied' && harness.latest?.activeProfile?.maxBitrateBps === 8_000_000 && harness.latest?.lastAck?.profile.maxBitrateBps === 8_000_000, '8Mbps/30FPS applied ACK', QUALITY_TIMEOUT_MS);
    const ackState = harness.latest?.qualityApplyState;
    const ack = ackState?.phase === 'applied' ? ackState.result : null;
    const ackAtMs = Date.now();

    const outbound = wire.find((record) => {
      const msg = record.message as { type?: string; payload?: { videoProfile?: { maxBitrateBps?: number } } };
      return record.direction === 'client-to-daemon' && msg.type === 'remote-window-stream-quality-request' && msg.payload?.videoProfile?.maxBitrateBps === 8_000_000;
    });
    const inbound = wire.find((record) => {
      const msg = record.message as { type?: string; payload?: { requestId?: string; status?: string } };
      const outboundRequestId = (outbound?.message as { payload?: { requestId?: string } } | undefined)?.payload?.requestId;
      return record.direction === 'daemon-to-client' && msg.type === 'remote-window-stream-quality-result' && msg.payload?.requestId === outboundRequestId && msg.payload?.status === 'applied';
    });
    if (!outbound || !inbound) { throw new Error('8Mbps manual quality request/ACK missing on the wire'); }
    const wireQuality = (inbound.message as { payload?: RemoteWindowStreamQualityResultPayload }).payload!;
    if (!ack || wireQuality.streamGroupId !== streamId || wireQuality.targetId !== args.targetId || wireQuality.revision !== ack.revision) { throw new Error('quality ACK identity mismatch'); }
    evidence.correlation = { requestId: wireQuality.requestId, revision: wireQuality.revision, streamGroupId: wireQuality.streamGroupId, targetId: wireQuality.targetId, mediaPlan: wireQuality.mediaPlan, mediaPlanVersion: wireQuality.mediaPlanVersion, appliedMaxBitrateBps: wireQuality.appliedVideoProfile?.maxBitrateBps, hookRequestId: ack.requestId, intentToAckMs: ackAtMs - intentAtMs };

    await waitFor(() => { const after = recentDistinctShas(frameLog, (entry) => entry.committed && entry.atMs > ackAtMs, 3); return after.length >= 3 && new Set(after).size >= 3; }, '>=3 dynamic complete frames after ACK', FRAME_TIMEOUT_MS);
    const framesAfter = recentDistinctShas(frameLog, (entry) => entry.committed && entry.atMs > ackAtMs, 3);
    let statsAfter = await collectStats();
    for (let i = 0; i < 2 && !statsAfter; i += 1) { await delay(400); statsAfter = await collectStats(); }
    if (!statsBefore || !statsAfter) { throw new Error('receiver stats unavailable before/after manual intent'); }
    const identity = (s: RemoteWindowVideoStatsSample) => ({ lane: s.lane, mediaEpoch: s.mediaEpoch, trackId: s.trackId, ssrc: s.ssrc, mid: s.mid, transportId: s.transportId, selectedCandidatePairId: s.selectedCandidatePairId });
    if (JSON.stringify(identity(statsBefore)) !== JSON.stringify(identity(statsAfter))) { throw new Error('peer/MID/ICE identity changed before/after manual intent'); }
    if (framesBefore.length < 3 || new Set(framesBefore).size < 3) { throw new Error(`expected >=3 dynamic complete frames before intent; got ${JSON.stringify(framesBefore)}`); }
    evidence.after = { framesAfter, receivingMetricsBefore: plainSample(statsBefore), receivingMetricsAfter: plainSample(statsAfter), samePeerMidIce: true };

    if (args.caseName === 'baseline') {
      const stopStatus = await r.messageRuntime.stopStream(args.sessionId!, { ws: r.bridge!, streamId, sendSocketPayload });
      evidence.stop = { phase: stopStatus.phase, message: stopStatus.message ?? null };
      const wireBefore = wire.length;
      await harness.update({ maxBitrateCapBps: 6_000_000 });
      await waitFor(() => harness.latest?.qualityStatus === 'rejected', 'quality-after-stop rejected', QUALITY_TIMEOUT_MS);
      const rejected = harness.latest;
      if (rejected?.failureCode !== 'remote_window_stream_quality_missing') { throw new Error(`expected real remote_window_stream_quality_missing after stop; got ${rejected?.failureCode}`); }
      const errorWire = wire.slice(wireBefore).find((record) => {
        const msg = record.message as { type?: string; payload?: { code?: string; message?: string } };
        return record.direction === 'daemon-to-client' && msg.type === 'remote-window-error' && msg.payload?.code === 'remote_window_stream_quality_missing';
      });
      evidence.afterStop = { failureCode: rejected.failureCode, failureMessage: rejected.failureMessage, wireSawRealError: Boolean(errorWire), wireError: errorWire ? (errorWire.message as { payload?: unknown }).payload : null };
    }
    if (args.caseName === 'pressure-recovery' && relay) {
      const delayMs = args.pressureDelayMs ?? 400;
      const dropRatio = args.pressureDropRatio ?? 0.8;
      const recoveryMs = (args.recoverySeconds ?? 13) * 1000;
      const pressureBaselineRevision = harness.latest?.qualityApplyState.revision ?? 0;
      const pressureBaselineQualityKey = harness.latest?.qualityApplyState.phase === 'applied' ? harness.latest.qualityApplyState.qualityKey : null;
      const nominatedBeforePressure = r.peerConnection ? await readNominatedRelayPair(r.peerConnection) : [];
      relay.setPressure({ delayMs, dropRatioBtoA: 0, dropRatioAtoB: dropRatio });
      const pressureSamples = await collectPressureSamples(collectStats, delayMs, 2);
      evidence.pressure = { delayMs, dropRatio, stats: pressureSamples.map((entry) => ({ ...plainSample(entry.sample), realSampleIndex: entry.reads })), nominatedBeforePressure, counters: relay.counters };
      await waitFor(() => {
        const state = harness.latest?.qualityApplyState;
        return state?.phase === 'applied' && state.revision > pressureBaselineRevision;
      }, 'new adaptive applied revision after pressure', QUALITY_TIMEOUT_MS);
      const pressureAckState = harness.latest?.qualityApplyState;
      const pressureAck = pressureAckState?.phase === 'applied' ? pressureAckState.result : null;
      if (!pressureAck || pressureAckState?.phase !== 'applied' || pressureAck.revision <= pressureBaselineRevision) { throw new Error('pressure samples did not settle a new adaptive ACK'); }
      const pressureRequest = wire.find((record) => {
        const msg = record.message as { type?: string; payload?: { requestId?: string; revision?: number; videoProfile?: { maxBitrateBps?: number } } };
        return record.direction === 'client-to-daemon' && msg.type === 'remote-window-stream-quality-request' && msg.payload?.revision === pressureAck.revision && msg.payload?.videoProfile !== undefined;
      });
      const pressureWireAck = wire.find((record) => {
        const msg = record.message as { payload?: { requestId?: string; revision?: number; status?: string } };
        const requestId = (pressureRequest?.message as { payload?: { requestId?: string } } | undefined)?.payload?.requestId;
        return record.direction === 'daemon-to-client' && isQualityResult(record.message) && msg.payload?.requestId === requestId && msg.payload?.revision === pressureAck.revision && msg.payload?.status === 'applied';
      });
      if (!pressureRequest || !pressureWireAck) { throw new Error('pressure adaptive request/ACK did not match on the wire'); }
      if (!pressureBaselineQualityKey || pressureAckState.qualityKey === pressureBaselineQualityKey) { throw new Error('pressure did not produce a distinct adaptive profile'); }
      const pressureFrameId = frameLog.at(-1)?.frameId ?? 0;
      const pressureFrames = await waitDistinctFrames(frameLog, Date.now(), pressureFrameId, 3);
      const nominatedAfterPressure = r.peerConnection ? await readNominatedRelayPair(r.peerConnection) : [];
      evidence.pressureAck = { wire: true, revision: pressureAck.revision, profile: pressureAck.appliedVideoProfile, frames: pressureFrames, nominatedAfterPressure, counters: relay.counters };
      relay.setPressure({ delayMs: 0, dropRatioBtoA: 0, dropRatioAtoB: 0 });
      const recoveryObservationStartedAt = Date.now();
      const recoverySamples = await collectHealthySamples(collectStats, Math.max(13_000, recoveryMs));
      await waitFor(() => {
        const state = harness.latest?.qualityApplyState;
        return state?.phase === 'applied' && state.revision > pressureAck.revision;
      }, 'new adaptive applied revision after healthy recovery', QUALITY_TIMEOUT_MS);
      const recoveredAckState = harness.latest?.qualityApplyState;
      const recoveryAck = recoveredAckState?.phase === 'applied' ? recoveredAckState.result : null;
      if (!recoveryAck || recoveredAckState?.phase !== 'applied' || recoveryAck.revision <= pressureAck.revision) { throw new Error('restored relay did not settle a newer recovery ACK'); }
      const recoveryRequest = wire.find((record) => {
        const msg = record.message as { type?: string; payload?: { revision?: number } };
        return record.direction === 'client-to-daemon' && msg.type === 'remote-window-stream-quality-request' && msg.payload?.revision === recoveryAck.revision;
      });
      const recoveryWireAck = wire.find((record) => {
        const msg = record.message as { payload?: { requestId?: string; revision?: number; status?: string } };
        const requestId = (recoveryRequest?.message as { payload?: { requestId?: string } } | undefined)?.payload?.requestId;
        return record.direction === 'daemon-to-client' && isQualityResult(record.message) && msg.payload?.requestId === requestId && msg.payload?.revision === recoveryAck.revision && msg.payload?.status === 'applied';
      });
      if (!recoveryRequest || !recoveryWireAck) { throw new Error('recovery request/ACK did not match on the wire'); }
      const recoveryFrameId = frameLog.at(-1)?.frameId ?? 0;
      const recoveryFrames = await waitDistinctFrames(frameLog, Date.now(), recoveryFrameId, 3);
      const nominatedAfterRecovery = r.peerConnection ? await readNominatedRelayPair(r.peerConnection) : [];
      evidence.recovery = { realHealthyMs: Date.now() - recoveryObservationStartedAt, requestedRecoveryMs: recoveryMs, stats: recoverySamples.map((entry) => ({ ...plainSample(entry.sample), realSampleIndex: entry.reads })), ack: { revision: recoveryAck.revision, profile: recoveryAck.appliedVideoProfile, wire: true }, frames: recoveryFrames, nominatedAfterRecovery, counters: relay.counters };
    }
    if (args.caseName === 'manual-inflight') {
      if (!relay) { throw new Error('manual-inflight did not create a relay'); }
      const manualCapBps = args.manualCapBps ?? 6_000_000;
      const adaptiveBaselineIndex = frameLog.at(-1)?.frameId ?? 0;
      const manualBaselineRevision = harness.latest?.qualityApplyState.revision ?? 0;
      holdQualityAcks = true;
      relay.setPressure({ delayMs: 400, dropRatioBtoA: 0, dropRatioAtoB: 0.5 });
      const adaptiveSampleMs = Date.now();
      const pressureSamples = await collectPressureSamples(collectStats, 400, 2);
      evidence.manualPressure = { startedAtMs: adaptiveSampleMs, stats: pressureSamples.map((entry) => ({ ...plainSample(entry.sample), realSampleIndex: entry.reads })) };
      await waitFor(() => r.heldWire.length > 0, 'held adaptive quality response bytes', QUALITY_TIMEOUT_MS);
      const adaptiveRequest = wire.find((record) => {
        const msg = record.message as { type?: string; payload?: { revision?: number; videoProfile?: { maxBitrateBps?: number } } };
        return record.direction === 'client-to-daemon' && msg.type === 'remote-window-stream-quality-request' && record.atMs >= adaptiveSampleMs && msg.payload?.revision !== undefined && msg.payload.revision > manualBaselineRevision && msg.payload?.videoProfile !== undefined;
      });
      if (!adaptiveRequest) { throw new Error('no real adaptive quality request observed before manual intent'); }
      const adaptiveRevision = (adaptiveRequest.message as { payload?: { revision?: number } }).payload?.revision ?? null;
      const adaptivePendingState = harness.latest?.qualityApplyState;
      if (adaptiveRevision === null || adaptivePendingState?.phase !== 'requested' || adaptivePendingState.revision !== adaptiveRevision) {
        throw new Error('manual intent was not issued while the real adaptive request was outstanding');
      }
      relay.setPressure({ delayMs: 0, dropRatioBtoA: 0, dropRatioAtoB: 0 });
      await harness.update({ videoPreference: 'quality', maxFrameRateFps: 30, maxBitrateCapBps: manualCapBps });
      const queuedState = harness.latest?.qualityApplyState;
      if (queuedState?.phase !== 'requested' || queuedState.revision !== adaptiveRevision || r.heldWire.length === 0) {
        throw new Error('manual intent did not queue behind the held adaptive ACK');
      }
      const held = r.heldWire.splice(0);
      evidence.manualOrdering = {
        adaptiveRevision,
        queuedBehindAdaptive: true,
        heldCount: held.length,
        heldAtMs: held.map((entry) => entry.atMs),
        requestIds: held.map((entry) => entry.parsed.payload?.requestId),
        payloadSha256: held.map((entry) => createHash('sha256').update(entry.raw).digest('hex')),
      };
      holdQualityAcks = false;
      for (const entry of held) { handleDaemonWire(entry.raw, false); }
      holdQualityAcks = true;
      await waitFor(() => r.heldWire.length > 0, 'held manual quality response bytes', QUALITY_TIMEOUT_MS);
      const heldManual = r.heldWire.splice(0);
      holdQualityAcks = false;
      for (const entry of heldManual) { handleDaemonWire(entry.raw, false); }
      await waitFor(() => harness.latest?.qualityStatus === 'applied', 'manual queued ACK settle', QUALITY_TIMEOUT_MS);
      const manualAckState = harness.latest?.qualityApplyState;
      const manualAck = manualAckState?.phase === 'applied' ? manualAckState.result : null;
      if (!manualAck || manualAckState?.phase !== 'applied') { throw new Error('manual queued request did not settle'); }
      const manualWireRequest = wire.find((record) => {
        const msg = record.message as { type?: string; payload?: RemoteWindowStreamQualityRequestPayload };
        return record.direction === 'client-to-daemon' && msg.type === 'remote-window-stream-quality-request' && msg.payload?.revision === manualAck.revision;
      });
      const manualWireAck = wire.find((record) => {
        const msg = record.message as { payload?: { requestId?: string; revision?: number; status?: string } };
        const requestId = (manualWireRequest?.message as { payload?: { requestId?: string } } | undefined)?.payload?.requestId;
        return record.direction === 'daemon-to-client' && isQualityResult(record.message) && msg.payload?.requestId === requestId && msg.payload?.revision === manualAck.revision && msg.payload?.status === 'applied';
      });
      if (!manualWireRequest || !manualWireAck || manualAck.revision <= adaptiveRevision) { throw new Error('manual ACK did not use a newer revision than the held adaptive request'); }
      const manualRequestProfile = (manualWireRequest.message as { payload?: RemoteWindowStreamQualityRequestPayload }).payload?.videoProfile;
      if (!manualRequestProfile || manualAck.appliedVideoProfile?.maxBitrateBps !== manualRequestProfile.maxBitrateBps) {
        throw new Error('manual ACK profile did not match the newer manual request');
      }
      const manualFrameId = frameLog.at(-1)?.frameId ?? 0;
      const manualFrames = await waitDistinctFrames(frameLog, Date.now(), manualFrameId, 3);
      evidence.manualSettle = { adaptiveBaselineIndex, adaptiveRevision, pressureSamples: pressureSamples.map((entry) => plainSample(entry.sample)), ack: { revision: manualAck.revision, profile: manualAck.appliedVideoProfile, wire: true }, frames: manualFrames, heldResponseOrder: [...held, ...heldManual].map((entry) => entry.parsed.payload?.requestId) };
      const qualityRequestsBeforeReplay = wire.filter((record) => record.direction === 'client-to-daemon' && (record.message as { type?: string }).type === 'remote-window-stream-quality-request').length;
      const replayAtMs = Date.now();
      const replayFrameId = frameLog.at(-1)?.frameId ?? 0;
      // Replay the actual older daemon bytes through the same public message
      // boundary after the newer manual ACK; this is a controlled duplicate,
      // not a second network reception or a fabricated successful response.
      for (const entry of held) { handleDaemonWire(entry.raw, false); }
      const framesAfterReplay = await waitDistinctFrames(frameLog, replayAtMs, replayFrameId, 3);
      const stateAfterReplay = harness.latest?.qualityApplyState;
      const qualityRequestsAfterReplay = wire.filter((record) => record.direction === 'client-to-daemon' && (record.message as { type?: string }).type === 'remote-window-stream-quality-request').length;
      if (stateAfterReplay?.phase !== 'applied' || stateAfterReplay.revision !== manualAck.revision || stateAfterReplay.result.requestId !== manualAck.requestId || JSON.stringify(stateAfterReplay.applied) !== JSON.stringify(manualAckState.applied) || qualityRequestsAfterReplay !== qualityRequestsBeforeReplay) {
        throw new Error('late adaptive ACK replaced the applied manual policy or emitted a new quality request');
      }
      evidence.manualLateAck = { controlledReplay: true, requestIds: held.map((entry) => entry.parsed.payload?.requestId), replayAtMs, preservedRevision: stateAfterReplay.revision, preservedRequestId: stateAfterReplay.result.requestId, profile: stateAfterReplay.applied, newQualityRequests: qualityRequestsAfterReplay - qualityRequestsBeforeReplay, frames: framesAfterReplay };
    }
    ok = true;
  } catch (error) {
    failure = error;
  }
  evidence.listenerErrors = listenerErrors;
  evidence.frameErrors = frameErrors;
  if (failure) { evidence.failure = { name: (failure as Error).name, message: messageOf(failure), stack: (failure as Error).stack }; }
  const cleanup = await cleanupResources(r);
  evidence.cleanup = cleanup;
  // One result sink: a case is only OK after its owned resources actually
  // release. Keep the original case error and append any cleanup failure rather
  // than replace/swallow it, so the natural exit and evidence are truthful.
  const finalOk = ok && cleanup.released;
  evidence.ok = finalOk;
  if (!cleanup.released) {
    evidence.cleanupFailure = { errors: cleanup.errors, remainingResources: cleanup.remainingResources };
  }
  evidence.finishedAt = new Date().toISOString();
  const caseSlug = args.caseName ?? 'live';
  const evidencePath = join(outputDir, `abr-live-consumer-${caseSlug}-${RUN_ID}.json`);
  const rawPath = join(outputDir, `abr-live-consumer-${caseSlug}-${RUN_ID}.raw.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  writeFileSync(rawPath, JSON.stringify({ wire }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: finalOk, failure: failure ? messageOf(failure) : null, cleanupReleased: cleanup.released, remainingResources: cleanup.remainingResources, evidencePath }, null, 2));
  if (!finalOk) {
    if (failure) { console.error(messageOf(failure)); }
    if (!cleanup.released) { console.error(`cleanup did not verify release: errors=${JSON.stringify(cleanup.errors)} remaining=${JSON.stringify(cleanup.remainingResources)}`); }
  }
  return { evidence };
}

async function main(argv: string[]): Promise<number> {
  let args: AbrProbeArgs;
  try { args = parseArgs(argv); }
  catch (error) { console.error(error instanceof UsageError ? `error: ${messageOf(error)}` : messageOf(error)); return 1; }
  if (args.mode === 'help') { printHelp(); return 0; }
  if (args.mode === 'preflight') { return runPreflight(args); }
  try { const result = await runLiveCase(args); return result.evidence.ok === true ? 0 : 1; }
  catch (error) { console.error(`probe failed: ${messageOf(error)}`); return 1; }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(messageOf(error)); process.exitCode = 1; });

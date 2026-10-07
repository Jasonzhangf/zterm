import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import type {
  ClientMessage,
  RemoteWindowCloseRequestPayload,
  RemoteWindowCloseResultPayload,
  RemoteWindowInputDeliveryControl,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamStartedOfferV2Payload,
  ServerMessage,
} from '../src/lib/types';
import { buildRemoteWindowVideoProfile } from '../src/lib/remote-window-video-quality';
import { resolveDaemonRuntimeConfig } from '../src/server/daemon-config';
import {
  buildRemoteWindowInputConfig,
  createDefaultRemoteWindowInputHelper,
  type RemoteWindowInputHelper,
} from '../src/server/remote-window-input-helper';

// `--help` is resolved before any module-scope side effect (daemon-config read,
// tmp dir creation, native addon load) so the help gate stays read-only and
// side-effect free. The wrtc addon is loaded lazily (never statically) so a wrong
// installed native addon can be rejected without touching an old binary at all.
const rawProbeArgs = process.argv.slice(2);
if (rawProbeArgs.some((arg) => arg === '--help' || arg === '-h')) {
  console.log(usageText());
  process.exit(0);
}

// Expected final native addon identity (frozen Root input). Any other resolved
// addon path or digest is a hard failure: the probe must never silently fall back
// to the old packaged addon (old SHA 844f7e2e…) or any other native binary. The
// digest is bound to the exact file Node's public `@roamhq/wrtc` wrapper resolves
// from the selected package root.
const EXPECTED_FINAL_WRTC_ADDON_SHA256 =
  'ca868b88210dd658a993fdfb50cdbcc3db9c6c1504b85a00bb9811ee35f7fe60';

interface RtcVideoFrameLike {
  width: number;
  height: number;
  data: Uint8Array;
}

interface RtcVideoSinkLike {
  onframe: ((event: { frame: RtcVideoFrameLike }) => void) | null;
  stop: () => void;
}

interface WrtcCliOptions {
  packageRoot: string | null;
  addonPath: string | null;
}

// The subset of the public `@roamhq/wrtc` wrapper the probe needs. `data` frames
// are the only accepted media evidence; `nonstandard.RTCVideoSink` is the sole
// decoded-frame source.
interface WrtcBinding {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
  nonstandard: {
    RTCVideoSink: new (track: MediaStreamTrack) => RtcVideoSinkLike;
  };
}

function readWrtcCliOptions(argv: string[]): WrtcCliOptions {
  let packageRoot: string | null = null;
  let addonPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--wrtc-package-root') {
      packageRoot = argv[index + 1]?.trim() || null;
      if (!packageRoot) {
        fail('--wrtc-package-root requires a value');
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--wrtc-package-root=')) {
      packageRoot = arg.slice('--wrtc-package-root='.length).trim();
      continue;
    }
    if (arg === '--wrtc-addon') {
      addonPath = argv[index + 1]?.trim() || null;
      if (!addonPath) {
        fail('--wrtc-addon requires a value');
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--wrtc-addon=')) {
      addonPath = arg.slice('--wrtc-addon='.length).trim();
      continue;
    }
  }
  return {
    packageRoot: packageRoot
      || (process.env.ZTERM_REMOTE_WINDOW_PROBE_WRTC_PACKAGE_ROOT?.trim() || null),
    addonPath: addonPath
      || (process.env.ZTERM_REMOTE_WINDOW_PROBE_WRTC_ADDON?.trim() || null),
  };
}

const requireFromProbe = createRequire(import.meta.url);

// Resolve the exact native addon file the public `@roamhq/wrtc` package wrapper
// (lib/binding.js) will load from the selected package root, mirroring binding.js's
// candidate order (build-<triple> first, then the platform package). Returns the
// real path of the addon that the wrapper would require, so the loader can verify
// its digest before loading.
function resolveResolvedAddonPath(packageRoot: string | null): string {
  const triple = `${process.platform}-${process.arch}`;
  const resolved = packageRoot
    ? createRequire(join(packageRoot, 'lib', 'binding.js'))
    : requireFromProbe;
  const wrapperBinding = packageRoot
    ? join(packageRoot, 'lib', 'binding.js')
    : requireFromProbe.resolve('@roamhq/wrtc/lib/binding.js');
  const pkgDir = dirname(wrapperBinding);
  const candidates: string[] = [
    join(pkgDir, '..', 'build', triple, 'wrtc.node'),
    join(pkgDir, '..', 'build', triple, 'Debug', 'wrtc.node'),
    join(pkgDir, '..', 'build', triple, 'Release', 'wrtc.node'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  // Mirror binding.js's next candidate: the platform package `@roamhq/wrtc-<triple>`.
  // Its package `main` (index.js) merely re-requires `./wrtc.node`, so resolve the
  // real native file directly. Resolve the package main first, then join its dirname,
  // which also covers layouts whose main is a different file name.
  const platformPackage = (() => {
    try {
      return resolved.resolve(`@roamhq/wrtc-${triple}`);
    } catch {
      return null;
    }
  })();
  if (platformPackage) {
    const platformNode = join(dirname(platformPackage), 'wrtc.node');
    if (existsSync(platformNode)) {
      return realpathSync(platformNode);
    }
  }
  try {
    return realpathSync(resolved.resolve(`@roamhq/wrtc-${triple}/wrtc.node`));
  } catch {
    // handled by the caller with a clear failure
  }
  throw new Error(
    `unable to resolve the platform native addon for "${triple}" through the public wrtc wrapper `
    + `${wrapperBinding}; install the final native addon so the public package resolves it`,
  );
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Load the final native addon through the real public `@roamhq/wrtc` package path.
// `--wrtc-addon` (when given) is the exact addon file that MUST be the one the
// public wrapper resolves; any digest/path mismatch is a hard nonzero failure and
// there is never a silent fallback to the old packaged addon.
function loadWrtcBinding(wrtcCli: WrtcCliOptions): WrtcBinding {
  let resolved: string;
  if (wrtcCli.packageRoot && existsSync(join(wrtcCli.packageRoot, 'lib', 'binding.js'))) {
    resolved = resolveResolvedAddonPath(realpathSync(wrtcCli.packageRoot));
  } else {
    resolved = resolveResolvedAddonPath(null);
  }
  if (wrtcCli.addonPath) {
    const requestedReal = realpathSync(wrtcCli.addonPath);
    if (requestedReal !== resolved) {
      throw new Error(
        `--wrtc-addon ${requestedReal} does not match the addon the public wrtc wrapper resolves `
        + `from the selected package root (${resolved}); refusing to load a different native binary`,
      );
    }
  }
  const digest = sha256File(resolved);
  if (digest !== EXPECTED_FINAL_WRTC_ADDON_SHA256) {
    throw new Error(
      `native wrtc addon digest mismatch: resolved ${resolved} sha256=${digest}; `
      + `expected the final installed addon ${EXPECTED_FINAL_WRTC_ADDON_SHA256}. `
      + 'Refusing to load an old/wrong native addon (no silent fallback). '
      + 'Point --wrtc-package-root (or --wrtc-addon) at the final installed daemon native addon.',
    );
  }
  const wrapperMain = wrtcCli.packageRoot
    ? requireFromProbe(join(wrtcCli.packageRoot, 'lib', 'index.js'))
    : requireFromProbe('@roamhq/wrtc');
  const binding = wrapperMain as unknown as WrtcBinding;
  if (typeof binding.RTCPeerConnection !== 'function' || typeof binding.nonstandard?.RTCVideoSink !== 'function') {
    throw new Error('public @roamhq/wrtc wrapper did not expose the expected RTCPeerConnection/nonstandard.RTCVideoSink classes');
  }
  return binding;
}

// Argument validation and the native addon load are intentionally deferred until
// AFTER parseProbeOptions has validated argv (below). That keeps `--help` and any
// invalid argument free of native/daemon/OS side effects, and lets a bad
// `--wrtc-*` selector fail before an old packaged addon could ever be required.
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
// The daemon owns a resident catalog snapshot it self-refreshes on its own
// cadence; a client request only reads that snapshot and never forces a live
// re-enumeration. A freshly launched owned fixture can therefore take one or
// more daemon refresh cycles to appear, so the probe re-reads the SAME snapshot
// with bounded retries instead of forcing a refresh. Harness observation bound
// only; it is not a product constant.
const REMOTE_WINDOW_LIVE_CATALOG_SNAPSHOT_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.ZTERM_REMOTE_WINDOW_PROBE_CATALOG_RETRIES || '16', 10) || 16,
);
const REMOTE_WINDOW_LIVE_CATALOG_RETRY_DELAY_MS = 1_000;
// Harness-chosen observation bounds for the S0 lifecycle cases. These are NOT
// frozen product constants: the design review must replace them with evidence.
// They are env-overridable and are echoed into every case result JSON.
const PROBE_RELEASE_OBSERVE_MS = Number.parseInt(
  process.env.ZTERM_REMOTE_WINDOW_PROBE_RELEASE_OBSERVE_MS || '4000',
  10,
) || 4000;
const PROBE_CLOSE_OBSERVE_MS = Number.parseInt(
  process.env.ZTERM_REMOTE_WINDOW_PROBE_CLOSE_OBSERVE_MS || '2000',
  10,
) || 2000;
// Optional owned, read-only cross-process observer of the OS-level held state
// (left button for the pointer case, physical key state for the key case). When
// provided, the held case samples the OS-level state so `releaseObserved` is
// grounded in an external observation instead of the canonical input helper's
// ACK (helper ACK is not injection proof). When absent the observation is
// reported as unavailable and never fabricated. The binary prints one
// `<seconds> <name>=<int> [<name>=<int> ...]` line per state transition.
const PROBE_OS_SAMPLER_BINARY = (
  process.env.ZTERM_REMOTE_WINDOW_PROBE_OS_SAMPLER
  || process.env.ZTERM_REMOTE_WINDOW_PROBE_BUTTON_SAMPLER
  || ''
).trim();
// Bounded dwell after the release dispatch so the sampler can record the
// release transition before the result is written. Harness observation bound.
const PROBE_RELEASE_DWELL_MS = Number.parseInt(
  process.env.ZTERM_REMOTE_WINDOW_PROBE_RELEASE_DWELL_MS || '1500',
  10,
) || 1500;

// S0 lifecycle cases (harness for the existing capability contract).
// `default` preserves the pre-existing happy-path semantics bit-for-bit.
// The four named cases only SKIP the unrelated quality-setter phase and add the
// stop/held/answer/close observation described in lifecycle-live-capability-worker.prompt.md.
type ProbeCase =
  | 'default'
  | 'held-pointer-stop'
  | 'held-key-stop'
  | 'disconnect-held'
  | 'shared-holders'
  | 'pending-answer-stop'
  | 'owned-close';

const PROBE_CASES: readonly ProbeCase[] = [
  'default',
  'held-pointer-stop',
  'held-key-stop',
  'disconnect-held',
  'shared-holders',
  'pending-answer-stop',
  'owned-close',
];

interface ProbeOptions {
  case: ProbeCase;
  outputDir: string | null;
  help: boolean;
}

function usageText() {
  return [
    'Usage: pnpm --dir android exec tsx scripts/remote-window-lifecycle-joint-probe.ts [options]',
    '',
    'Runs the remote-window lifecycle joint E2E consumer against the installed final daemon over',
    'the public WS protocol using the probe-owned AppKit fixture. Field runs need the final',
    'installed daemon and the final native addon; `--help` exits before any window/RTC/daemon',
    'state or native addon load.',
    '',
    'Options:',
    '  --case <name>       Lifecycle case to run. One of:',
    '                        default              existing happy path (click/gesture/scroll/key + quality setters)',
    '                        held-pointer-stop    pointer held, protocol stop releases OS1 -> OS0, repeat stop, re-entry >=3 frames',
    '                        held-key-stop        KeyZ (Unicode virtualKey 0) held, stop releases OS key0 -> OS0, repeat stop, re-entry >=3 frames',
    '                        disconnect-held      real WS disconnect while physical key0 held -> OS0, fresh socket/fresh stream decodes',
    '                        shared-holders       two real streams hold key0; stopA keeps OS1, stopB -> OS0 (typed cleanup + sampler)',
    '                        pending-answer-stop  receive real offer-v2, stop, then send the original answer; expect typed cancellation, no decoded frames, fresh re-entry succeeds',
    '                        owned-close          typed remote-window-close-request {requestId,sessionId,streamId,targetId}; PASS only on result status closed',
    '                      Default: default (also selectable via ZTERM_REMOTE_WINDOW_PROBE_CASE).',
    '  --output-dir <dir>  Write one JSON result per run to <dir>/<case>.json (created if missing).',
    '  --wrtc-package-root <dir>  Directory of the installed public `@roamhq/wrtc` package to load the final native addon from.',
    '  --wrtc-addon <file>        Exact final native addon file; must equal what the public wrtc wrapper resolves (else nonzero).',
    '  -h, --help          Print this help and exit 0 without touching window/RTC/daemon/native state.',
    '',
    'Environment:',
    '  ZTERM_REMOTE_WINDOW_PROBE_WS_URL          daemon WS url (default ws://127.0.0.1:3333)',
    '  ZTERM_REMOTE_WINDOW_PROBE_AUTH_TOKEN      required for non-loopback daemon url',
    '  ZTERM_REMOTE_WINDOW_PROBE_WRTC_PACKAGE_ROOT  public `@roamhq/wrtc` package dir (or use --wrtc-package-root)',
    '  ZTERM_REMOTE_WINDOW_PROBE_WRTC_ADDON      exact final native addon file (or use --wrtc-addon)',
    '  ZTERM_REMOTE_WINDOW_PROBE_MUX=1           use the mux control channel',
    '  ZTERM_REMOTE_WINDOW_PROBE_SESSION         mux/session name used as the close-request sessionId (default zterm)',
    '  ZTERM_REMOTE_WINDOW_PROBE_BURST=1         burst input (default case only)',
    '  ZTERM_REMOTE_WINDOW_PROBE_KEEP_TMP=1      keep the probe tmp root on exit',
    '  ZTERM_MACOS_SWIFT                         swift binary for the owned manual-cleanup helper (recovery only)',
    '  ZTERM_REMOTE_WINDOW_PROBE_RELEASE_OBSERVE_MS   held-release observation bound (default 4000)',
    '  ZTERM_REMOTE_WINDOW_PROBE_CLOSE_OBSERVE_MS     owned-close observation bound (default 2000)',
    '  ZTERM_REMOTE_WINDOW_PROBE_RELEASE_DWELL_MS     post-release sampler dwell (default 1500)',
    '  ZTERM_REMOTE_WINDOW_PROBE_OS_SAMPLER           owned read-only OS held-state sampler binary (key0/cgLeft)',
    '  ZTERM_REMOTE_WINDOW_PROBE_OS_REQUIRED_SIGNALS  comma list overriding the required OS signal names',
    '',
    'Boundary: cases observe the real public WS protocol, real decoded I420 frames from a real',
    'RTCVideoSink, and an independent OS sampler. They never fake ACK/frame/stats/OS results. A',
    'missing OS signal or a non-clean typed cleanup/close result is an explicit nonzero outcome;',
    'manual cleanup is recovery only and never sets PASS. Each case restores OS0/frontmost and ends',
    'its own fixture (explicit own pid only, natural async drain, no forced process.exit).',
  ].join('\n');
}

function parseProbeOptions(argv: string[]): ProbeOptions {
  let caseName = (process.env.ZTERM_REMOTE_WINDOW_PROBE_CASE || 'default').trim();
  let outputDir: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--case') {
      const value = argv[index + 1];
      if (!value) {
        fail('--case requires a value');
      }
      caseName = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--case=')) {
      caseName = arg.slice('--case='.length).trim();
      continue;
    }
    if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) {
        fail('--output-dir requires a value');
      }
      outputDir = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length).trim();
      continue;
    }
    // The final native addon selector flags are consumed by readWrtcCliOptions
    // before the module-scope load; accept and skip them here so they are not
    // reported as unknown.
    if (arg === '--wrtc-package-root' || arg === '--wrtc-addon') {
      if (!argv[index + 1]) {
        fail(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--wrtc-package-root=') || arg.startsWith('--wrtc-addon=')) {
      continue;
    }
    fail(`unknown argument: ${arg}\n\n${usageText()}`);
  }
  if (help) {
    return { case: 'default', outputDir, help: true };
  }
  if (!(PROBE_CASES as readonly string[]).includes(caseName)) {
    fail(`unknown --case "${caseName}"; expected one of ${PROBE_CASES.join(' | ')}`);
  }
  return { case: caseName as ProbeCase, outputDir, help: false };
}

// These module-scope values are created only after `parseProbeOptions` accepted
// argv. `--help` and unknown-argument failures therefore never create a tmp file,
// read daemon config, load the native addon, or start the owned fixture.
const probeOptions = parseProbeOptions(rawProbeArgs);
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-remote-window-live-input-'));
const DAEMON_WS_URL = resolveDaemonWebSocketUrl(
  process.env.ZTERM_REMOTE_WINDOW_PROBE_WS_URL || 'ws://127.0.0.1:3333',
);
const WRTC_BINDING = loadWrtcBinding(readWrtcCliOptions(rawProbeArgs));

function resolveDaemonWebSocketUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) {
    return url.toString();
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const explicitToken = process.env.ZTERM_REMOTE_WINDOW_PROBE_AUTH_TOKEN?.trim();
  const token = explicitToken || (loopback ? resolveDaemonRuntimeConfig({ homeDir: homedir() }).authToken : '');
  if (!token) {
    throw new Error('remote-window live probe requires ZTERM_REMOTE_WINDOW_PROBE_AUTH_TOKEN for a non-loopback daemon URL');
  }
  url.searchParams.set('token', token);
  return url.toString();
}

function redactDaemonWebSocketUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.searchParams.has('token')) {
    url.searchParams.set('token', '<redacted>');
  }
  return url.toString();
}
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

@interface ProbeDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, assign) BOOL didCreateWindow;
@end

@implementation ProbeDelegate
- (void)windowWillClose:(NSNotification *)notification {
    ProbePrint(@"PROBE_WINDOW_CLOSE");
}

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
    self.window.delegate = self;
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
        // Canonical close affordance: a File > Close (Cmd-W) menu item bound to
        // -performClose:. The daemon's close-window input is a focus + Cmd-W
        // HID keystroke, so a real OS close requires the target app to honour
        // Cmd-W; without this menu a bare NSApplication window ignores it.
        NSMenu *mainMenu = [[NSMenu alloc] init];
        NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
        [mainMenu addItem:appMenuItem];
        NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
        NSMenuItem *closeItem = [[NSMenuItem alloc]
            initWithTitle:@"Close"
            action:@selector(performClose:)
            keyEquivalent:@"w"];
        [fileMenu addItem:closeItem];
        NSMenuItem *fileMenuItem = [[NSMenuItem alloc] init];
        fileMenuItem.title = @"File";
        fileMenuItem.submenu = fileMenu;
        [mainMenu addItem:fileMenuItem];
        [app setMainMenu:mainMenu];
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
      videoProfile: message.payload.appliedVideoProfile,
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
  if (
    message.type === 'remote-window-stream-quality-result'
    && message.payload.status === 'rejected'
    && message.payload.error?.code === 'remote_window_stream_quality_failed'
  ) {
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

// Harness-only raw wire log (both directions) for field evidence. The auth token
// lives in the ws URL and is never part of these frames; the URL is redacted when
// it is written out.
const wireLog: Array<{ direction: 'in' | 'out'; message: unknown }> = [];

function send(ws: WebSocket, message: ClientMessage) {
  wireLog.push({ direction: 'out', message });
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

// The daemon owns the resident catalog snapshot and refreshes it on its own
// cadence; a client `remote-window-targets-request` only reads that snapshot and
// never forces a live re-enumeration. A freshly launched owned fixture can take
// ≥1 daemon refresh cycle to appear, so re-read the same snapshot up to a bounded
// number of times. This relies on the existing catalog owner and adds no second
// refresh strategy.
async function resolveOwnedProbeTarget(
  ws: WebSocket,
  messages: ServerMessage[],
  name: string,
  pid: number,
): Promise<{ target: RemoteWindowStreamTargetManifest; catalog: ServerMessage; attempts: number }> {
  let lastTargetCount = 0;
  let lastMatching: Array<{ id: string; pid: number; title: string; streamMode: string; inputRoute: string }> = [];
  for (let attempt = 1; attempt <= REMOTE_WINDOW_LIVE_CATALOG_SNAPSHOT_RETRIES; attempt += 1) {
    const catalogRequestId = requestId(`catalog-${attempt}`);
    send(ws, {
      type: 'remote-window-targets-request',
      payload: {
        requestId: catalogRequestId,
      },
    });
    const catalog = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-targets-response' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === catalogRequestId
      ),
      `remote window target catalog attempt ${attempt}`,
      REMOTE_WINDOW_LIVE_CATALOG_TIMEOUT_MS,
    );
    if (catalog.type !== 'remote-window-targets-response') {
      fail(`catalog failed (attempt ${attempt}): ${JSON.stringify(catalog)}`);
    }
    const target = catalog.payload.targets.find((candidate) => (
      candidate.videoTarget.kind === 'app-window'
      && candidate.videoTarget.pid === pid
      && candidate.videoTarget.title.includes(name)
      && candidate.streamMode === 'interactive'
      && candidate.inputRoute === 'os-event'
    ));
    if (target) {
      return { target, catalog, attempts: attempt };
    }
    lastTargetCount = catalog.payload.targets.length;
    lastMatching = catalog.payload.targets
      .filter((candidate) => candidate.videoTarget.kind === 'app-window' && candidate.videoTarget.title.includes(name))
      .map((candidate) => ({
        id: candidate.streamTargetId,
        pid: candidate.videoTarget.pid,
        title: candidate.videoTarget.title,
        streamMode: candidate.streamMode,
        inputRoute: candidate.inputRoute,
      }));
    if (attempt < REMOTE_WINDOW_LIVE_CATALOG_SNAPSHOT_RETRIES) {
      await delay(REMOTE_WINDOW_LIVE_CATALOG_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `probe target not found for ${name} (pid=${pid}) after ${REMOTE_WINDOW_LIVE_CATALOG_SNAPSHOT_RETRIES} snapshot reads; `
    + `lastTargetCount=${lastTargetCount}; lastMatchingTitles=${JSON.stringify(lastMatching)}`,
  );
}

// Owned probe socket: the real public WS transport plus its decoded message
// buffer and mux bookkeeping. Every stream session in the joint probe reuses
// this one socket owner (or a fresh instance, for disconnect-held), so the mux
// handshake lives once instead of being duplicated per case.
interface ProbeSocket {
  ws: WebSocket;
  rawFrames: any[];
  messages: ServerMessage[];
  closed: { called: boolean; code: number | null; reason: string };
}

async function openProbeSocket(): Promise<ProbeSocket> {
  const ws = new WebSocket(DAEMON_WS_URL);
  const socket: ProbeSocket = {
    ws,
    rawFrames: [],
    messages: [],
    closed: { called: false, code: null, reason: '' },
  };
  ws.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString('utf8'));
    wireLog.push({ direction: 'in', message: parsed });
    if (USE_MUX) {
      socket.rawFrames.push(parsed);
      if (
        parsed?.type === 'mux-channel-message'
        && parsed.payload?.channelId === PROBE_MUX_CHANNEL_ID
        && parsed.payload?.message?.type
      ) {
        socket.messages.push(parsed.payload.message as ServerMessage);
      }
      return;
    }
    socket.messages.push(parsed as ServerMessage);
  });
  ws.on('close', (code, reason) => {
    socket.closed = { called: true, code, reason: reason?.toString('utf8') || '' };
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
      socket.rawFrames,
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
      socket.rawFrames,
      (frame) => (
        frame?.type === 'mux-channel-opened'
        && frame.payload?.channelId === PROBE_MUX_CHANNEL_ID
      ),
      `mux-channel-opened:${PROBE_MUX_CHANNEL_ID}`,
    );
  }
  return socket;
}

function closeProbeSocket(socket: ProbeSocket) {
  try {
    socket.ws.close();
  } catch {
    // already closing
  }
  try {
    socket.ws.terminate();
  } catch {
    // socket already gone
  }
}

interface StreamFrameInfo {
  at: string;
  elapsedMs: number;
  width: number;
  height: number;
  byteLength: number;
  sha256?: string;
}

interface StreamFrameStats {
  framesDecoded: number;
  frameErrors: string[];
  firstFrame: StreamFrameInfo | null;
  lastFrame: StreamFrameInfo | null;
  receiverTrack: MediaStreamTrack | null;
}

// A real stream session owns exactly one peer connection, one decoded-frame
// sink, and the start/offer/answer negotiation for one streamId. Lifecycle cases
// reuse this opener so a fresh re-entry (new streamId + fresh peer) is just a
// second call. `trackFrames` enables the real I420 sink; the `default` case keeps
// its existing `framesSent` semantics and passes false.
interface StreamSession {
  socket: ProbeSocket;
  streamId: string;
  peerConnection: RTCPeerConnection;
  startRequestId: string;
  offer: RemoteWindowStreamStartedOfferV2Payload;
  sender: (message: ClientMessage) => void;
  trackSeen: () => boolean;
  frames: () => StreamFrameStats;
  sendOriginalAnswer: () => void;
  stopVideoSink: () => void;
  close: () => void;
}

async function openStreamSession(options: {
  binding: WrtcBinding;
  socket: ProbeSocket;
  target: RemoteWindowStreamTargetManifest;
  streamId: string;
  trackFrames: boolean;
  submitAnswer: boolean;
}): Promise<StreamSession> {
  const { binding, socket, target, streamId, trackFrames, submitAnswer } = options;
  const { ws } = socket;
  const startRequestId = requestId(`${streamId}-start`);
  const sender = (message: ClientMessage) => send(ws, message);
  const peerConnection = new binding.RTCPeerConnection({ iceServers: [] });
  peerConnection.addTransceiver('video', { direction: 'recvonly' });
  const stats: StreamFrameStats = {
    framesDecoded: 0,
    frameErrors: [],
    firstFrame: null,
    lastFrame: null,
    receiverTrack: null,
  };
  let trackSeen = false;
  let videoSink: { onframe: ((event: { frame: RtcVideoFrameLike }) => void) | null; stop: () => void } | null = null;
  const stopVideoSink = () => {
    if (!videoSink) {
      return;
    }
    videoSink.onframe = null;
    try {
      videoSink.stop();
    } catch {
      // sink already stopped
    }
    videoSink = null;
  };
  const requestedAtMs = Date.now();
  peerConnection.ontrack = (event) => {
    const primaryTrack = event.track ?? event.streams?.[0]?.getTracks()[0] ?? null;
    if (!primaryTrack || stats.receiverTrack) {
      return;
    }
    stats.receiverTrack = primaryTrack;
    trackSeen = true;
    // Real decoded I420 gate only. `ontrack`/status/framesSent are NOT frames.
    if (!trackFrames) {
      return;
    }
    try {
      videoSink = new binding.nonstandard.RTCVideoSink(primaryTrack);
      videoSink.onframe = (frameEvent) => {
        const frame = frameEvent?.frame;
        if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !frame.data) {
          stats.frameErrors.push(`RTCVideoSink emitted an invalid frame: ${JSON.stringify(frame)}`);
          return;
        }
        const expectedBytes = Math.floor(frame.width * frame.height * 1.5);
        if (frame.data.byteLength !== expectedBytes) {
          stats.frameErrors.push(
            `RTCVideoSink emitted incomplete I420 frame: ${frame.width}x${frame.height} `
            + `bytes=${frame.data.byteLength} expected=${expectedBytes}`,
          );
          return;
        }
        const now = Date.now();
        const info: StreamFrameInfo = {
          at: new Date(now).toISOString(),
          elapsedMs: now - requestedAtMs,
          width: frame.width,
          height: frame.height,
          byteLength: frame.data.byteLength,
        };
        stats.framesDecoded += 1;
        stats.lastFrame = info;
        if (!stats.firstFrame) {
          stats.firstFrame = {
            ...info,
            sha256: createHash('sha256').update(frame.data).digest('hex'),
          };
        }
      };
    } catch (error) {
      videoSink = null;
      stats.frameErrors.push(`RTCVideoSink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    const candidate = event.candidate.toJSON();
    if (!candidate.candidate) {
      return;
    }
    sender({
      type: 'remote-window-stream-ice-candidate',
      payload: {
        requestId: startRequestId,
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
  sender({
    type: 'remote-window-stream-start-v2-request',
    payload: {
      requestId: startRequestId,
      streamId,
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      target,
      videoProfile: buildRemoteWindowVideoProfile('smooth'),
    },
  });
  const started = await waitForServerMessage(
    socket.messages,
    (message) => (
      (message.type === 'remote-window-stream-offer-v2' || message.type === 'remote-window-error')
      && 'requestId' in message.payload
      && message.payload.requestId === startRequestId
      && (
        message.payload.streamId === streamId
        || (message.type === 'remote-window-error' && message.payload.streamId === undefined)
      )
    ),
    `remote window stream start ${streamId}`,
    REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
  );
  if (started.type !== 'remote-window-stream-offer-v2') {
    fail(`stream start failed for ${streamId}: ${JSON.stringify(started)}`);
  }
  const offer = started.payload;
  await peerConnection.setRemoteDescription(new binding.RTCSessionDescription(offer.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  const sendOriginalAnswer = () => {
    sender({
      type: 'remote-window-stream-answer-v2',
      payload: {
        requestId: offer.requestId,
        streamId,
        mediaPlanVersion: 2,
        answer: {
          type: 'answer',
          sdp: peerConnection.localDescription?.sdp || answer.sdp || '',
        },
      },
    });
  };
  if (submitAnswer) {
    sendOriginalAnswer();
  }
  return {
    socket,
    streamId,
    peerConnection,
    startRequestId,
    offer,
    sender,
    trackSeen: () => trackSeen,
    frames: () => stats,
    sendOriginalAnswer,
    stopVideoSink,
    close: () => {
      stopVideoSink();
      try {
        peerConnection.close();
      } catch {
        // already closed
      }
    },
  };
}

async function waitForReceiverTrack(
  binding: WrtcBinding,
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
      await peerConnection.addIceCandidate(new binding.RTCIceCandidate(message.payload.candidate as RTCIceCandidateInit));
    }
    // ontrack may fire while applying SDP, before trickled ICE candidates
    // arrive. Keep admitting candidates until the media transport connects.
    if (hasTrack() && peerConnection.connectionState === 'connected') {
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

function buildInputPayload(
  streamId: string,
  target: RemoteWindowStreamTargetManifest,
  suffix: string,
  event: RemoteWindowInputEventPayload['event'],
): { payload: RemoteWindowInputEventPayload; control: RemoteWindowInputDeliveryControl } {
  const continuous = event.kind === 'scroll' || (event.kind === 'pointer' && event.phase === 'move');
  return {
    payload: {
      streamId,
      targetId: target.streamTargetId,
      event,
    },
    control: {
      version: 1,
      sequence: requestId(suffix),
      lane: continuous ? 'continuous' : 'reliable',
      attempt: 1,
      sentAtMs: Date.now() + CLIENT_CLOCK_OFFSET_MS,
    },
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
  input: { payload: RemoteWindowInputEventPayload; control: RemoteWindowInputDeliveryControl },
) {
  const response = await waitForServerMessage(
    messages,
    (message) => (
      message.type === 'remote-window-input-ack'
      && message.control.sequence === input.control.sequence
    ),
    input.control.sequence,
  );
  if (response.type !== 'remote-window-input-ack' || response.control.accepted !== true) {
    throw new Error(`remote input rejected: ${JSON.stringify(response)}`);
  }
  return response.payload;
}

async function sendInputAndRequireAccepted(
  ws: WebSocket,
  messages: ServerMessage[],
  input: { payload: RemoteWindowInputEventPayload; control: RemoteWindowInputDeliveryControl },
) {
  send(ws, { type: 'remote-window-input', control: input.control, payload: input.payload });
  if (input.control.lane === 'continuous') {
    return input.payload;
  }
  return waitForInputAccepted(messages, input);
}

interface S0StopResult {
  message: ServerMessage | null;
  timedOut: boolean;
}

async function requestStopAndObserve(
  ws: WebSocket,
  messages: ServerMessage[],
  streamId: string,
  suffix: string,
  timeoutMs = 15_000,
): Promise<S0StopResult> {
  const startIndex = messages.length;
  send(ws, {
    type: 'remote-window-stream-stop-request',
    payload: {
      requestId: requestId(suffix),
      streamId,
    },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = startIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (
        (message?.type === 'remote-window-stream-status' || message?.type === 'remote-window-error')
        && message.payload.streamId === streamId
      ) {
        return { message, timedOut: false };
      }
    }
    await delay(25);
  }
  // A repeated stop for an already-closed stream is not guaranteed to emit a
  // second terminal message; record the timeout instead of crashing the case.
  return { message: null, timedOut: true };
}

async function sendInputAndObserveAck(
  ws: WebSocket,
  messages: ServerMessage[],
  input: { payload: RemoteWindowInputEventPayload; control: RemoteWindowInputDeliveryControl },
  timeoutMs = 10_000,
): Promise<ServerMessage | null> {
  const startIndex = messages.length;
  send(ws, { type: 'remote-window-input', control: input.control, payload: input.payload });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = startIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.type === 'remote-window-input-ack' && message.control.sequence === input.control.sequence) {
        return message;
      }
    }
    await delay(25);
  }
  return null;
}

function pointerCenter(center: { x: number; y: number }) {
  return {
    pointerId: 1,
    button: 'left' as const,
    buttons: 0,
    x: center.x,
    y: center.y,
    normalizedX: 0.5,
    normalizedY: 0.5,
  };
}

function pointerDownEvent(center: { x: number; y: number }): RemoteWindowInputEventPayload['event'] {
  return { kind: 'pointer', phase: 'down', ...pointerCenter(center), buttons: 1 };
}

function pointerUpEvent(center: { x: number; y: number }): RemoteWindowInputEventPayload['event'] {
  return { kind: 'pointer', phase: 'up', ...pointerCenter(center), buttons: 0 };
}

function keyDownEvent(): RemoteWindowInputEventPayload['event'] {
  return { kind: 'key', phase: 'down', key: 'z', code: 'KeyZ', text: 'z' };
}

function keyUpEvent(): RemoteWindowInputEventPayload['event'] {
  return { kind: 'key', phase: 'up', key: 'z', code: 'KeyZ', text: 'z' };
}

function describeStopResult(result: S0StopResult) {
  if (result.timedOut || !result.message) {
    return { timedOut: true as const };
  }
  const message = result.message;
  if (message.type === 'remote-window-stream-status') {
    return {
      type: message.type,
      phase: message.payload.phase,
      framesSent: message.payload.framesSent ?? null,
      message: message.payload.message ?? null,
    };
  }
  if (message.type === 'remote-window-error') {
    return {
      type: message.type,
      code: message.payload.code,
      message: message.payload.message,
    };
  }
  return { type: message.type };
}

function describeInputAck(message: ServerMessage | null) {
  if (!message || message.type !== 'remote-window-input-ack') {
    return { observed: false as const, raw: message ?? null };
  }
  return {
    observed: true as const,
    accepted: message.control.accepted === true,
    errorCode: message.control.error?.code ?? null,
    errorMessage: message.control.error?.message ?? null,
    resultStreamId: message.payload.streamId,
    resultTargetId: message.payload.targetId,
  };
}

function writeCaseResult(outputDir: string | null, caseName: ProbeCase, result: unknown) {
  if (!outputDir) {
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${caseName}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

function summarizeStreamMessage(message: ServerMessage) {
  if (message.type === 'remote-window-stream-status') {
    return {
      type: message.type,
      phase: message.payload.phase,
      framesSent: message.payload.framesSent ?? null,
      message: message.payload.message ?? null,
    };
  }
  if (message.type === 'remote-window-error') {
    return {
      type: message.type,
      requestId: message.payload.requestId,
      streamId: message.payload.streamId,
      code: message.payload.code,
      message: message.payload.message,
    };
  }
  return { type: message.type };
}

async function sendAnswerAndObserve(
  ws: WebSocket,
  messages: ServerMessage[],
  startRequestId: string,
  streamId: string,
  peerConnection: RTCPeerConnection,
  timeoutMs = 10_000,
) {
  // Observe ONLY messages emitted after this answer is sent. The stream was
  // stopped before answering, so a pre-stop `starting`/`streaming` status must
  // never be mistaken for the post-stop answer verdict.
  const startIndex = messages.length;
  send(ws, {
    type: 'remote-window-stream-answer-v2',
    payload: {
      requestId: startRequestId,
      streamId,
      mediaPlanVersion: 2,
      answer: {
        type: 'answer',
        sdp: peerConnection.localDescription?.sdp || '',
      },
    },
  });
  // The daemon rejects a late answer for a stopped stream with the typed
  // `remote_window_stream_answer_cancelled` contract code. Older `answer_failed`
  // wording is not accepted as PASS for this lifecycle contract.
  const isPostAnswerVerdict = (message: ServerMessage) => {
    if (message.type === 'remote-window-error') {
      // Correlate to the ORIGINAL pending start request/stream: another request
      // that merely reused the same cancellation code must not be accepted as
      // this late answer's settlement.
      return message.payload.code === 'remote_window_stream_answer_cancelled'
        && message.payload.requestId === startRequestId
        && message.payload.streamId === streamId;
    }
    if (message.type === 'remote-window-stream-status' && message.payload.streamId === streamId) {
      return false;
    }
    return false;
  };
  const deadline = Date.now() + timeoutMs;
  let verdict: ServerMessage | null = null;
  while (Date.now() < deadline && !verdict) {
    for (let index = startIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (message && isPostAnswerVerdict(message)) {
        verdict = message;
        break;
      }
    }
    if (!verdict) {
      await delay(25);
    }
  }
  // Settle briefly so trailing teardown errors after the first verdict land too.
  await delay(300);
  const postAnswerMessages = messages.slice(startIndex).map(summarizeStreamMessage);
  return {
    observed: postAnswerMessages.length > 0,
    timedOut: verdict === null,
    verdict: verdict ? summarizeStreamMessage(verdict) : null,
    postAnswerMessages,
  };
}

function tryAppleScript(source: string): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync('osascript', ['-e', source], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || result.stdout || source).trim() };
  }
  return { ok: true, stdout: result.stdout.trim() };
}

function resolveProbeSwiftBinary() {
  return (process.env.ZTERM_MACOS_SWIFT || 'swift').trim();
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readOwnedWindowCount(pid: number): { count: number | null; error: string | null } {
  const raw = tryAppleScript(
    `tell application "System Events" to count windows of (first application process whose unix id is ${pid})`,
  );
  if (!raw.ok) {
    return { count: null, error: raw.stderr };
  }
  const count = Number.parseInt(raw.stdout, 10);
  return {
    count: Number.isFinite(count) ? count : null,
    error: Number.isFinite(count) ? null : `unparsable window count: ${raw.stdout || 'empty'}`,
  };
}

interface ManualCleanupResult {
  lane: 'reliable';
  mechanism: 'canonical-input-helper-manual-cleanup';
  countedAsDaemonReleasePass: false;
  attempted: true;
  ok: boolean;
  error: string | null;
  event: RemoteWindowInputEventPayload['event'];
  swiftBinary: string;
}

async function manualCleanupHeldInput(options: {
  streamId: string;
  target: RemoteWindowStreamTargetManifest;
  event: RemoteWindowInputEventPayload['event'];
}): Promise<ManualCleanupResult> {
  const swiftBinary = resolveProbeSwiftBinary();
  const helper: RemoteWindowInputHelper = createDefaultRemoteWindowInputHelper({ swiftBinary });
  const base: Omit<ManualCleanupResult, 'ok' | 'error'> = {
    lane: 'reliable',
    mechanism: 'canonical-input-helper-manual-cleanup',
    countedAsDaemonReleasePass: false,
    attempted: true,
    event: options.event,
    swiftBinary,
  };
  try {
    await helper.warm();
    await helper.send(
      buildRemoteWindowInputConfig(
        { streamId: options.streamId, targetId: options.target.streamTargetId, event: options.event },
        options.target,
      ),
      { lane: 'reliable' },
    );
    return { ...base, ok: true, error: null };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await helper.dispose();
    } catch {
      // dispose only tears down our own helper child; never mask the original result.
    }
  }
}

interface CleanupCapabilityResult {
  checked: true;
  ok: boolean;
  swiftBinary: string;
  error: string | null;
}

async function confirmHeldCleanupCapability(): Promise<CleanupCapabilityResult> {
  const swiftBinary = resolveProbeSwiftBinary();
  const helper: RemoteWindowInputHelper = createDefaultRemoteWindowInputHelper({ swiftBinary });
  try {
    await helper.warm();
    return { checked: true, ok: true, swiftBinary, error: null };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      swiftBinary,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await helper.dispose();
    } catch {
      // dispose only tears down our own helper child; never mask the original result.
    }
  }
}

interface ReleaseResult {
  route: 'public-wire' | 'manual-cleanup';
  countedAsDaemonReleasePass: false;
  wireAck: ReturnType<typeof describeInputAck>;
  manualCleanup: ManualCleanupResult | null;
}

async function releaseHeldInput(
  ws: WebSocket,
  messages: ServerMessage[],
  streamId: string,
  target: RemoteWindowStreamTargetManifest,
  suffix: string,
  upEvent: RemoteWindowInputEventPayload['event'],
): Promise<ReleaseResult> {
  // Prefer the same public wire owner the daemon uses. After stop this is usually
  // rejected with `remote_window_input_stream_missing`; only then fall back to the
  // installed canonical input-helper owner for a self-scoped manual cleanup.
  const wireAck = await sendInputAndObserveAck(ws, messages, buildInputPayload(streamId, target, suffix, upEvent));
  const wireAccepted = wireAck?.type === 'remote-window-input-ack' && wireAck.control.accepted === true;
  if (wireAccepted) {
    return {
      route: 'public-wire',
      countedAsDaemonReleasePass: false,
      wireAck: describeInputAck(wireAck),
      manualCleanup: null,
    };
  }
  const manualCleanup = await manualCleanupHeldInput({ streamId, target, event: upEvent });
  return {
    route: 'manual-cleanup',
    countedAsDaemonReleasePass: false,
    wireAck: describeInputAck(wireAck),
    manualCleanup,
  };
}

async function waitForDecodedFrames(getCount: () => number, label: string, timeoutMs = 15_000, minFrames = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getCount() >= minFrames) {
      return;
    }
    await delay(50);
  }
  fail(`${label}: timed out waiting for ${minFrames} decoded RTCVideoSink frame${minFrames === 1 ? '' : 's'}; ontrack/framesSent/status are not frame evidence`);
}

async function waitProbeMarkerBriefly(lines: string[], marker: string, windowMs: number) {
  const before = countProbeLines(lines, marker);
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (countProbeLines(lines, marker) > before) {
      return { observed: true as const, count: countProbeLines(lines, marker) - before, windowMs };
    }
    await delay(50);
  }
  return { observed: false as const, count: 0, windowMs };
}

interface OsSamplerSample {
  t: number;
  states: Record<string, number>;
}

interface OsSamplerObservation {
  available: boolean;
  binary: string | null;
  spawnError: string | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  samples: OsSamplerSample[];
  signalKeys: string[];
  requiredSignals: string[];
  baselineClear: boolean;
  heldObserved: boolean;
  releasedObserved: boolean;
  lastState: number | null;
}

// Physical signal(s) that must be asserted for a case to count as a real held
// physical down. The pointer case needs the left button; the key case needs the
// physical Z keycode. KeyZ is absent from the helper keyCodes map, so the helper
// posts the Unicode branch: a CGEvent with virtualKey 0 plus keyboardSetUnicodeString
// (see remote-window-input-helper.ts). The observable OS signal is therefore key0,
// never key6; requiring key6 would silently observe the wrong carrier.
const OS_REQUIRED_SIGNALS_BY_CASE: Record<string, string[]> = {
  'held-pointer-stop': ['cgLeft'],
  'held-key-stop': ['key0'],
  'shared-holders': ['key0'],
  'disconnect-held': ['key0'],
};

function resolveRequiredOsSignals(caseName: string): string[] {
  const fromEnv = (process.env.ZTERM_REMOTE_WINDOW_PROBE_OS_REQUIRED_SIGNALS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  return OS_REQUIRED_SIGNALS_BY_CASE[caseName] ?? [];
}

function parseOsSamplerLines(lines: string[]): OsSamplerSample[] {
  const samples: OsSamplerSample[] = [];
  for (const line of lines) {
    const match = line.match(/^(\d+(?:\.\d+)?)\s+(.*\S)\s*$/);
    if (!match) {
      continue;
    }
    const states: Record<string, number> = {};
    for (const pair of match[2].split(/\s+/)) {
      const kv = pair.match(/^([A-Za-z][A-Za-z0-9_]*)=(-?\d+)$/);
      if (kv) {
        states[kv[1]] = Number(kv[2]);
      }
    }
    if (Object.keys(states).length > 0) {
      samples.push({ t: Number(match[1]), states });
    }
  }
  return samples;
}

function summarizeOsSampler(options: {
  available: boolean;
  binary: string | null;
  spawnError: string | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  samples: OsSamplerSample[];
  requiredSignals: string[];
}): OsSamplerObservation {
  const signalKeys = Array.from(new Set(options.samples.flatMap((sample) => Object.keys(sample.states))));
  const requiredSignals = options.requiredSignals.length > 0
    ? options.requiredSignals
    : signalKeys;
  // "Held" means ANY required signal is asserted. Signals the sampler reported but
  // that are not required for this case (e.g. the unicode branch's non-physical
  // carrier keycode) can never be promoted into the physical held verdict.
  const states = options.samples.map((sample) => (
    requiredSignals.some((key) => sample.states[key] === 1) ? 1 : 0
  ));
  // A held state only counts when the sampler first observed a clear baseline, so
  // a pre-existing held button (not caused by this case) can never be promoted to
  // "this case held it". A release only counts after that observed held state.
  let baselineClear = false;
  let heldObserved = false;
  let releasedObserved = false;
  for (const state of states) {
    if (state === 0) {
      if (heldObserved) {
        releasedObserved = true;
      } else {
        baselineClear = true;
      }
    } else if (baselineClear && !releasedObserved) {
      heldObserved = true;
    }
  }
  return {
    ...options,
    signalKeys,
    requiredSignals,
    baselineClear,
    heldObserved,
    releasedObserved,
    lastState: states.length > 0 ? states[states.length - 1] : null,
  };
}

const UNAVAILABLE_OS_SAMPLER: OsSamplerObservation = summarizeOsSampler({
  available: false,
  binary: null,
  spawnError: null,
  exit: null,
  samples: [],
  requiredSignals: [],
});

function requiredSignalState(sample: OsSamplerSample, requiredSignals: string[]): 0 | 1 {
  return requiredSignals.some((key) => sample.states[key] === 1) ? 1 : 0;
}

// Post-action sampler window. Cumulative `heldObserved`/`releasedObserved` can
// stay true once a transient held appears even when the latest physical state has
// cleared (or vice versa), so a stop cannot pass by merely having ever held. This
// mirrors the transitions AFTER the given sample index and asserts the carried
// start state plus every later sample, grounding the verdict in the latest
// physical current state rather than the entire history.
interface OsSamplerWindowObservation {
  fromSampleIndex: number;
  sampleCount: number;
  startState: number | null;
  endState: number | null;
  heldThroughout: boolean;
  releasedThroughout: boolean;
}

function summarizeOsSamplerWindow(
  handle: OsSamplerHandle,
  caseName: string,
  fromSampleIndex: number,
): OsSamplerWindowObservation {
  const samples = parseOsSamplerLines(handle.lines);
  const requiredSignals = resolveRequiredOsSignals(caseName);
  const states = samples.map((sample) => requiredSignalState(sample, requiredSignals));
  const before = states.slice(0, fromSampleIndex);
  const windowStates = states.slice(fromSampleIndex);
  const startState = before.length > 0 ? before[before.length - 1]! : null;
  const endState = windowStates.length > 0 ? windowStates[windowStates.length - 1]! : startState;
  return {
    fromSampleIndex,
    sampleCount: windowStates.length,
    startState,
    endState,
    heldThroughout: startState === 1 && windowStates.every((state) => state === 1),
    releasedThroughout: startState === 0 && windowStates.every((state) => state === 0),
  };
}

// Bounded wait for the sampler's LATEST physical state to reach `expected`.
// This is an active observation of the owned sampler (never a fixed-delay
// substitute) and lets a case bind held/release windows to a concrete action
// boundary without racing the async sampler output.
async function waitForOsSamplerState(
  handle: OsSamplerHandle,
  caseName: string,
  expected: 0 | 1,
  label: string,
  timeoutMs = PROBE_RELEASE_OBSERVE_MS,
): Promise<void> {
  const requiredSignals = resolveRequiredOsSignals(caseName);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const samples = parseOsSamplerLines(handle.lines);
    if (samples.length > 0 && requiredSignalState(samples[samples.length - 1]!, requiredSignals) === expected) {
      return;
    }
    await delay(50);
  }
  fail(`${label}: OS sampler never observed required signal state=${expected}; signals=${JSON.stringify(requiredSignals)}`);
}

async function observeOwnedWindowClose(
  targetPid: number,
  probeLines: string[],
  windowMs: number,
) {
  const pidAliveBefore = isPidAlive(targetPid);
  const windowsBefore = readOwnedWindowCount(targetPid);
  const deadline = Date.now() + windowMs;
  let windowsAfter = windowsBefore;
  let pidAliveAfter = pidAliveBefore;
  let closeMarker = false;
  while (Date.now() < deadline) {
    windowsAfter = readOwnedWindowCount(targetPid);
    pidAliveAfter = isPidAlive(targetPid);
    if (countProbeLines(probeLines, 'PROBE_WINDOW_CLOSE') > 0) {
      closeMarker = true;
    }
    if (closeMarker || (windowsAfter.count === 0) || !pidAliveAfter) {
      break;
    }
    await delay(100);
  }
  return {
    pidAliveBefore,
    windowsBefore,
    pidAliveAfter,
    windowsAfter,
    closeMarker,
    osClosed: closeMarker || windowsAfter.count === 0 || !pidAliveAfter,
    windowMs,
  };
}

async function waitForOwnedCloseObservation(
  targetPid: number,
  probeLines: string[],
  windowMs: number,
) {
  const deadline = Date.now() + windowMs;
  let last: Awaited<ReturnType<typeof observeOwnedWindowClose>> | null = null;
  while (Date.now() < deadline) {
    last = await observeOwnedWindowClose(targetPid, probeLines, 50);
    if (last.osClosed) {
      return last;
    }
    await delay(100);
  }
  return last ?? await observeOwnedWindowClose(targetPid, probeLines, 50);
}

// Owned read-only OS state sampler lifecycle. The binary prints one
// `<seconds> <name>=<int> [...]` line per transition; it is always terminated
// by its explicit pid (never a shared helper). The whole held/release bracket is
// captured so every lifecycle case can assert an OS-level held and release that
// is independent of any helper ACK.
interface OsSamplerHandle {
  lines: string[];
  child: ReturnType<typeof spawn> | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  spawnError: string | null;
  terminator: () => Promise<void>;
}

function summarizeCurrentOsSampler(handle: OsSamplerHandle, caseName: string) {
  return summarizeOsSampler({
    available: true,
    binary: PROBE_OS_SAMPLER_BINARY,
    spawnError: handle.spawnError,
    exit: handle.exit,
    samples: parseOsSamplerLines(handle.lines),
    requiredSignals: resolveRequiredOsSignals(caseName),
  });
}

function startOsSampler(binary: string, seconds: number): OsSamplerHandle {
  const lines: string[] = [];
  const handle: OsSamplerHandle = {
    lines,
    child: null,
    exit: null,
    spawnError: null,
    terminator: async () => {
      if (handle.child && handle.child.pid && Number.isInteger(handle.child.pid)) {
        try {
          process.kill(handle.child.pid, 'SIGTERM');
        } catch {
          // already exited on its own
        }
        await delay(150);
        try {
          process.kill(handle.child.pid, 0);
          process.kill(handle.child.pid, 'SIGKILL');
        } catch {
          // exited after SIGTERM
        }
      }
    },
  };
  handle.child = spawn(binary, [String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
  handle.child.stdout?.setEncoding('utf8');
  handle.child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line.trim());
      }
    }
  });
  handle.child.on('error', (error) => {
    handle.spawnError = error instanceof Error ? error.message : String(error);
  });
  handle.child.on('exit', (code, signal) => {
    handle.exit = { code, signal };
  });
  return handle;
}

// Stop-cleanup typing. Only `released` (or the already-cleared `absent` for a
// repeated stop of an inactive stream) is a clean terminal protocol result; any
// `cleanup_failed`/`failed`/`unverified` result is an explicit outcome that can
// never count as PASS.
function describeStopCleanup(message: ServerMessage | null) {
  if (!message || message.type !== 'remote-window-stream-status') {
    return { present: false as const, status: null, remainingResources: [] as string[], errors: [] as string[] };
  }
  const cleanup = message.payload.cleanup;
  if (!cleanup) {
    return { present: false as const, status: null, remainingResources: [] as string[], errors: [] as string[] };
  }
  return {
    present: true as const,
    status: cleanup.status,
    remainingResources: cleanup.remainingResources,
    errors: cleanup.errors.map((error) => error.message),
  };
}

function cleanupIsClean(cleanup: ReturnType<typeof describeStopCleanup>): boolean {
  return cleanup.present && (cleanup.status === 'released' || cleanup.status === 'absent');
}

function cleanupIsFullyClean(cleanup: ReturnType<typeof describeStopCleanup>): boolean {
  return cleanupIsClean(cleanup)
    && cleanup.remainingResources.length === 0
    && cleanup.errors.length === 0;
}

// A stop terminal must be the typed status for the exact request/stream, be in
// the stopped phase, and carry a clean (released/absent) cleanup with no
// remaining resources or errors. Missing/failed/unverified cleanup or a timeout
// is an explicit nonzero outcome, never a PASS.
function assertTypedCleanStop(
  result: S0StopResult,
  expectedRequestId: string,
  expectedStreamId: string,
  label: string,
): void {
  if (result.timedOut || !result.message) {
    fail(`${label}: stop timed out or returned no terminal message: ${JSON.stringify(result)}`);
  }
  const message = result.message;
  if (message.type !== 'remote-window-stream-status') {
    fail(`${label}: stop returned a non-status terminal: ${JSON.stringify(message)}`);
  }
  const payload = message.payload;
  if (payload.streamId !== expectedStreamId) {
    fail(`${label}: stop stream mismatch: expected ${expectedStreamId} got ${payload.streamId}`);
  }
  if (payload.requestId !== expectedRequestId) {
    fail(`${label}: stop requestId mismatch: expected ${expectedRequestId} got ${payload.requestId}`);
  }
  if (payload.phase !== 'stopped') {
    fail(`${label}: stop phase is not stopped: ${JSON.stringify(message)}`);
  }
  const cleanup = describeStopCleanup(message);
  if (!cleanupIsFullyClean(cleanup)) {
    fail(`${label}: stop cleanup is not clean (released/absent, no remaining resources/errors): ${JSON.stringify(cleanup)}`);
  }
}

async function runHeldStopFlow(options: {
  caseName: 'held-pointer-stop' | 'held-key-stop';
  binding: WrtcBinding;
  socket: ProbeSocket;
  target: RemoteWindowStreamTargetManifest;
  targetPid: number;
  probeLines: string[];
  outputDir: string | null;
}) {
  const { caseName, binding, socket, target, targetPid, probeLines, outputDir } = options;
  const { ws, messages } = socket;
  const isPointer = caseName === 'held-pointer-stop';
  const center = targetCenter(target);
  const downEvent = isPointer ? pointerDownEvent(center) : keyDownEvent();
  const upEvent = isPointer ? pointerUpEvent(center) : keyUpEvent();
  const downMarker = isPointer ? 'PROBE_MOUSE_DOWN' : 'PROBE_KEY_DOWN';
  const upMarker = isPointer ? 'PROBE_MOUSE_UP' : 'PROBE_KEY_UP';
  // Declared outside the outer try so a failure result can still carry the
  // sampler observation that was captured before the failure.
  let samplerObservation: OsSamplerObservation = UNAVAILABLE_OS_SAMPLER;
  const samplerLines: string[] = [];
  let samplerChild: ReturnType<typeof spawn> | null = null;
  let samplerExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let samplerSpawnError: string | null = null;
  const samplerEnabled = PROBE_OS_SAMPLER_BINARY.length > 0;
  let heldStreamId = requestId('stream-held-a');
  let blockedResult: unknown = null;
  let wroteFullResult = false;
  let reentryObservation: {
    streamId: string;
    framesDecoded: number;
    frameErrors: string[];
  } | null = null;
  const openedSessions: StreamSession[] = [];
  const heldCleanupErrors: string[] = [];
  try {
    // Real stream A: the held state is created against a live, frame-decoding
    // stream, and the fixture down marker is only trusted after at least one real
    // decoded I420 frame has arrived on this same real stream.
    const sessionA = await openStreamSession({
      binding,
      socket,
      target,
      streamId: requestId('stream-held-a'),
      trackFrames: true,
      submitAnswer: true,
    });
    openedSessions.push(sessionA);
    await waitForReceiverTrack(binding, sessionA.peerConnection, messages, sessionA.streamId, sessionA.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
    await waitForServerMessage(
      messages,
      (message) => (
        message.type === 'remote-window-stream-status'
        && message.payload.streamId === sessionA.streamId
        && message.payload.phase === 'streaming'
      ),
      `remote window stream streaming ${sessionA.streamId}`,
      REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
    );
    await waitForDecodedFrames(() => sessionA.frames().framesDecoded, caseName);
    // Cleanup capability must be confirmed BEFORE any held state is created, so
    // we never manufacture a held then guess how to recover it. `warm()` spawns
    // the canonical input-helper child and confirms its public protocol is up
    // (no injection, no held state). If unsupported, BLOCK without a down.
    const cleanupCapability = await confirmHeldCleanupCapability();
    if (!cleanupCapability.ok) {
      blockedResult = {
        ok: false,
        mode: caseName,
        blocked: true,
        blockedReason: 'held cleanup capability (canonical input helper warm) not confirmed before down',
        daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
        controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
        targetId: target.streamTargetId,
        targetPid,
        streamId: heldStreamId,
        cleanupCapability,
        error: `cleanup capability unsupported before held: ${cleanupCapability.error ?? 'unknown'}`,
        probeLines: readProbeLines(probeLines),
      };
      writeCaseResult(outputDir, caseName, blockedResult);
      fail(`held case ${caseName} BLOCKED: canonical input helper cleanup capability not confirmed before down (${cleanupCapability.error ?? 'unknown'}); no held state created`);
    }
    // Once the down is dispatched, a matching up must be released on every exit
    // path (success, assertion failure, or a later timeout) so the field run can
    // never leave the owned target in a held state.
    let downDispatched = false;
    let downAck: ServerMessage | null = null;
    let framesAtDown = 0;
    let stopped: S0StopResult = { message: null, timedOut: true };
    let upAfterStop: { observed: boolean; count: number; windowMs: number } = { observed: false, count: 0, windowMs: 0 };
    let framesAfterStop = 0;
    let stopRepeat: S0StopResult = { message: null, timedOut: true };
    let release: ReleaseResult | null = null;
    try {
      if (samplerEnabled) {
        // Start the owned read-only observer before the down so the held/release
        // cycle is bracketed by a clear baseline. The duration covers the case
        // plus the post-release dwell; this child is always terminated below by
        // its explicit pid (never a shared helper).
        samplerChild = spawn(
          PROBE_OS_SAMPLER_BINARY,
          [String(Math.ceil((PROBE_RELEASE_OBSERVE_MS * 3 + 60_000) / 1000))],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        samplerChild.stdout?.setEncoding('utf8');
        samplerChild.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim()) {
              samplerLines.push(line.trim());
            }
          }
        });
        samplerChild.on('error', (error) => {
          samplerSpawnError = error instanceof Error ? error.message : String(error);
        });
        samplerChild.on('exit', (code, signal) => {
          samplerExit = { code, signal };
        });
      }
      downAck = await sendInputAndObserveAck(
        ws,
        messages,
        buildInputPayload(sessionA.streamId, target, 'held-down', downEvent),
      );
      if (!downAck || downAck.type !== 'remote-window-input-ack' || downAck.control.accepted !== true) {
        fail(`${caseName}: down rejected before stop: ${JSON.stringify(downAck)}`);
      }
      downDispatched = true;
      await waitForProbeLine(probeLines, downMarker);
      framesAtDown = sessionA.frames().framesDecoded;
      stopped = await requestStopAndObserve(ws, messages, sessionA.streamId, 'stop-held');
      assertTypedCleanStop(stopped, requestId('stop-held'), sessionA.streamId, `${caseName} stop`);
      upAfterStop = await waitProbeMarkerBriefly(probeLines, upMarker, PROBE_RELEASE_OBSERVE_MS);
      framesAfterStop = sessionA.frames().framesDecoded;
      stopRepeat = await requestStopAndObserve(ws, messages, sessionA.streamId, 'stop-held-repeat');
      assertTypedCleanStop(stopRepeat, requestId('stop-held-repeat'), sessionA.streamId, `${caseName} repeat stop`);
    } finally {
      if (samplerEnabled) {
        // Bounded dwell so the sampler can record the release transition before
        // any recovery release is attempted; manual-up cleanup never backs a PASS.
        await delay(PROBE_RELEASE_DWELL_MS);
        samplerObservation = summarizeOsSampler({
          available: true,
          binary: PROBE_OS_SAMPLER_BINARY,
          spawnError: samplerSpawnError,
          exit: samplerExit,
          samples: parseOsSamplerLines(samplerLines),
          requiredSignals: resolveRequiredOsSignals(caseName),
        });
        if (samplerChild && samplerChild.pid && Number.isInteger(samplerChild.pid)) {
          try {
            process.kill(samplerChild.pid, 'SIGTERM');
          } catch {
            // already exited on its own
          }
          await delay(150);
          try {
            process.kill(samplerChild.pid, 0);
            process.kill(samplerChild.pid, 'SIGKILL');
          } catch {
            // exited after SIGTERM
          }
        }
      }
      if (downDispatched) {
        try {
          release = await releaseHeldInput(ws, messages, sessionA.streamId, target, 'held-up', upEvent);
        } catch (error) {
          heldCleanupErrors.push(`releaseHeldInput: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const markerDownObserved = downDispatched && countProbeLines(probeLines, downMarker) > 0;
    // A real held down requires BOTH the fixture's delivered-event marker AND an
    // OS-level observation of the case's required physical signal. A marker whose
    // keycode never asserts the physical key (the unicode carrier) is recorded as
    // NOT_APPLICABLE_WITH_CONTRACT rather than promoted to a confirmed held.
    const samplerRequiredSatisfied = !samplerEnabled
      || samplerObservation.signalKeys.length === 0
      || samplerObservation.heldObserved;
    const downObserved = markerDownObserved && samplerRequiredSatisfied;
    const physicalDownNotApplicable = markerDownObserved && samplerEnabled
      && !samplerObservation.heldObserved
      && samplerObservation.signalKeys.length > 0;
    const releaseObserved = upAfterStop.observed || samplerObservation.releasedObserved;
    const releaseObservationSource = upAfterStop.observed
      ? 'fixture-marker'
      : (samplerObservation.releasedObserved ? 'os-button-sampler' : 'unobserved');
    const applicability = physicalDownNotApplicable
      ? 'NOT_APPLICABLE_WITH_CONTRACT'
      : (downObserved ? 'held-observed' : 'down-not-observed');
    const result = {
      ok: true,
      mode: caseName,
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetId: target.streamTargetId,
      targetPid,
      streamId: sessionA.streamId,
      cleanupCapability,
      downMarker,
      upMarker,
      applicability,
      downAck: describeInputAck(downAck),
      keySemantics: isPointer ? null : {
        code: 'KeyZ',
        branch: 'unicode',
        note: 'KeyZ is absent from the helper keyCodes map and posts a CGEvent(virtualKey:0) with keyboardSetUnicodeString; '
          + 'down/up are two separate CGEvent posts, so a sustained physical keydown is statistically unlikely. '
          + 'This field run must confirm whether a real keydown can be held; if not, report NOT_APPLICABLE_WITH_CONTRACT.',
      },
      framesAtDown,
      framesAfterStop,
      framesAfterStopDelta: framesAfterStop - framesAtDown,
      stopHeld: describeStopResult(stopped),
      stopHeldCleanup: describeStopCleanup(stopped.message),
      stopRepeat,
      stopRepeatCleanup: describeStopCleanup(stopRepeat.message),
      upAfterStop,
      release,
      osStateSampler: samplerObservation,
      physicallyHeld: {
        // Observer layering: the native down marker plus an external release
        // observation are the only held/release evidence. The canonical helper's
        // ACK is NOT injection proof and never substitutes for an observation.
        downDispatched,
        markerDownObserved,
        downObserved,
        physicalDownNotApplicable,
        upObservedByStop: upAfterStop.observed,
        releaseObserved,
        releaseObservationSource,
        osSignals: samplerObservation.signalKeys,
        osHeldObserved: samplerObservation.heldObserved,
        osReleasedObserved: samplerObservation.releasedObserved,
        osLastState: samplerObservation.lastState,
      },
      probeLines: readProbeLines(probeLines),
    };
    if (downObserved && !releaseObserved) {
      const stopHeldCleanup = describeStopCleanup(stopped.message);
      const stopRepeatCleanup = describeStopCleanup(stopRepeat.message);
      // A real physical down was not released within the observation window. The
      // failure result (ok:false + cleanup errors) is published by the catch
      // tail, so no ok:true file survives an unreleased down.
      fail(`${caseName}: a physical down was observed but no release was observed after stop `
        + `(stop cleanup=${JSON.stringify(stopHeldCleanup)}, repeat cleanup=${JSON.stringify(stopRepeatCleanup)}, `
        + `(fixture up marker=${upAfterStop.observed}, os release=${samplerObservation.releasedObserved}, `
        + `os lastState=${samplerObservation.lastState}); `
        + 'helper ACK is not injection proof (see release)');
    }
    if (physicalDownNotApplicable) {
      // Explicit non-fabrication: the delivered key event never asserted the
      // physical key in the OS session, so this case has no physical held to stop.
      fail(`${caseName}: NOT_APPLICABLE_WITH_CONTRACT; the delivered KeyZ used the unicode `
        + `carrier keycode (no physical key6 assertion, os signals=${JSON.stringify(samplerObservation.signalKeys)}, `
        + `os lastState=${samplerObservation.lastState}); no physical held down was created`);
    }
    const reentrySession = await openStreamSession({
      binding,
      socket,
      target,
      streamId: requestId('stream-reentry'),
      trackFrames: true,
      submitAnswer: true,
    });
    openedSessions.push(reentrySession);
    try {
      await waitForReceiverTrack(binding, reentrySession.peerConnection, messages, reentrySession.streamId, reentrySession.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
      await waitForDecodedFrames(() => reentrySession.frames().framesDecoded, `${caseName}-reentry`, 20_000, 3);
      reentryObservation = {
        streamId: reentrySession.streamId,
        framesDecoded: reentrySession.frames().framesDecoded,
        frameErrors: reentrySession.frames().frameErrors,
      };
    } finally {
      try {
        reentrySession.close();
      } catch (error) {
        heldCleanupErrors.push(`reentry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Close every branch-created session before publishing success so a real
    // close failure can never be published as ok:true. The outer finally repeats
    // this idempotently as a safety net for assertion/error/timeout exits.
    for (const session of openedSessions) {
      try {
        session.close();
      } catch (error) {
        heldCleanupErrors.push(`session: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (heldCleanupErrors.length > 0) {
      throw new Error(`${caseName}: held input release cleanup failed: ${heldCleanupErrors.join('; ')}`);
    }
    const finalResult = { ...result, reentryObservation };
    writeCaseResult(outputDir, caseName, finalResult);
    wroteFullResult = true;
    writeCaseWire(outputDir, caseName, { daemonWsUrl: finalResult.daemonWsUrl, messages, wireLog });
    console.log(JSON.stringify(finalResult, null, 2));
  } catch (error) {
    // Failure still leaves a JSON result; original error is preserved and rethrown.
    if (!wroteFullResult) {
      writeCaseResult(outputDir, caseName, blockedResult ?? {
        ok: false,
        mode: caseName,
        daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
        controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
        targetId: target.streamTargetId,
        targetPid,
        streamId: heldStreamId,
        osStateSampler: samplerObservation,
        cleanupErrors: heldCleanupErrors,
        error: error instanceof Error ? error.message : String(error),
        probeLines: readProbeLines(probeLines),
      });
    }
    throw error;
  } finally {
    // Every branch-created real peer/sink/session is closed on success AND on the
    // assertion/error/timeout/cancellation paths; close failures are surfaced
    // through the case's own cleanup-error list instead of being swallowed.
    for (const session of openedSessions) {
      try {
        session.close();
      } catch (cleanupError) {
        heldCleanupErrors.push(`session: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
  }
}

async function runOwnedCloseFlow(options: {
  ws: WebSocket;
  messages: ServerMessage[];
  streamId: string;
  target: RemoteWindowStreamTargetManifest;
  targetPid: number;
  probeLines: string[];
  getFrameCount: () => number;
  outputDir: string | null;
}) {
  const { ws, messages, streamId, target, targetPid, probeLines, getFrameCount, outputDir } = options;
  const closeRequestId = requestId('close-request');
  const closeSessionId = PROBE_MUX_SESSION;
  const closeRequest: RemoteWindowCloseRequestPayload = {
    requestId: closeRequestId,
    sessionId: closeSessionId,
    streamId,
    targetId: target.streamTargetId,
  };
  try {
    await waitForDecodedFrames(getFrameCount, 'owned-close');
    const startIndex = messages.length;
    send(ws, { type: 'remote-window-close-request', payload: closeRequest });
    const closeResult = await waitForServerMessage(
      messages,
      (message) => (
        message.type === 'remote-window-close-result'
        && message.payload.requestId === closeRequest.requestId
      ),
      `remote window close result ${closeRequest.requestId}`,
      REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
    );
    if (closeResult.type !== 'remote-window-close-result') {
      fail(`owned-close: unexpected close response ${JSON.stringify(closeResult)}`);
    }
    const resultPayload: RemoteWindowCloseResultPayload = closeResult.payload;
    const identityMatches = resultPayload.requestId === closeRequest.requestId
      && resultPayload.sessionId === closeRequest.sessionId
      && resultPayload.streamId === closeRequest.streamId
      && resultPayload.targetId === closeRequest.targetId;
    const observed = await waitForOwnedCloseObservation(targetPid, probeLines, PROBE_CLOSE_OBSERVE_MS);
    const result = {
      ok: identityMatches && resultPayload.status === 'closed',
      mode: 'owned-close',
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetId: target.streamTargetId,
      targetPid,
      streamId,
      closeRequest,
      closeResult: resultPayload,
      closeRequestCorrelated: identityMatches,
      closeResultStatusIsClosed: resultPayload.status === 'closed',
      closeResultIsCloseObservation: resultPayload.status === 'closed',
      closeSignalError: resultPayload.error ?? null,
      observed,
      postCloseMessages: messages.slice(startIndex).map(summarizeStreamMessage),
      saveSheetProbe: {
        supported: false,
        note: 'probe fixture has no document save-sheet; save-sheet sub-case is locally unverified (not faked)',
      },
      probeLines: readProbeLines(probeLines),
    };
    writeCaseResult(outputDir, 'owned-close', result);
    writeCaseWire(outputDir, 'owned-close', { daemonWsUrl: result.daemonWsUrl, messages, wireLog });
    console.log(JSON.stringify(result, null, 2));
    if (!identityMatches) {
      fail(`owned-close: close result identity mismatch request=${JSON.stringify(closeRequest)} result=${JSON.stringify(resultPayload)}`);
    }
    if (resultPayload.status !== 'closed') {
      fail(`owned-close: typed close status is not closed: ${JSON.stringify(resultPayload)}; observed=${JSON.stringify(observed)}`);
    }
    if (!observed.osClosed) {
      fail(`owned-close: typed protocol reported closed but the owned fixture/canonical observer did not observe closure: ${JSON.stringify(observed)}`);
    }
  } catch (error) {
    writeCaseResult(outputDir, 'owned-close', {
      ok: false,
      mode: 'owned-close',
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetId: target.streamTargetId,
      targetPid,
      streamId,
      error: error instanceof Error ? error.message : String(error),
      probeLines: readProbeLines(probeLines),
    });
    throw error;
  }
}

async function runLifecycleBranch(
  options: ProbeOptions,
  binding: WrtcBinding,
  socket: ProbeSocket,
  target: RemoteWindowStreamTargetManifest,
  targetPid: number,
  probeLines: string[],
) {
  const { case: caseName } = options;
  const { ws, messages } = socket;
  if (caseName === 'owned-close') {
    return { kind: 'owned-close' as const };
  }
  if (caseName === 'disconnect-held') {
    if (!PROBE_OS_SAMPLER_BINARY) fail('disconnect-held requires ZTERM_REMOTE_WINDOW_PROBE_OS_SAMPLER for key0 release evidence');
    const disconnectSampler = startOsSampler(PROBE_OS_SAMPLER_BINARY, Math.ceil((PROBE_RELEASE_OBSERVE_MS * 3 + 60_000) / 1000));
    const cleanupErrors: string[] = [];
    const caseFields: Record<string, unknown> = {
      mode: caseName,
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetId: target.streamTargetId,
      targetPid,
    };
    let stream: StreamSession | null = null;
    let freshSocket: ProbeSocket | null = null;
    let fresh: StreamSession | null = null;
    let failure: unknown = null;
    let okResult: unknown = null;
    try {
      const streamId = requestId('stream-disconnect-held');
      caseFields.streamId = streamId;
      stream = await openStreamSession({ binding, socket, target, streamId, trackFrames: true, submitAnswer: true });
      await waitForReceiverTrack(binding, stream.peerConnection, messages, streamId, stream.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
      await waitForDecodedFrames(() => stream!.frames().framesDecoded, 'disconnect-held');
      const down = await sendInputAndObserveAck(ws, messages, buildInputPayload(streamId, target, 'disconnect-held-down', keyDownEvent()));
      if (!down || down.type !== 'remote-window-input-ack' || down.control.accepted !== true) {
        fail(`disconnect-held: down rejected before disconnect: ${JSON.stringify(down)}`);
      }
      caseFields.down = describeInputAck(down);
      await waitForProbeLine(probeLines, 'PROBE_KEY_DOWN');
      // held-before is bound to the WebSocket close action: wait until the owned
      // sampler reports the physical key held, capture the sample index at the
      // close boundary, then close the socket. released-after is the physical
      // state observed after that same boundary.
      await waitForOsSamplerState(disconnectSampler, caseName, 1, 'disconnect-held held-before-close');
      const closeBoundarySampleIndex = parseOsSamplerLines(disconnectSampler.lines).length;
      caseFields.closeBoundarySampleIndex = closeBoundarySampleIndex;
      socket.ws.terminate();
      caseFields.socketClosed = socket.closed;
      freshSocket = await openProbeSocket();
      fresh = await openStreamSession({
        binding,
        socket: freshSocket,
        target,
        streamId: requestId('stream-disconnect-reentry'),
        trackFrames: true,
        submitAnswer: true,
      });
      await waitForReceiverTrack(binding, fresh.peerConnection, freshSocket.messages, fresh.streamId, fresh.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
      await waitForDecodedFrames(() => fresh!.frames().framesDecoded, 'disconnect-held-reentry', 20_000, 3);
      caseFields.reentryStreamId = fresh.streamId;
      caseFields.reentryFrames = fresh.frames().framesDecoded;
      await waitForOsSamplerState(disconnectSampler, caseName, 0, 'disconnect-held released-after-close');
      const closeWindow = summarizeOsSamplerWindow(disconnectSampler, caseName, closeBoundarySampleIndex);
      caseFields.osCloseWindow = closeWindow;
      caseFields.osSampler = summarizeCurrentOsSampler(disconnectSampler, caseName);
      if (closeWindow.startState !== 1) {
        fail(`disconnect-held: physical key0 was not held at the WebSocket close boundary: ${JSON.stringify(closeWindow)}`);
      }
      if (closeWindow.endState !== 0) {
        fail(`disconnect-held: physical key0 was not released after the WebSocket close: ${JSON.stringify(closeWindow)}`);
      }
      okResult = { ok: true, ...caseFields };
    } catch (error) {
      failure = error;
    } finally {
      if (fresh) {
        try { fresh.close(); } catch (error) { cleanupErrors.push(`fresh: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (freshSocket) {
        try { closeProbeSocket(freshSocket); } catch (error) { cleanupErrors.push(`freshSocket: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (stream) {
        try { stream.close(); } catch (error) { cleanupErrors.push(`stream: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await disconnectSampler.terminator();
    }
    caseFields.probeLines = readProbeLines(probeLines);
    settleCaseOutcome({
      outputDir: options.outputDir,
      caseName,
      okResult,
      failure,
      cleanupErrors,
      failureBase: caseFields,
      okWire: { daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL), messages, wireLog },
    });
    return { kind: 'disconnect-held' as const };
  }
  if (caseName === 'shared-holders') {
    if (!PROBE_OS_SAMPLER_BINARY) fail('shared-holders requires ZTERM_REMOTE_WINDOW_PROBE_OS_SAMPLER for key0 held/release evidence');
    const sharedSampler = startOsSampler(PROBE_OS_SAMPLER_BINARY, Math.ceil((PROBE_RELEASE_OBSERVE_MS * 3 + 60_000) / 1000));
    const cleanupErrors: string[] = [];
    const caseFields: Record<string, unknown> = {
      mode: caseName,
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetId: target.streamTargetId,
      targetPid,
    };
    let streamA: StreamSession | null = null;
    let streamB: StreamSession | null = null;
    let failure: unknown = null;
    let okResult: unknown = null;
    try {
      // Real baseline -> held -> release causal chain. The baseline index is
      // captured only after the sampler observed a clear physical key0, so a
      // pre-existing held key can never be promoted to "this case held it".
      await waitForOsSamplerState(sharedSampler, caseName, 0, 'shared-holders baseline');
      const baselineSampleIndex = parseOsSamplerLines(sharedSampler.lines).length;
      caseFields.baselineSampleIndex = baselineSampleIndex;
      streamA = await openStreamSession({ binding, socket, target, streamId: requestId('stream-shared-a'), trackFrames: true, submitAnswer: true });
      await waitForReceiverTrack(binding, streamA.peerConnection, messages, streamA.streamId, streamA.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
      await waitForDecodedFrames(() => streamA!.frames().framesDecoded, 'shared-holders-A');
      const downA = await sendInputAndObserveAck(ws, messages, buildInputPayload(streamA.streamId, target, 'shared-a-down', keyDownEvent()));
      if (!downA || downA.type !== 'remote-window-input-ack' || downA.control.accepted !== true) {
        fail(`shared-holders: A down rejected: ${JSON.stringify(downA)}`);
      }
      caseFields.downA = describeInputAck(downA);
      await waitForProbeLineCount(probeLines, 'PROBE_KEY_DOWN', 1);
      await waitForOsSamplerState(sharedSampler, caseName, 1, 'shared-holders held-after-A');
      streamB = await openStreamSession({ binding, socket, target, streamId: requestId('stream-shared-b'), trackFrames: true, submitAnswer: true });
      await waitForReceiverTrack(binding, streamB.peerConnection, messages, streamB.streamId, streamB.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
      await waitForDecodedFrames(() => streamB!.frames().framesDecoded, 'shared-holders-B');
      const downB = await sendInputAndObserveAck(ws, messages, buildInputPayload(streamB.streamId, target, 'shared-b-down', keyDownEvent()));
      if (!downB || downB.type !== 'remote-window-input-ack' || downB.control.accepted !== true) {
        fail(`shared-holders: B down rejected: ${JSON.stringify(downB)}`);
      }
      caseFields.downB = describeInputAck(downB);
      await waitForProbeLineCount(probeLines, 'PROBE_KEY_DOWN', 2);
      await waitForOsSamplerState(sharedSampler, caseName, 1, 'shared-holders held-after-B');
      // Baseline -> held window: the carried state at the baseline index is clear
      // and the latest physical state after both holders is held.
      const heldWindow = summarizeOsSamplerWindow(sharedSampler, caseName, baselineSampleIndex);
      // stopA: the window from the stopA boundary must stay held throughout, so a
      // stopA that wrongly released the shared key0 while holder B is still active
      // fails even though the cumulative ever-held flag would still be true.
      const beforeStopASampleIndex = parseOsSamplerLines(sharedSampler.lines).length;
      const stopA = await requestStopAndObserve(ws, messages, streamA.streamId, 'shared-a-stop');
      assertTypedCleanStop(stopA, requestId('shared-a-stop'), streamA.streamId, 'shared-holders stopA');
      await delay(PROBE_RELEASE_OBSERVE_MS);
      const afterStopAWindow = summarizeOsSamplerWindow(sharedSampler, caseName, beforeStopASampleIndex);
      // stopB: the window must carry held in and transition to released after.
      const beforeStopBSampleIndex = parseOsSamplerLines(sharedSampler.lines).length;
      const stopB = await requestStopAndObserve(ws, messages, streamB.streamId, 'shared-b-stop');
      assertTypedCleanStop(stopB, requestId('shared-b-stop'), streamB.streamId, 'shared-holders stopB');
      await waitForOsSamplerState(sharedSampler, caseName, 0, 'shared-holders released-after-B');
      const afterStopBWindow = summarizeOsSamplerWindow(sharedSampler, caseName, beforeStopBSampleIndex);
      caseFields.streamA = streamA.streamId;
      caseFields.streamB = streamB.streamId;
      caseFields.heldWindow = heldWindow;
      caseFields.stopA = describeStopResult(stopA);
      caseFields.afterStopAWindow = afterStopAWindow;
      caseFields.stopB = describeStopResult(stopB);
      caseFields.afterStopBWindow = afterStopBWindow;
      caseFields.osSampler = summarizeCurrentOsSampler(sharedSampler, caseName);
      if (heldWindow.startState !== 0 || heldWindow.endState !== 1) {
        fail(`shared-holders: real baseline->held causal evidence missing after both holders: ${JSON.stringify(heldWindow)}`);
      }
      if (!afterStopAWindow.heldThroughout) {
        fail(`shared-holders: stopA released the shared key0 while holder B was still active: ${JSON.stringify(afterStopAWindow)}`);
      }
      if (afterStopBWindow.startState !== 1 || afterStopBWindow.endState !== 0) {
        fail(`shared-holders: stopB did not transition the shared key0 from held to released: ${JSON.stringify(afterStopBWindow)}`);
      }
      okResult = { ok: true, ...caseFields };
    } catch (error) {
      failure = error;
    } finally {
      if (streamA) {
        try { streamA.close(); } catch (error) { cleanupErrors.push(`streamA: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (streamB) {
        try { streamB.close(); } catch (error) { cleanupErrors.push(`streamB: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await sharedSampler.terminator();
    }
    caseFields.probeLines = readProbeLines(probeLines);
    settleCaseOutcome({
      outputDir: options.outputDir,
      caseName,
      okResult,
      failure,
      cleanupErrors,
      failureBase: caseFields,
      okWire: { daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL), messages, wireLog },
    });
    return { kind: 'shared-holders' as const };
  }
  return { kind: 'none' as const };
}

function writeCaseWire(outputDir: string | null, caseName: ProbeCase, wire: unknown) {
  if (!outputDir) {
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${caseName}.wire.json`), `${JSON.stringify(wire, null, 2)}\n`);
}

// A case outcome is published only once all assertions and the case's own
// cleanup have passed. Failure writes ok:false with the original error and any
// cleanup errors; a leftover ok:true JSON from an earlier write must never
// survive a failed run, so the success JSON is never written before the case
// finishes.
function settleCaseOutcome(options: {
  outputDir: string | null;
  caseName: ProbeCase;
  okResult: unknown;
  failure: unknown;
  cleanupErrors: string[];
  failureBase: Record<string, unknown>;
  okWire: { daemonWsUrl: string; messages: ServerMessage[]; wireLog: unknown };
}): void {
  if (options.failure) {
    const errorMessage = options.failure instanceof Error ? options.failure.message : String(options.failure);
    writeCaseResult(options.outputDir, options.caseName, {
      ...options.failureBase,
      ok: false,
      error: errorMessage,
      cleanupErrors: options.cleanupErrors,
    });
    writeCaseWire(options.outputDir, options.caseName, options.okWire);
    if (options.cleanupErrors.length > 0) {
      throw new Error(`${errorMessage}; own cleanup errors=${JSON.stringify(options.cleanupErrors)}`);
    }
    throw options.failure;
  }
  if (options.cleanupErrors.length > 0) {
    writeCaseResult(options.outputDir, options.caseName, {
      ...options.failureBase,
      ok: false,
      error: `own cleanup failed: ${options.cleanupErrors.join('; ')}`,
      cleanupErrors: options.cleanupErrors,
    });
    writeCaseWire(options.outputDir, options.caseName, options.okWire);
    fail(`${options.caseName}: own cleanup failed: ${options.cleanupErrors.join('; ')}`);
  }
  if (options.okResult === null) {
    throw new Error(`${options.caseName}: case produced no ok result`);
  }
  writeCaseResult(options.outputDir, options.caseName, options.okResult);
  writeCaseWire(options.outputDir, options.caseName, options.okWire);
  console.log(JSON.stringify(options.okResult, null, 2));
}

async function main(options: ProbeOptions) {
  const caseName = options.case;
  const lifecycleCase = caseName !== 'default';
  const binding = WRTC_BINDING;
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

  // Real handles released on every exit path (success, assertion failure, or an
  // unexpected error). The old `process.exit(0/1)` tail masked leaks; with the
  // natural-exit tail the event loop must actually drain, so the websocket, peer
  // connection and video sink are closed here before natural environment teardown.
  let activeWs: WebSocket | null = null;
  let activePeerConnection: RTCPeerConnection | null = null;
  let videoSink: RtcVideoSinkLike | null = null;
  const stopVideoSink = () => {
    if (!videoSink) {
      return;
    }
    videoSink.onframe = null;
    videoSink.stop();
    videoSink = null;
  };

  const cleanup = async () => {
    stopVideoSink();
    if (activePeerConnection) {
      try {
        activePeerConnection.close();
      } catch {
        // already closed by the case body
      }
      activePeerConnection = null;
    }
    if (activeWs) {
      try {
        activeWs.close();
      } catch {
        // already closing
      }
      try {
        activeWs.terminate();
      } catch {
        // socket already gone
      }
      activeWs = null;
    }
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
    if (probePid === null || !Number.isFinite(probePid)) {
      fail(`probe app pid is unknown; ready=${readyLine}`);
    }
    const ws = new WebSocket(DAEMON_WS_URL);
    activeWs = ws;
    const messages: ServerMessage[] = [];
    const rawFrames: any[] = [];
    const socket: ProbeSocket = {
      ws,
      messages,
      rawFrames,
      closed: { called: false, code: null, reason: '' },
    };
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'));
      wireLog.push({ direction: 'in', message: parsed });
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
    ws.on('close', (code, reason) => {
      socket.closed = { called: true, code, reason: reason?.toString('utf8') || '' };
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

    // Read the daemon-owned catalog snapshot until the freshly launched owned
    // fixture appears (bounded), then use that exact snapshot's target identity.
    const { target } = await resolveOwnedProbeTarget(
      ws,
      messages,
      PROBE_TITLE,
      probePid,
    );
    const targetBundleId = target.videoTarget.appBundleId || probeBundleId;
    if (!targetBundleId) {
      fail(`probe target missing bundle id: ${target.streamTargetId}`);
    }
    const targetPid = target.videoTarget.pid;
    if (!Number.isFinite(targetPid) || targetPid !== probePid) {
      fail(`probe target pid mismatch: target=${targetPid} ready=${probePid} targetId=${target.streamTargetId}`);
    }

    const peerConnection = new binding.RTCPeerConnection({ iceServers: [] });
    activePeerConnection = peerConnection;
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    let trackSeen = false;
    let focusedTrack: MediaStreamTrack | null = null;
    let framesDecoded = 0;
    peerConnection.ontrack = (event) => {
      trackSeen = true;
      const primaryTrack = event.track ?? event.streams?.[0]?.getTracks()[0] ?? null;
      if (!primaryTrack || focusedTrack) {
        return;
      }
      focusedTrack = primaryTrack;
      // RealSink gate: a decoded frame callback is the only field evidence of a
      // real RTCVideoSink frame. `ontrack`/status/framesSent are NOT frames and
      // must never be promoted into a full-frame PASS.
      if (!lifecycleCase) {
        return;
      }
      try {
        videoSink = new binding.nonstandard.RTCVideoSink(primaryTrack);
        videoSink.onframe = () => {
          framesDecoded += 1;
        };
      } catch (error) {
        videoSink = null;
        console.error(`S0 ${caseName}: RTCVideoSink unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const streamId = requestId('stream');
    // S0 harness: defer submitting the answer so pending-answer-stop can stop first.
    const answerGate: { release: () => void } = { release: () => undefined };
    const answerSubmitted = new Promise<void>((resolve) => {
      answerGate.release = resolve;
    });
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
      requestId: requestId('start'),
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

    send(ws, {
      type: 'remote-window-stream-start-v2-request',
      payload: {
        requestId: requestId('start'),
        streamId,
        mediaPlan: 'single-focus',
        mediaPlanVersion: 2,
        target,
        videoProfile: buildRemoteWindowVideoProfile('smooth'),
      },
    });
    const started = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-stream-offer-v2' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === requestId('start')
      ),
      'remote window stream start',
      REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS,
    );
    if (started.type !== 'remote-window-stream-offer-v2') {
      fail(`stream start failed: ${JSON.stringify(started)}`);
    }
    await peerConnection.setRemoteDescription(new binding.RTCSessionDescription(started.payload.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const submitAnswer = () => {
      send(ws, {
        type: 'remote-window-stream-answer-v2',
        payload: {
          requestId: started.payload.requestId,
          streamId: started.payload.streamId,
          mediaPlanVersion: 2,
          answer: {
            type: 'answer',
            sdp: peerConnection.localDescription?.sdp || answer.sdp || '',
          },
        },
      });
    };
    if (caseName === 'pending-answer-stop') {
      // Defer the real answer until after the stop so the stop path is observed
      // with a live pending offer. The raw offer-v2 is captured further below.
      answerGate.release();
    } else {
      submitAnswer();
      answerGate.release();
    }
    await answerSubmitted;
    if (caseName === 'pending-answer-stop') {
      const stopped = await requestStopAndObserve(ws, messages, streamId, 'stop-pending');
      const answerAttempt = await sendAnswerAndObserve(ws, messages, started.payload.requestId, streamId, peerConnection);
      // Late-media observation window: a torn-down stream must not begin
      // delivering decoded frames after the rejected answer.
      await delay(PROBE_RELEASE_OBSERVE_MS);
      const noLateMedia = framesDecoded === 0;
      let reentryObservation: {
        streamId: string;
        framesDecoded: number;
        frameErrors: string[];
      } | null = null;
      const cleanupErrors: string[] = [];
      let failure: unknown = null;
      let okResult: unknown = null;
      const caseFields: Record<string, unknown> = {
        mode: caseName,
        observeWindowMs: PROBE_RELEASE_OBSERVE_MS,
        daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
        controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
        targetId: target.streamTargetId,
        targetPid,
        streamId,
        startRequestId: started.payload.requestId,
        offer: {
          mediaPlan: started.payload.mediaPlan,
          mediaPlanVersion: started.payload.mediaPlanVersion,
          targetId: started.payload.targetId,
          sdpChars: started.payload.offer.sdp.length,
          sdpCandidateCount: (started.payload.offer.sdp.match(/^a=candidate:/gm) || []).length,
          transport: started.payload.transport,
          capture: started.payload.capture,
        },
        stopBeforeAnswer: describeStopResult(stopped),
        answerAttempt,
        trackSeen,
        framesDecoded,
        noLateMedia,
      };
      try {
        if (noLateMedia) {
          const reentrySession = await openStreamSession({
            binding,
            socket,
            target,
            streamId: requestId('stream-pending-reentry'),
            trackFrames: true,
            submitAnswer: true,
          });
          try {
            await waitForReceiverTrack(binding, reentrySession.peerConnection, messages, reentrySession.streamId, reentrySession.trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
            await waitForDecodedFrames(() => reentrySession.frames().framesDecoded, 'pending-answer-stop-reentry', 20_000, 3);
          } finally {
            reentryObservation = {
              streamId: reentrySession.streamId,
              framesDecoded: reentrySession.frames().framesDecoded,
              frameErrors: reentrySession.frames().frameErrors,
            };
            caseFields.reentryObservation = reentryObservation;
            try {
              reentrySession.close();
            } catch (error) {
              cleanupErrors.push(`reentry: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        if (!noLateMedia) {
          fail(`pending-answer-stop: a late decoded frame arrived after stop; framesDecoded=${framesDecoded}`);
        }
        // The late-answer settlement must be the typed cancellation correlated to
        // the ORIGINAL pending start request and stream, not merely any other
        // request that happened to reuse the same cancellation code.
        if (
          answerAttempt.verdict?.type !== 'remote-window-error'
          || answerAttempt.verdict.code !== 'remote_window_stream_answer_cancelled'
          || answerAttempt.verdict.requestId !== started.payload.requestId
          || answerAttempt.verdict.streamId !== streamId
        ) {
          fail(`pending-answer-stop: expected typed remote_window_stream_answer_cancelled correlated to requestId=${started.payload.requestId} streamId=${streamId}: ${JSON.stringify(answerAttempt)}`);
        }
        okResult = { ok: true, ...caseFields };
      } catch (error) {
        failure = error;
      } finally {
        try {
          stopVideoSink();
        } catch (error) {
          cleanupErrors.push(`videoSink: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          peerConnection.close();
        } catch (error) {
          cleanupErrors.push(`peerConnection: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          ws.close();
        } catch (error) {
          cleanupErrors.push(`ws: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      caseFields.probeLines = readProbeLines(probeLines);
      settleCaseOutcome({
        outputDir: options.outputDir,
        caseName,
        okResult,
        failure,
        cleanupErrors,
        failureBase: caseFields,
        okWire: { daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL), messages, wireLog },
      });
      return;
    }
    await waitForReceiverTrack(binding, peerConnection, messages, streamId, () => trackSeen, REMOTE_WINDOW_LIVE_STREAM_TIMEOUT_MS);
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

    if (caseName === 'held-pointer-stop' || caseName === 'held-key-stop') {
      await runHeldStopFlow({
        caseName,
        binding,
        socket,
        target,
        targetPid,
        probeLines,
        outputDir: options.outputDir,
      });
      stopVideoSink();
      peerConnection.close();
      ws.close();
      return;
    }
    if (caseName === 'owned-close') {
      await runOwnedCloseFlow({
        ws,
        messages,
        streamId,
        target,
        targetPid,
        probeLines,
        getFrameCount: () => framesDecoded,
        outputDir: options.outputDir,
      });
      stopVideoSink();
      peerConnection.close();
      ws.close();
      return;
    }
    if (caseName === 'disconnect-held' || caseName === 'shared-holders') {
      await runLifecycleBranch(options, binding, socket, target, targetPid, probeLines);
      return;
    }

    let degradedQuality: ServerMessage | null = null;
    let restoredQuality: ServerMessage | null = null;
    if (!lifecycleCase) {
    const degradedQualityRequestId = requestId('quality-degraded');
    send(ws, {
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: degradedQualityRequestId,
        streamId,
        streamGroupId: streamId,
        mediaPlan: 'single-focus',
        mediaPlanVersion: 2 as const,
        revision: 1,
        targetId: target.streamTargetId,
        videoProfile: buildRemoteWindowVideoProfile('smooth', {
          cause: 'network',
          level: 2,
        }),
      },
    });
    degradedQuality = await waitForServerMessage(
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
        mediaPlanVersion: 2 as const,
        revision: 2,
        targetId: target.streamTargetId,
        videoProfile: buildRemoteWindowVideoProfile('smooth'),
      },
    });
    restoredQuality = await waitForServerMessage(
      messages,
      (message) => (
        (message.type === 'remote-window-stream-quality-result' || message.type === 'remote-window-error')
        && 'requestId' in message.payload
        && message.payload.requestId === restoredQualityRequestId
      ),
      'remote window restored quality update',
    );
    assertQualityUpdateContract(restoredQuality, 'restored');
    }

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
      payloads.forEach((input) => send(ws, { type: 'remote-window-input', control: input.control, payload: input.payload }));
      await Promise.all(payloads.map((input) => (
        input.control.lane === 'continuous'
          ? Promise.resolve(input.payload)
          : waitForInputAccepted(messages, input)
      )));
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
    if (!degradedQuality || !restoredQuality) {
      fail('default case finished without both quality update results');
    }
    peerConnection.close();
    ws.close();

    console.log(JSON.stringify({
      ok: true,
      daemonWsUrl: redactDaemonWebSocketUrl(DAEMON_WS_URL),
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
        summarizeQualityUpdate(degradedQuality!),
        summarizeQualityUpdate(restoredQuality!),
      ],
      trackSeen,
      stopped: stopped.payload,
      probeLines: readProbeLines(probeLines),
    }, null, 2));
  } finally {
    await cleanup();
  }
}

// Natural exit: no `process.exit`, so leaked refs/timers/sockets/peers would keep
// the process alive or surface as a nonzero rc. KEEP_TEMP is honoured here without
// faking success.
main(probeOptions).then(() => {
  if (KEEP_TEMP) {
    console.error(`keeping remote-window live probe temp root: ${tempRoot}`);
  }
  process.exitCode = 0;
}).catch((error) => {
  if (!KEEP_TEMP) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`keeping remote-window live probe temp root: ${tempRoot}`);
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

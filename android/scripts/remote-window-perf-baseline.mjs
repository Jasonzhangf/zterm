#!/usr/bin/env node
/**
 * Remote-window latency/clarity baseline harness (§3.1 of the remote perf task).
 *
 * Owner/scope: read-only measurement. It drives the REAL Android user entry
 * (installed app -> remote-window entry -> target picker) over CDP on the app's
 * own WebView, records the daemon's published latency telemetry from the
 * authenticated channel, and writes one baseline table.
 *
 * The wire hook is installed with `Page.addScriptToEvaluateOnNewDocument` so it
 * precedes the app bundle, then the page is reloaded. That is the only way to
 * observe sockets the app opens during boot.
 *
 * It never writes product state, never changes daemon configuration and never
 * claims glass-to-glass latency: every value is a labelled proxy segment.
 *
 * Usage:
 *   node scripts/remote-window-perf-baseline.mjs --serial <serial> \
 *     [--cdp-port 9224] [--seconds 30] [--out <dir>] [--target-index 0]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

// Wall-clock proxy segments are only comparable when the host is not
// saturated, so every baseline records the conditions it was taken under.
function sampleHostConditions() {
  const read = (command, args) => {
    try {
      return execFileSync(command, args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const loadRaw = read('sysctl', ['-n', 'vm.loadavg']);
  const swapRaw = read('sysctl', ['-n', 'vm.swapusage']);
  const swapUsed = swapRaw ? /used = ([\d.]+)M/.exec(swapRaw) : null;
  const swapTotal = swapRaw ? /total = ([\d.]+)M/.exec(swapRaw) : null;
  return {
    sampledAt: new Date().toISOString(),
    loadAverage: loadRaw
      ? loadRaw.replace(/[{}]/g, '').trim().split(/\s+/).map((value) => Number(value))
      : null,
    cpuCount: Number(read('sysctl', ['-n', 'hw.ncpu'])) || null,
    swapUsedMb: swapUsed ? Number(swapUsed[1]) : null,
    swapTotalMb: swapTotal ? Number(swapTotal[1]) : null,
    daemonRssMb: null,
    daemonUptimeSec: null,
    daemonSessions: null,
    daemonMirrors: null,
  };
}

async function sampleHostAndDaemonConditions() {
  const conditions = sampleHostConditions();
  try {
    const health = await fetch('http://127.0.0.1:3333/health').then((response) => response.json());
    conditions.daemonRssMb = typeof health?.memory?.rss === 'number'
      ? Math.round(health.memory.rss / 1048576)
      : null;
    conditions.daemonUptimeSec = health?.uptimeSec ?? null;
    conditions.daemonSessions = health?.sessions ?? null;
    conditions.daemonMirrors = health?.mirrors ?? null;
  } catch {
    conditions.daemonRssMb = null;
  }
  return conditions;
}

const APP_ID = 'com.zterm.android';
const DEFAULT_SECONDS = 30;

function parseArgs(argv) {
  const args = { seconds: DEFAULT_SECONDS, cdpPort: 9223, targetIndex: 0, targetMatch: null, zoomProbe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--serial') args.serial = argv[++index];
    else if (token === '--seconds') args.seconds = Number(argv[++index]);
    else if (token === '--cdp-port') args.cdpPort = Number(argv[++index]);
    else if (token === '--out') args.out = argv[++index];
    else if (token === '--target-index') args.targetIndex = Number(argv[++index]);
    // The catalog order is not stable across runs, so a caller that needs one
    // exact window must select it by text; an index alone silently binds a
    // different window and would mislabel the evidence.
    else if (token === '--target-match') args.targetMatch = argv[++index];
    // B-2 evidence: drive real touch pinches and read the daemon's reported
    // capture size at 1x, >=2x and back at 1x.
    else if (token === '--zoom-probe') args.zoomProbe = true;
    // C-track acceptance: type text through the app's own remote-window keyboard
    // and submit it, so the injected characters can be checked for a real effect
    // in the remote window (the caller supplies a sentinel command).
    else if (token === '--keyboard-text') args.keyboardText = argv[++index];
    // C-track acceptance: the remote window switcher can name the exact window
    // (appPid:windowId) the keyboard sends into after the app is bound.
    else if (token === '--window-id') args.windowId = argv[++index];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function adb(serial, args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The phone's own framebuffer is the only black-box clarity truth: it shows the
 * decoded, scaled video exactly as the user sees it. A capture failure is
 * reported as a missing screenshot, never as a fabricated sample.
 */
function capturePhoneScreenshot(serial, outDir) {
  try {
    const png = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!png || png.length < 1024) return false;
    writeFileSync(join(outDir, 'phone-stream.png'), png);
    return true;
  } catch {
    return false;
  }
}

function resolveSerial(explicit) {
  if (explicit) return explicit;
  const lines = execFileSync('adb', ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('device'));
  if (lines.length === 0) throw new Error('no online adb device; pass --serial');
  return lines[0].split(/\s+/)[0];
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl, { perMessageDeflate: false });
  const pending = new Map();
  let nextId = 1;
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  return {
    ready,
    close: () => socket.close(),
    async call(method, params = {}) {
      await ready;
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.result?.exceptionDetails) {
        const details = result.result.exceptionDetails;
        throw new Error(`CDP evaluate failed: ${details.exception?.description || details.text}`);
      }
      return result.result?.result?.value;
    },
  };
}

/**
 * Document-start hook. The traversal transport can ride either a WebSocket
 * (target mux lane) or an RTCDataChannel (session channel lane), so both
 * prototypes are wrapped. It only observes; it never changes payloads.
 */
const HOOK_SOURCE = `(() => {
  if (window.__rwPerf) { return; }
  const state = { out: [], in: [], presented: [], types: {}, lastStreamId: null, installedAt: performance.now() };
  window.__rwPerf = state;
  const unwrap = (parsed) => {
    if (!parsed || typeof parsed !== 'object') { return null; }
    if (parsed.type === 'mux-channel-message' && parsed.payload && typeof parsed.payload === 'object') {
      return parsed.payload.message || null;
    }
    return parsed;
  };
  const decode = (raw) => {
    try {
      if (typeof raw === 'string') { return JSON.parse(raw); }
      if (raw instanceof ArrayBuffer) { return JSON.parse(new TextDecoder().decode(new Uint8Array(raw))); }
      if (raw && raw.buffer instanceof ArrayBuffer) { return JSON.parse(new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength))); }
    } catch (error) { return null; }
    return null;
  };
  const record = (direction, raw, transport) => {
    const parsed = decode(raw);
    if (!parsed || typeof parsed !== 'object') { return; }
    const inner = unwrap(parsed);
    const type = String(parsed.type || '');
    state.types[transport + ':' + direction + ':' + type] = (state.types[transport + ':' + direction + ':' + type] || 0) + 1;
    if (!type.startsWith('mux-channel') && !type.startsWith('remote-window')) { return; }
    const entry = {
      t: performance.now(),
      transport,
      envelope: type,
      type: inner && typeof inner.type === 'string' ? inner.type : null,
      message: inner,
    };
    if (direction === 'out') { state.out.push(entry); } else { state.in.push(entry); }
    // The status owner publishes the daemon streamId; keep the latest so the
    // zoom phase can filter status messages to the current stream.
    if (entry.type === 'remote-window-stream-status' && inner?.payload?.streamId) {
      state.lastStreamId = inner.payload.streamId;
    }
    if (state.in.length > 4000) { state.in.splice(0, state.in.length - 4000); }
    if (state.out.length > 4000) { state.out.splice(0, state.out.length - 4000); }
  };
  const wrap = (proto, transport) => {
    if (!proto) { return; }
    const originalSend = proto.send;
    if (typeof originalSend === 'function') {
      proto.send = function (data) {
        try { record('out', data, transport); } catch (error) {}
        return originalSend.call(this, data);
      };
    }
    const originalAddEventListener = proto.addEventListener;
    if (typeof originalAddEventListener === 'function') {
      proto.addEventListener = function (type, listener, options) {
        if (type === 'message' && typeof listener === 'function') {
          const wrapped = function (event) {
            try { record('in', event.data, transport); } catch (error) {}
            return listener.call(this, event);
          };
          return originalAddEventListener.call(this, type, wrapped, options);
        }
        return originalAddEventListener.call(this, type, listener, options);
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (descriptor && descriptor.set) {
      Object.defineProperty(proto, 'onmessage', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value) {
          const wrapped = typeof value === 'function'
            ? function (event) {
              try { record('in', event.data, transport); } catch (error) {}
              return value.call(this, event);
            }
            : value;
          return descriptor.set.call(this, wrapped);
        },
      });
    }
  };
  wrap(window.WebSocket && window.WebSocket.prototype, 'ws');
  wrap(window.RTCDataChannel && window.RTCDataChannel.prototype, 'dc');
  const attachFrameHook = () => {
    const video = document.querySelector('video');
    if (!video || typeof video.requestVideoFrameCallback !== 'function') { return false; }
    if (video.__rwPerfHooked) { return true; }
    video.__rwPerfHooked = true;
    const step = (now, metadata) => {
      state.presented.push({ t: now, presentedFrames: metadata?.presentedFrames ?? null, presentationTime: metadata?.presentationTime ?? null, expectedDisplayTime: metadata?.expectedDisplayTime ?? null });
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
    return true;
  };
  state.attachFrameHook = attachFrameHook;
  attachFrameHook();
})()`;

/**
 * The Android session channel lane is owned by the native
 * AndroidConnectionService, so it never touches a page WebSocket. Capacitor
 * routes outgoing plugin calls through `Capacitor.nativePromise` and delivers
 * native events through `androidBridge.onmessage` / `Capacitor.fromNative`
 * (see android/native/android/app/src/main/assets/native-bridge.js). Wrapping
 * those three gives the client-side view of the channel lane without touching
 * product code.
 */
const CAPACITOR_HOOK_EXPRESSION = `(() => {
  const state = window.__rwPerf;
  if (!state) { return 'no-state'; }
  if (state.capacitorHooked) { return 'already'; }
  const cap = window.Capacitor;
  if (!cap) { return 'no-capacitor'; }
  const note = (direction, inner, envelope) => {
    if (!inner || typeof inner !== 'object' || typeof inner.type !== 'string') { return; }
    const type = inner.type;
    const key = 'cap:' + direction + ':' + type;
    state.types[key] = (state.types[key] || 0) + 1;
    if (!type.startsWith('remote-window') && !type.startsWith('mux-channel')) { return; }
    const entry = { t: performance.now(), transport: 'cap', envelope, type, message: inner };
    if (direction === 'out') { state.out.push(entry); } else { state.in.push(entry); }
  };
  let hooked = false;
  const originalNativePromise = typeof cap.nativePromise === 'function' ? cap.nativePromise.bind(cap) : null;
  if (originalNativePromise) {
    hooked = true;
    cap.nativePromise = (pluginName, methodName, options) => {
      try {
        if (pluginName === 'AndroidConnectionService' && options && typeof options === 'object') {
          note('out', options.message, String(methodName));
        }
      } catch (error) {}
      return originalNativePromise(pluginName, methodName, options);
    };
  }
  const absorbNativeResult = (result) => {
    try {
      if (!result || typeof result !== 'object') { return; }
      const data = result.data;
      if (!data || typeof data !== 'object') { return; }
      note('in', data.message || data.payload, String(result.pluginId || '') + ':' + String(result.methodName || ''));
    } catch (error) {}
  };
  if (typeof cap.fromNative === 'function') {
    hooked = true;
    const originalFromNative = cap.fromNative.bind(cap);
    cap.fromNative = (result) => {
      absorbNativeResult(result);
      return originalFromNative(result);
    };
  }
  const bridge = window.androidBridge;
  if (bridge && typeof bridge.onmessage === 'function') {
    hooked = true;
    const originalOnMessage = bridge.onmessage;
    bridge.onmessage = (event) => {
      try { absorbNativeResult(JSON.parse(event.data)); } catch (error) {}
      return originalOnMessage.call(bridge, event);
    };
  }
  if (!hooked) { return 'no-bridge-functions'; }
  state.capacitorHooked = true;
  return 'hooked';
})()`;

const SAMPLE_EXPRESSION = `(() => {
  const video = document.querySelector('video');
  const quality = typeof video?.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
  return {
    sampledAt: performance.now(),
    streamId: video?.srcObject?.id ?? null,
    videoWidth: video?.videoWidth ?? 0,
    videoHeight: video?.videoHeight ?? 0,
    readyState: video?.readyState ?? 0,
    currentTime: video?.currentTime ?? 0,
    decodedFrames: video?.webkitDecodedFrameCount ?? null,
    totalVideoFrames: quality?.totalVideoFrames ?? null,
    droppedVideoFrames: quality?.droppedVideoFrames ?? null,
    presentedSamples: window.__rwPerf?.presented?.length ?? 0,
    // The video element rect is the only reliable way to crop the phone
    // screenshot down to the streamed pixels for a clarity measurement.
    videoRect: (() => {
      const rect = video?.getBoundingClientRect?.();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })(),
    devicePixelRatio: window.devicePixelRatio ?? 1,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

const READ_WIRE_EXPRESSION = `(() => {
  const state = window.__rwPerf;
  if (!state) { return null; }
  return {
    types: state.types,
    messages: state.in.filter((entry) => entry.type).map((entry) => ({ t: entry.t, type: entry.type, message: entry.message })),
    inputs: state.out.filter((entry) => entry.type === 'remote-window-input').map((entry) => ({ t: entry.t, sequence: entry.message?.control?.sequence ?? null, sentAtMs: entry.message?.control?.sentAtMs ?? null })),
    presented: state.presented.slice(-600),
  };
})()`;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return { samples: 0, p50: null, p95: null, min: null, max: null };
  return {
    samples: finite.length,
    p50: Number(percentile(finite, 0.5).toFixed(2)),
    p95: Number(percentile(finite, 0.95).toFixed(2)),
    min: Number(Math.min(...finite).toFixed(2)),
    max: Number(Math.max(...finite).toFixed(2)),
  };
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression);
    if (last) return last;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Zoom-aware capture (B-2) black-box phase.
 *
 * The harness dispatches REAL touch pointers on the video surface, so the
 * measurement path is the product's own gesture runtime and not a synthetic
 * quality request. For each step it reads:
 *  - the projection transform (zoom scale the user sees),
 *  - the client's applied video profile from the wire,
 *  - the daemon's reported capture width/height from status telemetry.
 *
 * The daemon capture size is the witness: the client's requested
 * `maxCaptureWidth` is only an intention until the capture source reports what
 * it produced.
 */
async function sampleZoomCapture(cdp, args) {
  const readState = () => cdp.evaluate(`(() => {
    const messages = (window.__rwPerf?.in || []).map((entry) => entry.message).filter(Boolean);
    // The latest status message defines the active stream; binding to any other
    // stream id would report a previous stream's capture size.
    const statuses = messages
      .filter((message) => message.type === 'remote-window-stream-status')
      .map((message) => message.payload)
      .filter(Boolean);
    const latestStatus = statuses.at(-1) || null;
    const latency = latestStatus?.latency || null;
    const quality = messages
      .filter((message) => message.type === 'remote-window-stream-quality-result')
      .map((message) => message.payload)
      .filter((payload) => payload && (!latestStatus || payload.streamId === latestStatus.streamId))
      .at(-1) || null;
    const surface = document.querySelector('[data-testid="remote-window-video-surface"]');
    const rect = surface?.getBoundingClientRect();
    const content = document.querySelector('[data-testid="remote-window-video-content"]');
    return {
      streamId: latestStatus?.streamId ?? null,
      captureWidth: latency?.captureWidth ?? null,
      captureHeight: latency?.captureHeight ?? null,
      qualityStatus: quality?.status ?? null,
      qualityError: quality?.error ? String(quality.error.code || 'unknown') + ': ' + String(quality.error.message || '').slice(0, 200) : null,
      qualityRevision: quality?.revision ?? null,
      appliedCaptureWidth: quality?.appliedVideoProfile?.maxCaptureWidth ?? null,
      appliedCaptureHeight: quality?.appliedVideoProfile?.maxCaptureHeight ?? null,
      appliedBitrateBps: quality?.appliedVideoProfile?.maxBitrateBps ?? null,
      requestedCaptureWidth: quality?.requestedVideoProfile?.maxCaptureWidth ?? null,
      requestedCaptureHeight: quality?.requestedVideoProfile?.maxCaptureHeight ?? null,
      videoWidth: document.querySelector('video')?.videoWidth ?? null,
      videoHeight: document.querySelector('video')?.videoHeight ?? null,
      // The zoomed projection grows the content box; the ratio against the
      // fitted width is the user-visible zoom witness.
      projectionWidthPx: content ? Number.parseFloat(content.style.width) : null,
      projectionTopPx: content ? Number.parseFloat(content.style.top) : null,
      surfaceRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  })()`);

  const pinch = async (spreadRatio) => {
    // spreadRatio > 1 separates the fingers (zoom in); < 1 joins them (zoom out).
    const script = `((ratio) => {
      const s = document.querySelector('[data-testid="remote-window-video-surface"]');
      if (!s) { return false; }
      const rect = s.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const half = Math.max(20, rect.width / 6);
      const base = (kind, id, x) => new PointerEvent(kind, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: cy, bubbles: true, cancelable: kind !== 'pointerup', buttons: kind === 'pointerup' ? 0 : 1 });
      const first = (kind, x) => base(kind, 401, x);
      const second = (kind, x) => base(kind, 402, x);
      s.dispatchEvent(first('pointerdown', cx - half));
      s.dispatchEvent(second('pointerdown', cx + half));
      const steps = 8;
      for (let index = 1; index <= steps; index += 1) {
        const ratioNow = 1 + (ratio - 1) * (index / steps);
        s.dispatchEvent(first('pointermove', cx - half * ratioNow));
        s.dispatchEvent(second('pointermove', cx + half * ratioNow));
      }
      s.dispatchEvent(first('pointerup', cx - half * ratio));
      s.dispatchEvent(second('pointerup', cx + half * ratio));
      return true;
    })`;
    return cdp.evaluate(`(${script})(${Number(spreadRatio)})`);
  };

  const settleWindowMs = 8_000;
  const results = { baseline: { ...(await readState()), note: 'fullscreen at 1x before any pinch' } };

  // --- zoom out far (2x+) -> the capture ceiling must rise ---
  await pinch(2.4);
  await delay(settleWindowMs);
  const zoomed = await readState();
  results.zoomIn = {
    ...zoomed,
    note: 'pinch-out (zoom in) to >=2x projection',
  };

  // --- zoom back to the base band -> the capture ceiling must return ---
  await pinch(1 / 2.4);
  await delay(settleWindowMs);
  const restored = await readState();
  results.zoomOut = {
    ...restored,
    note: 'pinch-in (zoom out) back to 1x projection',
  };

  // --- one-finger pan while zoomed must not change the capture ceiling ---
  const panState = await cdp.evaluate(`(() => {
    const s = document.querySelector('[data-testid="remote-window-video-surface"]');
    if (!s) { return null; }
    const rect = s.getBoundingClientRect();
    const base = (kind, x) => new PointerEvent(kind, { pointerId: 403, pointerType: 'touch', isPrimary: true, clientX: x, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: kind !== 'pointerup', buttons: kind === 'pointerup' ? 0 : 1 });
    s.dispatchEvent(base('pointerdown', rect.x + rect.width / 2));
    for (let index = 1; index <= 8; index += 1) {
      s.dispatchEvent(base('pointermove', rect.x + rect.width / 2 + index * 12));
    }
    s.dispatchEvent(base('pointerup', rect.x + rect.width / 2 + 96));
    return true;
  })()`);
  if (!panState) {
    throw new Error('video surface not found for zoom pan phase');
  }
  await delay(settleWindowMs);
  results.unzoomedPan = { ...(await readState()), note: 'unzoomed one-finger pan' };

  return results;
}

const failureContext = { cdp: null, outDir: null };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/remote-window-perf-baseline.mjs --serial <serial> [--cdp-port 9223] [--seconds 30] [--target-index 0] [--out <dir>]');
    return;
  }
  const serial = resolveSerial(args.serial);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out ?? join(process.cwd(), 'evidence', 'remote-stream-perf-1013', `baseline-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  failureContext.outDir = outDir;

  const packageDump = adb(serial, ['shell', 'dumpsys', 'package', APP_ID]);
  const versionName = /versionName=(\S+)/.exec(packageDump)?.[1] ?? null;
  const versionCode = /versionCode=(\d+)/.exec(packageDump)?.[1] ?? null;

  const pid = adb(serial, ['shell', 'pidof', APP_ID]);
  adb(serial, ['forward', `tcp:${args.cdpPort}`, `localabstract:webview_devtools_remote_${pid}`]);
  const targets = await fetch(`http://127.0.0.1:${args.cdpPort}/json/list`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error('no WebView page target over CDP');

  const cdp = createCdpClient(page.webSocketDebuggerUrl);
  failureContext.cdp = cdp;
  await cdp.ready;
  await cdp.call('Page.enable');
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE });
  await cdp.call('Page.reload', { ignoreCache: false });
  await delay(6_000);

  // Real entry: the app boots to the connections home. The saved-connection
  // button only reacts after hydration, so keep re-clicking the real button
  // until the terminal page is actually on screen.
  const hookState = await waitFor(
    cdp,
    `(() => { const result = ${CAPACITOR_HOOK_EXPRESSION}; return (result === 'hooked' || result === 'already' || result === 'no-bridge-functions') ? result : false; })()`,
    60_000,
    'capacitor bridge hook',
  );
  if (hookState === 'no-bridge-functions') {
    throw new Error('Capacitor bridge exposes neither nativePromise nor notifyListeners; the session channel lane cannot be observed from the page');
  }
  await waitFor(
    cdp,
    'Boolean(document.querySelector("[data-testid=saved-connection-open]") || document.querySelector("[data-testid=terminal-connection-status-strip]"))',
    90_000,
    'app shell',
  );
  // A leftover modal (for example a stale "ws connect timeout") sits above the
  // connection list and swallows clicks. Dismiss it before driving the flow.
  await cdp.evaluate(
    '(() => { const button = document.querySelector("[data-testid=zterm-dialog-confirm]"); if (button) { button.click(); return true; } return false; })()',
  );
  await waitFor(
    cdp,
    '(() => { if (document.querySelector("[data-testid=terminal-connection-status-strip]")) { return true; } const open = document.querySelector("[data-testid=saved-connection-open]"); if (open) { open.click(); } return false; })()',
    90_000,
    'terminal page',
  );
  await waitFor(
    cdp,
    '(() => { const text = document.querySelector("[data-testid=terminal-connection-status-strip]")?.innerText || ""; return !text.includes("正在重连") && text.length > 0; })()',
    90_000,
    'session connected',
  );
  await cdp.evaluate('(() => { const exit = document.querySelector("[data-testid=remote-window-exit-stream]"); if (exit) { exit.click(); return "exited"; } return "clean"; })()');
  await delay(2_000);
  // The first catalog request can time out while the daemon warms its window
  // catalog, so re-open the picker through the real entry until it lists
  // targets. The loop never fabricates a target.
  await waitFor(
    cdp,
    `(() => {
      if (document.querySelectorAll("[data-testid^=remote-window-target-]").length > 0) { return true; }
      const picker = document.querySelector("[data-testid=remote-window-picker]");
      const error = document.querySelector("[data-testid=remote-window-picker-error]");
      if (picker && error) {
        const close = document.querySelector("[data-testid=remote-window-embedded-picker-header] button");
        if (close) { close.click(); }
        return false;
      }
      if (picker) { return false; }
      const exit = document.querySelector("[data-testid=remote-window-exit-stream]");
      if (exit) { exit.click(); return false; }
      const entry = document.querySelector("[data-testid=remote-window-entry]");
      if (entry) { entry.click(); }
      return false;
    })()`,
    90_000,
    'target catalog',
  );
  const catalog = await cdp.evaluate('(() => [...document.querySelectorAll("[data-testid^=remote-window-target-]")].map((node) => ({ testId: node.getAttribute("data-testid"), text: (node.parentElement?.innerText || "").replace(/\\n/g, " | ").slice(0, 120) })))()');
  const chosen = args.targetMatch
    ? catalog.find((entry) => entry.text.includes(args.targetMatch))
    : catalog[Math.min(args.targetIndex, catalog.length - 1)];
  if (!chosen) {
    throw new Error(`no remote window target matches ${JSON.stringify(args.targetMatch)}; catalog: ${catalog.map((entry) => entry.text).join(' || ')}`);
  }
  await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-testid="${chosen.testId}"]`)}).click()`);
  // The catalog renders the OS window title verbatim, and the overlay's active
  // app switch shows that same title. A measurement bound to any other window
  // must fail rather than be published under the requested target's name. A
  // live window title can carry a volatile suffix (Terminal renders the current
  // child process name), so an explicit --target-match token is enforced as a
  // required substring of the active title; without a token the catalog title
  // must match exactly.
  const expectedActiveTitle = (chosen.text.match(/^APP\s+(.*?)\s+\d+\s*个窗口/)?.[1]
    ?? chosen.text.split('|')[1]
    ?? chosen.text)
    .replace(/^\|\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
  const activeTitleProbe = args.targetMatch
    ? `(() => { const button = document.querySelector('[data-testid="remote-window-active-app-switch-button"]'); return Boolean(button) && button.textContent.trim().includes(${JSON.stringify(args.targetMatch)}); })()`
    : `(() => { const button = document.querySelector('[data-testid="remote-window-active-app-switch-button"]'); return Boolean(button) && ${JSON.stringify(expectedActiveTitle)} === button.textContent.trim(); })()`;
  await waitFor(
    cdp,
    activeTitleProbe,
    30_000,
    `active target ${args.targetMatch ?? expectedActiveTitle}`,
  );
  // The target initially opens in the compact floating projection. Promote the
  // same stream to fullscreen before capturing pixel-domain clarity; otherwise
  // a 283px drawer thumbnail would measure the drawer, not the decoded video.
  const fullscreenSelector = "button[aria-label='全屏远程窗口']";
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(fullscreenSelector)}))`, 20_000, 'fullscreen affordance');
  await cdp.evaluate(`document.querySelector(${JSON.stringify(fullscreenSelector)})?.click()`);
  await waitFor(cdp, '(() => { const video = document.querySelector("video"); const rect = video?.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; return Boolean(video?.srcObject) && Boolean(rect && rect.width * dpr > 800 && rect.height * dpr > 400); })()', 20_000, 'fullscreen video projection');
  await waitFor(cdp, '(() => { const video = document.querySelector("video"); return Boolean(video && video.srcObject) && (video.webkitDecodedFrameCount || 0) > 0; })()', 45_000, 'first decoded frame');
  await cdp.evaluate('(() => { const state = window.__rwPerf; return state && state.attachFrameHook ? state.attachFrameHook() : false; })()');

  // The remote-window keyboard is only rendered outside the floating passive
  // preview, and the draft is submitted by the field's own Enter handler, while
  // the remote Enter key is a separate control. All three steps are required
  // before an injected command can take effect in the remote window.
  const sendRemoteKeyboardText = async (text) => {
    const step = { keyboardButton: false, field: false, typed: false, submitted: false, enterKey: false };
    step.keyboardButton = Boolean(await cdp.evaluate(`(() => {
      const button = document.querySelector('[aria-label="调起远程窗口键盘"]');
      if (!button) { return false; }
      button.click();
      return true;
    })()`));
    await delay(2_000);
    const typed = await cdp.evaluate(`(() => {
      const field = document.querySelector('[aria-label="发送到串流窗口"]');
      if (!field) { return false; }
      const proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    step.field = typed;
    step.typed = typed;
    await delay(1_200);
    step.submitted = Boolean(await cdp.evaluate(`(() => {
      const field = document.querySelector('[aria-label="发送到串流窗口"]');
      return Boolean(field) && field.value === '';
    })()`));
    step.enterKey = Boolean(await cdp.evaluate(`(() => {
      const button = document.querySelector('[aria-label="Enter"]');
      if (!button) { return false; }
      button.click();
      return true;
    })()`));
    await delay(1_500);
    return step;
  };
  // An app target streams one window of that app, so a keyboard acceptance run
  // must name the exact window it types into. Switching inside the video keeps
  // the harness on the same public entry the user drives.
  const switchStreamWindow = async (windowKey) => {
    const option = `[data-testid="remote-window-video-window-option-app-window:${windowKey}"]`;
    // The switcher toggle is a toggle: opening it when it is already open hides
    // the options again, so only open it when the target option is absent.
    const present = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(option)}))`);
    if (!present) {
      await cdp.evaluate(`(() => {
        const toggle = document.querySelector('[data-testid=remote-window-video-window-switcher]');
        if (toggle) { toggle.click(); return true; }
        return false;
      })()`);
      await delay(2_000);
    }
    const clicked = await cdp.evaluate(`(() => {
      const option = document.querySelector(${JSON.stringify(option)});
      if (!option) { return false; }
      option.click();
      return true;
    })()`);
    await delay(4_000);
    const available = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-testid^="remote-window-video-window-option-"]')].map((node) => node.getAttribute('data-testid').replace('remote-window-video-window-option-app-window:', '')))()`);
    const activeTitle = await cdp.evaluate(`(() => document.querySelector('[data-testid=remote-window-active-app-switch-button]')?.textContent?.trim() || null)()`);
    return { switched: clicked, available, activeTitle };
  };
  const streamWindow = typeof args.windowId === 'string' && args.windowId
    ? await switchStreamWindow(args.windowId)
    : null;
  const keyboard = typeof args.keyboardText === 'string' && args.keyboardText
    ? await sendRemoteKeyboardText(args.keyboardText)
    : null;

  // The app only turns trusted pointer input into `remote-window-input`
  // messages, so synthetic `new PointerEvent` dispatch never reaches the input
  // path and every input column stayed at zero samples. Real touch events
  // through CDP are what the phone actually delivers.
  const driveTrustedTouch = async () => {
    const center = await cdp.evaluate(`(() => {
      const surface = document.querySelector('[data-testid="remote-window-video-surface"]') || document.querySelector('video');
      if (!surface) { return null; }
      const rect = surface.getBoundingClientRect();
      if (!rect.width || !rect.height) { return null; }
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!center) {
      return false;
    }
    await cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: center.x, y: center.y, id: 1 }] });
    await delay(80);
    await cdp.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x + 12, y: center.y + 6, id: 1 }] });
    await delay(80);
    await cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  };

  const samples = [];
  const deadline = Date.now() + args.seconds * 1000;
  let capturedShot = false;
  let touchesDriven = 0;
  while (Date.now() < deadline) {
    const sample = await cdp.evaluate(SAMPLE_EXPRESSION);
    if (sample) samples.push(sample);
    if (!capturedShot && samples.length >= 4) {
      // Black-box clarity evidence: the phone's own pixels, not a client metric.
      capturedShot = capturePhoneScreenshot(args.serial, outDir);
    }
    if (await driveTrustedTouch()) {
      touchesDriven += 1;
    }
    await delay(500);
  }
  const zoomSamples = args.zoomProbe ? await sampleZoomCapture(cdp, args) : null;
  const wire = await cdp.evaluate(READ_WIRE_EXPRESSION);
  // Keep the exact decoded pixels beside the phone screenshot. This is the
  // codec-domain clarity truth; the screenshot remains the user-visible
  // compositor truth. A missing frame is explicit rather than fabricated.
  const decodedFrameDataUrl = await cdp.evaluate(`(() => {
    const video = document.querySelector('video');
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  })()`);
  if (typeof decodedFrameDataUrl === 'string' && decodedFrameDataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(join(outDir, 'decoded-frame.png'), Buffer.from(decodedFrameDataUrl.slice('data:image/png;base64,'.length), 'base64'));
  }
  cdp.close();

  const statuses = (wire?.messages ?? []).filter((entry) => entry.type === 'remote-window-stream-status');
  // The daemon streamId is the binding key; the MediaStream id is a client-side
  // identity and must never be used to match daemon status messages.
  const latestStreamId = statuses.at(-1)?.message?.payload?.streamId ?? null;
  const mediaStreamId = samples.at(-1)?.streamId ?? null;
  const streamStatuses = statuses.filter((entry) => entry.message?.payload?.streamId === latestStreamId);
  const latencySamples = streamStatuses.map((entry) => entry.message.payload.latency).filter(Boolean);
  const lastLatency = latencySamples.at(-1) ?? null;
  // framesSent/framesDropped/frameAgeMs are the drop policy's own account of
  // what happened between capture arrival and the encoder handoff.
  const dropReports = streamStatuses
    .map((entry) => entry.message.payload)
    .filter((payload) => typeof payload.framesDropped === 'number');
  const lastDropReport = dropReports.at(-1) ?? null;
  const dropSummary = lastDropReport
    ? {
        framesSent: lastDropReport.framesSent ?? null,
        framesDropped: lastDropReport.framesDropped ?? null,
        lastFrameAgeMs: lastDropReport.frameAgeMs ?? null,
        phase: lastDropReport.phase ?? null,
        reports: dropReports.length,
      }
    : null;

  const inputsBySequence = new Map((wire?.inputs ?? []).map((entry) => [entry.sequence, entry.t]));
  const inputRoundTrips = (wire?.messages ?? [])
    .filter((entry) => entry.type === 'remote-window-input-ack')
    .map((ack) => {
      const sentAt = inputsBySequence.get(ack.message?.control?.sequence ?? null);
      return typeof sentAt === 'number' ? ack.t - sentAt : null;
    })
    .filter((value) => typeof value === 'number' && value >= 0);

  const presented = wire?.presented ?? [];
  const presentedIntervals = presented
    .map((entry, index) => (index === 0 ? null : entry.t - presented[index - 1].t))
    .filter((value) => typeof value === 'number' && value > 0);
  const decodedFrames = samples.map((sample) => sample.decodedFrames).filter((value) => typeof value === 'number');
  const droppedFrames = samples.map((sample) => sample.droppedVideoFrames).filter((value) => typeof value === 'number');

  const result = {
    harness: 'remote-window-perf-baseline',
    capturedAt: new Date().toISOString(),
    host: await sampleHostAndDaemonConditions(),
    device: { serial, appId: APP_ID, versionName, versionCode },    binding: {
      streamId: latestStreamId,
      mediaStreamId,
      targetTestId: chosen.testId,
      targetText: chosen.text,
      catalogSize: catalog.length,
      codecMimeType: lastLatency?.codecMimeType ?? null,
      latencySampleCount: latencySamples.length,
      wireTypes: wire?.types ?? {},
    },
    video: {
      samples: samples.length,
      firstDecodedFrames: decodedFrames.at(0) ?? null,
      lastDecodedFrames: decodedFrames.at(-1) ?? null,
      frameGrowth: decodedFrames.length > 1 ? (decodedFrames.at(-1) - decodedFrames.at(0)) : null,
      droppedVideoFrames: droppedFrames.at(-1) ?? null,
      readyState: samples.at(-1)?.readyState ?? null,
      videoWidth: samples.at(-1)?.videoWidth ?? null,
      videoHeight: samples.at(-1)?.videoHeight ?? null,
      presentedFrameCallbacks: presented.length,
    },
    dropPolicy: dropSummary,
    // Every value below is a proxy segment, not glass-to-glass latency.
    segments: {
      daemonCaptureToEncodeMs: summarize(latencySamples.map((entry) => entry.captureToEncodeP50Ms)),
      daemonEncodeMsPerFrame: summarize(latencySamples.map((entry) => entry.encodeMsPerFrame)),
      daemonPacketSendDelayMs: summarize(latencySamples.map((entry) => entry.packetSendDelayMs)),
      daemonNetworkRttMs: summarize(latencySamples.map((entry) => entry.networkRttMs)),
      daemonEncodedFps: summarize(latencySamples.map((entry) => entry.encodedFps)),
      daemonCapturedFps: summarize(latencySamples.map((entry) => entry.capturedFps)),
      daemonDispatchedFps: summarize(latencySamples.map((entry) => entry.dispatchedFps)),
      daemonSentBitrateBps: summarize(latencySamples.map((entry) => entry.sentBitrateBps)),
      daemonInputInjectMs: summarize(latencySamples.map((entry) => entry.inputInjectP50Ms)),
      daemonCaptureWidth: summarize(latencySamples.map((entry) => entry.captureWidth)),
      daemonCaptureHeight: summarize(latencySamples.map((entry) => entry.captureHeight)),
      clientInputRoundTripMs: summarize(inputRoundTrips),
      clientPresentedFrameIntervalMs: summarize(presentedIntervals),
    },
    streamWindow,
    keyboard,
    raw: { samples, latencySamples, inputRoundTrips, touchesDriven, catalog, lastLatency, dropReports, zoomSamples, wireTypes: wire?.types ?? {}, qualityResults: (wire?.messages ?? []).filter((entry) => entry.type === 'remote-window-stream-quality-result').map((entry) => entry.message?.payload).filter(Boolean) },
  };

  if (zoomSamples) {
    result.zoomCapture = zoomSamples;
  }

  const jsonPath = join(outDir, 'baseline.json');
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const rows = Object.entries(result.segments)
    .map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50 ?? '-'} | ${value.p95 ?? '-'} | ${value.min ?? '-'} | ${value.max ?? '-'} |`)
    .join('\n');
  const markdown = `# Remote-window baseline (proxy segments)

Captured: ${result.capturedAt}
Device: \`${serial}\` app \`${APP_ID}\` ${versionName} (${versionCode})
target: \`${chosen.testId}\` ${chosen.text}
streamId: \`${latestStreamId}\`
negotiated codec: \`${result.binding.codecMimeType}\`
host: load \`${(result.host.loadAverage ?? []).join(' / ')}\` on ${result.host.cpuCount} cpus, swap used \`${result.host.swapUsedMb}/${result.host.swapTotalMb} MB\`, daemon RSS \`${result.host.daemonRssMb} MB\`, daemon uptime \`${result.host.daemonUptimeSec}s\`, sessions \`${JSON.stringify(result.host.daemonSessions)}\`

| segment (proxy) | samples | p50 | p95 | min | max |
| --- | --- | --- | --- | --- | --- |
${rows}

Video: decoded frames ${result.video.firstDecodedFrames} -> ${result.video.lastDecodedFrames} (growth ${result.video.frameGrowth}), readyState ${result.video.readyState}, ${result.video.videoWidth}x${result.video.videoHeight}, rVFC callbacks ${result.video.presentedFrameCallbacks}, droppedVideoFrames ${result.video.droppedVideoFrames}.

Latency values are segment proxies measured on the daemon and the client. They are not glass-to-glass latency.
`;
  writeFileSync(join(outDir, 'baseline.md'), markdown);
  console.log(JSON.stringify({ outDir, binding: result.binding, video: result.video, segments: result.segments }, null, 2));
}

main().catch(async (error) => {
  try {
    const { cdp, outDir } = failureContext;
    if (cdp && outDir) {
      const dump = await Promise.race([
        cdp.evaluate(`(() => ({
        in: (window.__rwPerf?.in || []).slice(-80),
        out: (window.__rwPerf?.out || []).slice(-80),
        types: window.__rwPerf?.types || {},
      }))()`),
        delay(5_000).then(() => null),
      ]);
      if (dump) {
        writeFileSync(join(outDir, 'failure-wire-dump.json'), JSON.stringify(dump, null, 2));
      }
      cdp.close();
    }
  } catch { /* preserve the original measurement failure */ }
  console.error(`[remote-window-perf-baseline] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

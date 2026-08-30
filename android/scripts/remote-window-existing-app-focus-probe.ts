import { WebSocket } from 'ws';
import wrtc from '@roamhq/wrtc';
import { spawnSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import type {
  ClientMessage,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
  ServerMessage,
} from '../src/lib/types';
import { buildRemoteWindowVideoProfile } from '../src/lib/remote-window-video-quality';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc as unknown as {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection;
  RTCSessionDescription: typeof globalThis.RTCSessionDescription;
  RTCIceCandidate: typeof globalThis.RTCIceCandidate;
};

const DAEMON_WS_URL = process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_WS_URL || process.argv[2] || 'ws://127.0.0.1:3333';
const TARGET_BUNDLE_ID = (process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_BUNDLE || 'com.tencent.xinWeChat').trim();
const TARGET_TITLE_INCLUDES = (process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_TITLE || '').trim();
const DEFOCUS_BUNDLE_ID = (process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_DEFOCUS_BUNDLE || 'com.apple.finder').trim();
const USE_MUX = process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_MUX === '1';
const VIDEO_ONLY = process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_VIDEO_ONLY === '1';
const PROBE_MUX_SESSION = process.env.ZTERM_REMOTE_WINDOW_EXISTING_APP_MUX_SESSION || 'zterm';
const REQUEST_PREFIX = `rw-existing-app-focus-${Date.now()}`;
const PROBE_MUX_CHANNEL_ID = `${REQUEST_PREFIX}-channel`;
const PROBE_MUX_CLIENT_ID = `${REQUEST_PREFIX}-client`;
const REMOTE_WINDOW_EXISTING_APP_CATALOG_TIMEOUT_MS = 30_000;
const REMOTE_WINDOW_EXISTING_APP_STREAM_TIMEOUT_MS = 40_000;

function fail(message: string): never {
  throw new Error(message);
}

function requestId(suffix: string) {
  return `${REQUEST_PREFIX}-${suffix}`;
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

async function activateBundleId(bundleId: string) {
  runAppleScript(`tell application id "${appleScriptStringLiteral(bundleId)}" to activate`);
  await waitForFrontmostBundleId(bundleId, `activate ${bundleId}`);
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
    }, 8_000);
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
  throw new Error(`timed out waiting for ${label}; tail=${JSON.stringify(messages.slice(-6))}`);
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
  throw new Error(`timed out waiting for ${label}; tail=${JSON.stringify(frames.slice(-6))}`);
}

function pickTarget(targets: RemoteWindowStreamTargetManifest[]) {
  const matches = targets.filter((target) => (
    target.videoTarget.kind === 'app-window'
    && target.streamMode === 'interactive'
    && target.inputRoute === 'os-event'
    && target.focusPolicy === 'bring-to-focus'
    && target.videoTarget.appBundleId === TARGET_BUNDLE_ID
    && (!TARGET_TITLE_INCLUDES || target.videoTarget.title.includes(TARGET_TITLE_INCLUDES))
  ));
  if (matches.length === 0) {
    fail(`no matching target for bundle=${TARGET_BUNDLE_ID} titleIncludes=${TARGET_TITLE_INCLUDES || '*'}; candidates=${JSON.stringify(targets.map((target) => ({
      bundle: target.videoTarget.appBundleId,
      title: target.videoTarget.title,
      mode: target.streamMode,
      route: target.inputRoute,
      focus: target.focusPolicy,
    })).slice(0, 30))}`);
  }
  return matches[0]!;
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
    fail(`remote input rejected: ${JSON.stringify(response)}`);
  }
  return response.payload;
}

async function waitForReceiverTrack(
  peerConnection: RTCPeerConnection,
  messages: ServerMessage[],
  streamId: string,
  hasTrack: () => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  const appliedCandidates = new Set<string>();
  while (Date.now() < deadline) {
    for (const message of messages) {
      if (
        message.type !== 'remote-window-stream-ice-candidate'
        || message.payload.streamId !== streamId
        || !message.payload.candidate?.candidate
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
      readyState: receiver.track?.readyState,
    }))
    : [];
  throw new Error(`timed out waiting for existing-app receiver ontrack event; candidates=${appliedCandidates.size}; state=${peerConnection.connectionState}; ice=${peerConnection.iceConnectionState}; signaling=${peerConnection.signalingState}; receivers=${JSON.stringify(receivers)}`);
}

async function main() {
  if (!TARGET_BUNDLE_ID) {
    fail('target bundle id is required');
  }
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
    await waitForRawMuxFrame(rawFrames, (frame) => frame?.type === 'mux-ready', 'mux-ready');
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
      (frame) => frame?.type === 'mux-channel-opened' && frame.payload?.channelId === PROBE_MUX_CHANNEL_ID,
      `mux-channel-opened:${PROBE_MUX_CHANNEL_ID}`,
    );
  }

  const catalogRequestId = requestId('catalog');
  send(ws, {
    type: 'remote-window-targets-request',
    payload: {
      requestId: catalogRequestId,
      forceRefresh: true,
      includeIterm2: false,
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
    REMOTE_WINDOW_EXISTING_APP_CATALOG_TIMEOUT_MS,
  );
  if (catalog.type !== 'remote-window-targets-response') {
    fail(`catalog failed: ${JSON.stringify(catalog)}`);
  }
  const target = pickTarget(catalog.payload.targets);

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
        type: 'offer',
        sdp: offer.sdp || '',
      },
      videoProfile: buildRemoteWindowVideoProfile('smooth', {
        cause: 'network',
        level: 2,
      }),
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
    REMOTE_WINDOW_EXISTING_APP_STREAM_TIMEOUT_MS,
  );
  if (started.type !== 'remote-window-stream-started') {
    fail(`stream start failed: ${JSON.stringify(started)}`);
  }
  await peerConnection.setRemoteDescription(new RTCSessionDescription(started.payload.answer));
  await waitForReceiverTrack(
    peerConnection,
    messages,
    streamId,
    () => trackSeen,
    REMOTE_WINDOW_EXISTING_APP_STREAM_TIMEOUT_MS,
  );
  trackSeen = true;
  await waitForServerMessage(
    messages,
    (message) => (
      message.type === 'remote-window-stream-status'
      && message.payload.streamId === streamId
      && message.payload.phase === 'streaming'
    ),
    'remote window stream status',
    REMOTE_WINDOW_EXISTING_APP_STREAM_TIMEOUT_MS,
  );

  if (VIDEO_ONLY) {
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
    peerConnection.close();
    ws.close();
    console.log(JSON.stringify({
      ok: true,
      videoOnly: true,
      daemonWsUrl: DAEMON_WS_URL,
      controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
      targetBundleId: TARGET_BUNDLE_ID,
      targetTitle: target.videoTarget.title,
      targetId: target.streamTargetId,
      trackSeen,
      capture: started.payload.capture,
      stopped: stopped.type === 'remote-window-stream-status' ? stopped.payload : stopped,
    }, null, 2));
    return;
  }

  const frontmostBeforeDefocus = readFrontmostBundleId();
  if (DEFOCUS_BUNDLE_ID && DEFOCUS_BUNDLE_ID !== TARGET_BUNDLE_ID) {
    await activateBundleId(DEFOCUS_BUNDLE_ID);
  }
  const frontmostAfterDefocus = readFrontmostBundleId();
  if (frontmostAfterDefocus === TARGET_BUNDLE_ID) {
    fail(`defocus failed: target ${TARGET_BUNDLE_ID} is still frontmost before remote focus`);
  }

  const focusPayload: RemoteWindowInputEventPayload = {
    requestId: requestId('focus'),
    streamId,
    targetId: target.streamTargetId,
    clientSentAt: Date.now(),
    event: { kind: 'focus' },
  };
  send(ws, { type: 'remote-window-input', payload: focusPayload });
  await waitForInputAccepted(messages, focusPayload);
  await waitForFrontmostBundleId(TARGET_BUNDLE_ID, 'remote focus accepted');

  send(ws, {
    type: 'remote-window-stream-stop-request',
    payload: {
      requestId: requestId('stop'),
      streamId,
    },
  });
  await waitForServerMessage(
    messages,
    (message) => (
      message.type === 'remote-window-stream-status'
      && message.payload.streamId === streamId
      && message.payload.phase === 'stopped'
    ),
    'remote window stream stop',
  );
  peerConnection.close();
  ws.close();

  console.log(JSON.stringify({
    ok: true,
    daemonWsUrl: DAEMON_WS_URL,
    controlTransport: USE_MUX ? 'mux-channel' : 'raw-ws',
    targetBundleId: TARGET_BUNDLE_ID,
    targetTitle: target.videoTarget.title,
    targetId: target.streamTargetId,
    defocusBundleId: DEFOCUS_BUNDLE_ID || undefined,
    frontmostBeforeDefocus,
    frontmostAfterDefocus,
    frontmostAfterRemoteFocus: readFrontmostBundleId(),
    trackSeen,
    capture: started.payload.capture,
  }, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

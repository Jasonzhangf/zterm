import { createRequire } from 'node:module';
import WebSocket from '/Volumes/Intel/playground/zterm/remote-stream-perf-1013/node_modules/.pnpm/ws@8.20.0/node_modules/ws/index.js';
const require = createRequire('/Volumes/Intel/playground/zterm/remote-stream-perf-1013/android/');
const wrtc = require('@roamhq/wrtc');
const { RTCPeerConnection, RTCVideoSink } = wrtc;
const nonstandard = wrtc.nonstandard || {};
const Sink = RTCVideoSink || nonstandard.RTCVideoSink;
const token = 'wterm-4123456';
const open = (p) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:4333${p}?token=${token}`); ws.on('open', () => res(ws)); ws.on('error', rej); });
const control = await open('/ws');
let ticket = null;
control.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'session-ticket') ticket = m.payload; });
control.send(JSON.stringify({ type: 'session-open', payload: { openRequestId: 'sp-1', sessionName: 'zcamapp-0' } }));
for (let i = 0; i < 40 && !ticket; i += 1) await new Promise((r) => setTimeout(r, 500));
const ws = await open('/ws');
let target = null, frames = 0, firstFrame = null, offerSeen = false;
const pc = new RTCPeerConnection({ iceServers: [] });
pc.ontrack = (ev) => {
  const track = ev.track;
  console.log('ONTrack', track.kind);
  if (Sink) {
    const sink = new Sink(track);
    sink.onframe = ({ frame }) => {
      frames += 1;
      if (!firstFrame) { firstFrame = { w: frame.width, h: frame.height, at: Date.now() }; console.log('FIRST FRAME', frame.width, 'x', frame.height); }
    };
  }
};
pc.onicecandidate = (ev) => {
  if (ev.candidate && offerSeen) ws.send(JSON.stringify({ type: 'remote-window-stream-ice-candidate', payload: { streamId: 'probe-stream-1', requestId: 'sp-1', candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate } }));
};
ws.on('message', async (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'remote-window-targets-response' && !target) {
    const want = process.env.RW_TARGET || '';
    const list = (m.payload?.targets || []).filter((t) => t.videoTarget?.kind === 'app-window');
    target = want ? list.find((t) => `${t.ownerName || ''} ${t.videoTarget?.title || ''} ${t.title || ''}`.includes(want)) : list[0];
    if (want) console.log('MATCH', list.map((t) => `${t.ownerName}:${t.videoTarget?.title}`).join(' | ').slice(0, 300));
    console.log('TARGET', target?.streamTargetId);
    ws.send(JSON.stringify({ type: 'remote-window-stream-start-v2-request', payload: {
      requestId: 'sp-1', streamId: 'probe-stream-1', mediaPlan: 'single-focus', mediaPlanVersion: 2, target,
      videoProfile: { preference: 'smooth', maxBitrateBps: Number(process.env.RW_BPS || 2000000), maxFrameRateFps: 30, maxCaptureWidth: Number(process.env.RW_W || 1280), maxCaptureHeight: Number(process.env.RW_H || 800), maxFrameAgeMs: 200, interactionActive: false, overviewMaxBitrateBps: 500000, overviewMaxFrameRateFps: 8 },
    } }));
  }
  if (m.type === 'remote-window-stream-status' && m.payload?.latency) {
    const l = m.payload.latency;
    console.log('LAT', JSON.stringify({ stage: m.payload.stage, p50: l.captureToEncodeP50Ms, p95: l.captureToEncodeP95Ms, enc: l.encodeMsPerFrame, send: l.packetSendDelayMs, capFps: l.capturedFps, dispFps: l.dispatchedFps, encFps: l.encodedFps, bps: l.sentBitrateBps, codec: l.codec }));
  } else if (!['buffer-sync','session-activity','title','schedule-state','connected','remote-window-stream-ice-candidate','remote-window-stream-offer-v2','remote-window-targets-response'].includes(m.type)) console.log('MSG', m.type, JSON.stringify(m.payload).slice(0,200));
  if (m.type === 'remote-window-stream-offer-v2') {
    offerSeen = true;
    console.log('OFFER', (m.payload.offer.sdp || '').length);
    await pc.setRemoteDescription({ type: 'offer', sdp: m.payload.offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'remote-window-stream-answer-v2', payload: { requestId: 'sp-1', streamId: 'probe-stream-1', mediaPlanVersion: 2, answer: { type: 'answer', sdp: pc.localDescription.sdp } } }));
    console.log('ANSWER SENT');
  }
  if (m.type === 'remote-window-stream-ice-candidate' && m.payload?.candidate) { try { await pc.addIceCandidate(m.payload.candidate); } catch {} }
  if (m.type === 'remote-window-error' || (m.type === 'remote-window-stream-start-status')) console.log('STATUS', m.type, JSON.stringify(m.payload).slice(0, 300));
});
ws.send(JSON.stringify({ type: 'connect', payload: { openRequestId: 'sp-1', sessionName: 'zcamapp-0', sessionTransportToken: ticket.sessionTransportToken, widthMode: 'mirror-fixed' } }));
await new Promise((r) => setTimeout(r, 3500));
ws.send(JSON.stringify({ type: 'remote-window-targets-request', payload: { requestId: 'sp-1', includeAppWindows: true } }));
await new Promise((r) => setTimeout(r, 22000));
const span = firstFrame ? (Date.now() - firstFrame.at) / 1000 : 0;
console.log('RESULT cfg=', process.env.RW_W || 1280, 'x', process.env.RW_H || 800, 'frames=', frames, 'spanSec=', span.toFixed(1), 'fps=', span > 0 ? (frames / span).toFixed(1) : 'n/a', 'first=', JSON.stringify(firstFrame));
process.exit(0);

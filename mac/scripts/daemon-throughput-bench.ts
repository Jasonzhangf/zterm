/**
 * Mac daemon throughput benchmark
 * Usage:
 *   cd mac && ./node_modules/.bin/tsx scripts/daemon-throughput-bench.ts \
 *     [--subs=4] [--host=127.0.0.1] [--port=3333] [--duration=10]
 */

import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const NUM_SUBS = Math.max(1, parseInt(args.subs ?? '4', 10));
const HOST = args.host ?? '127.0.0.1';
const PORT = parseInt(args.port ?? '3333', 10);
const DURATION_S = Math.max(3, parseInt(args.duration ?? '10', 10));
const LAB_SESSION = 'zterm_tput_bench';

interface SubMetrics {
  id: number;
  headProbes: number[];
  bufferSyncs: number[];
  connectLatency: number;
  errors: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function now() { return Date.now(); }

function run(cmd: string, a: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, a);
    let out = '';
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.stderr?.on('data', (d) => (out += d.toString()));
    p.on('close', (c) => c === 0 ? res(out.trim()) : rej(new Error(`${cmd} ${a.join(' ')} exit ${c}: ${out}`)));
    p.on('error', rej);
  });
}

function makeUrl(role: 'control' | 'session') {
  const u = new URL(`ws://${HOST}:${PORT}/`);
  u.searchParams.set('ztermTransport', role);
  return u.toString();
}

async function setupSession() {
  try { await run('tmux', ['kill-session', '-t', LAB_SESSION]); } catch {}
  await run('tmux', ['new-session', '-d', '-s', LAB_SESSION, '-x', '80', '-y', '24']);
  await run('tmux', ['send-keys', '-t', LAB_SESSION, 'for i in $(seq 1 200); do echo "line-$i"; done', 'Enter']);
  await sleep(500);
  await run('tmux', ['send-keys', '-t', LAB_SESSION, 'clear', 'Enter']);
  await sleep(200);
}

async function cleanup() {
  try { await run('tmux', ['kill-session', '-t', LAB_SESSION]); } catch {}
}

async function wsConnect(subId: number): Promise<{ sessionWs: WebSocket; metrics: SubMetrics }> {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const metrics: SubMetrics = { id: subId, headProbes: [], bufferSyncs: [], connectLatency: 0, errors: 0 };
    const controlWs = new WebSocket(makeUrl('control'));

    const timer = setTimeout(() => { controlWs.close(); reject(new Error(`sub ${subId} timeout`)); }, 8000);

    controlWs.on('error', () => { metrics.errors++; });
    controlWs.on('close', () => {});

    controlWs.on('open', () => {
      console.log(`[sub-${subId}] control open -> session-open`);
      controlWs.send(JSON.stringify({ type: 'session-open', payload: { sessionName: LAB_SESSION } }));
    });

    controlWs.on('message', (data) => {
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        console.log(`[sub-${subId}] control msg: ${raw.slice(0, 120)}`);
        if (msg.type === 'session-ticket') {
          console.log(`[sub-${subId}] got session-ticket -> session ws`);
          const sessionWs = new WebSocket(makeUrl('session'));

          sessionWs.on('error', () => { metrics.errors++; });
          sessionWs.on('close', () => {});

          sessionWs.on('open', () => {
            console.log(`[sub-${subId}] session ws open -> connect`);
            sessionWs.send(JSON.stringify({
              type: 'connect',
              payload: {
                openRequestId: `bench-${subId}-${t0}`,
                sessionTransportToken: msg.payload.sessionTransportToken,
                sessionName: LAB_SESSION,
                cols: 80,
                rows: 24,
              },
            }));
          });

          sessionWs.on('message', (sdata) => {
            try {
              const smsg = JSON.parse(sdata.toString());
              console.log(`[sub-${subId}] session msg: ${sdata.toString().slice(0, 120)}`);
              if (smsg.type === 'connected') {
                clearTimeout(timer);
                controlWs.close();
                metrics.connectLatency = now() - t0;
                console.log(`[sub-${subId}] CONNECTED latency=${metrics.connectLatency}ms`);
                sessionWs.send(JSON.stringify({ type: 'buffer-head-request' }));
              }
              if (smsg.type === 'buffer-head') {
                metrics.headProbes.push(now() - t0);
                sessionWs.send(JSON.stringify({ type: 'buffer-sync-request', payload: { knownRevision: 0, localStartIndex: 0, localEndIndex: 0, requestStartIndex: 0, requestEndIndex: 100 } }));
              }
              if (smsg.type === 'buffer-sync') {
                metrics.bufferSyncs.push(now() - t0);
                sessionWs.send(JSON.stringify({ type: 'buffer-head-request' }));
              }
            } catch { metrics.errors++; }
          });

          resolve({ sessionWs, metrics });
        }
      } catch (e) {
        metrics.errors++;
        console.error(`[sub-${subId}] parse error:`, e);
      }
    });
  });
}

async function captureTopSample(): Promise<string> {
  try { return await run('top', ['-l', '1', '-n', '1', '-stats', 'pid,command,%cpu', '-o', '%cpu']); }
  catch { return ''; }
}

async function main() {
  console.log(`\n=== daemon-throughput-bench ===  subs=${NUM_SUBS} host=${HOST}:${PORT} duration=${DURATION_S}s\n`);

  await setupSession();
  console.log('  [setup] tmux ready');

  // warmup
  try {
    const w = await wsConnect(0);
    await sleep(2000);
    w.sessionWs.close();
    console.log(`  [warmup] connect=${w.metrics.connectLatency}ms head=${w.metrics.headProbes.length} sync=${w.metrics.bufferSyncs.length} errors=${w.metrics.errors}`);
  } catch (e) {
    console.error('  [warmup FAILED]', e);
    await cleanup();
    process.exit(1);
  }

  const topSamples: string[] = [];
  const topInterval = setInterval(async () => {
    const s = await captureTopSample();
    if (s) topSamples.push(s);
  }, 1000);

  const subs: Array<{ sessionWs: WebSocket; metrics: SubMetrics }> = [];
  const tStart = now();

  for (let i = 0; i < NUM_SUBS; i++) {
    try {
      const sub = await wsConnect(i);
      subs.push(sub);
      console.log(`  [connect] sub-${i} latency=${sub.metrics.connectLatency}ms`);
    } catch (e) {
      console.error(`  [connect FAILED] sub-${i}:`, e);
    }
    await sleep(100);
  }

  console.log(`\n  [run] ${DURATION_S}s...\n`);
  while (now() - tStart < DURATION_S * 1000) {
    await sleep(500);
    for (const { sessionWs } of subs) {
      if (sessionWs.readyState === WebSocket.OPEN) {
        sessionWs.send(JSON.stringify({ type: 'buffer-head-request' }));
      }
    }
  }

  await sleep(1000);
  clearInterval(topInterval);
  for (const { sessionWs } of subs) { sessionWs.close(); }

  const tEnd = now();
  const elapsedS = (tEnd - tStart) / 1000;

  console.log('\n=== Results ===');
  for (const { metrics } of subs) {
    console.log(`sub-${metrics.id}: connect=${metrics.connectLatency}ms head=${metrics.headProbes.length} sync=${metrics.bufferSyncs.length} errors=${metrics.errors}`);
  }

  const totalHead = subs.reduce((a, s) => a + s.metrics.headProbes.length, 0);
  const totalSync = subs.reduce((a, s) => a + s.metrics.bufferSyncs.length, 0);
  const allErrors = subs.reduce((a, s) => a + s.metrics.errors, 0);
  const lats = subs.map((s) => s.metrics.connectLatency).filter((l) => l > 0);

  console.log(`\nAggregate: subs=${subs.length} elapsed=${elapsedS.toFixed(1)}s headProbes=${totalHead} sync=${totalSync} head/s=${(totalHead/elapsedS).toFixed(1)} sync/s=${(totalSync/elapsedS).toFixed(1)} errors=${allErrors}`);
  if (lats.length) { console.log(`Connect latency: avg=${(lats.reduce((a,b)=>a+b,0)/lats.length).toFixed(0)}ms max=${Math.max(...lats)}ms`); }

  if (topSamples.length) {
    console.log('\n--- top oracle (daemon CPU) ---');
    topSamples.join('\n').split('\n').filter((l) => l.includes('node')||l.includes('zterm')).slice(0,10).forEach((l) => console.log(' ', l));
  }

  console.log('\n=== done ===\n');
  await cleanup();
  process.exit(allErrors > 0 && allErrors >= subs.length ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL:', e); await cleanup(); process.exit(1); });

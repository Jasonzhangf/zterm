import { spawn, spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';

// Cross-host UDP hole-punch probe used to separate NAT reachability from
// WebRTC ICE behavior. Both hosts run the same Python probe on one UDP socket:
// first a STUN binding request to learn the reflexive endpoint, then
// simultaneous sends to the peer's reflexive endpoint.
const PROBE_SOURCE = String.raw`
import os, select, socket, struct, sys, time

STUN_SERVER = os.environ.get("STUN_SERVER", "relay.codewhisper.cc")
STUN_PORT = int(os.environ.get("STUN_PORT", "3479"))
RUN_SECONDS = float(os.environ.get("PROBE_SECONDS", "20"))

def stun_reflexive_endpoint(sock):
    sock.settimeout(4.0)
    transaction_id = os.urandom(12)
    request = struct.pack(">HHI", 0x0001, 0, 0x2112A442) + transaction_id
    sock.sendto(request, (STUN_SERVER, STUN_PORT))
    data, _ = sock.recvfrom(2048)
    idx = 20
    xored = None
    while idx + 4 <= len(data):
        attr_type, attr_len = struct.unpack(">HH", data[idx:idx + 4])
        value = data[idx + 4:idx + 4 + attr_len]
        if attr_type == 0x0020:
            xored = value
            break
        idx += 4 + attr_len + ((4 - attr_len % 4) % 4)
    if xored is None or len(xored) < 8:
        raise RuntimeError("no XOR-MAPPED-ADDRESS in STUN response")
    family = xored[1]
    port = struct.unpack(">H", xored[2:4])[0] ^ (0x2112A442 >> 16)
    if family == 0x01:
        raw = struct.unpack(">I", xored[4:8])[0] ^ 0x2112A442
        ip = socket.inet_ntoa(struct.pack(">I", raw))
    else:
        raw = bytes(b ^ c for b, c in zip(xored[4:20], struct.pack(">I", 0x2112A442) + transaction_id))
        ip = socket.inet_ntop(socket.AF_INET6, raw)
    return ip, port

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", 0))
local_port = sock.getsockname()[1]
ip, port = stun_reflexive_endpoint(sock)
print(f"SRFLX {ip} {port} local_port={local_port}", flush=True)

line = sys.stdin.readline().strip()
if not line.startswith("PEER "):
    raise RuntimeError(f"expected PEER line, got {line!r}")
_, peer_ip, peer_port = line.split()
peer = (peer_ip, int(peer_port))
print(f"PEER {peer_ip} {peer_port}", flush=True)

sock.setblocking(False)
deadline = time.time() + RUN_SECONDS
sent = 0
received = []
while time.time() < deadline:
    sock.sendto(b"ZTERM-PROBE", peer)
    sent += 1
    readable, _, _ = select.select([sock], [], [], 0.2)
    if readable:
        data, addr = sock.recvfrom(2048)
        received.append(addr)
        print(f"RECV {addr[0]}:{addr[1]} {data[:32]!r}", flush=True)
    if sent % 10 == 0:
        print(f"SENT {sent}", flush=True)

print(f"RESULT sent={sent} received={len(received)} peer={peer_ip}:{peer_port}", flush=True)
`;

type Probe = {
  name: string;
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
  srflx: { ip: string; port: number } | null;
  waiters: Array<(line: string) => void>;
};

function createProbe(name: string, command: string, args: string[]): Probe {
  const probe: Probe = { name, child: spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }), stdout: [], stderr: [], srflx: null, waiters: [] };
  let buffer = '';
  probe.child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        probe.stdout.push(line);
        process.stdout.write(`[${name}] ${line}\n`);
        if (line.startsWith('SRFLX ')) {
          const [, ip, port] = line.split(' ');
          probe.srflx = { ip, port: Number(port) };
        }
        const waiter = probe.waiters.shift();
        waiter?.(line);
      }
      index = buffer.indexOf('\n');
    }
  });
  probe.child.stderr?.on('data', (chunk) => {
    probe.stderr.push(String(chunk));
    process.stderr.write(`[${name}!] ${chunk}`);
  });
  return probe;
}

function nextLine(probe: Probe, matcher: (line: string) => boolean, timeoutMs: number) {
  const existing = probe.stdout.find(matcher);
  if (existing) return Promise.resolve(existing);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${probe.name}: timed out waiting for line`)), timeoutMs);
    probe.waiters.push((line) => {
      clearTimeout(timer);
      if (matcher(line)) {
        resolve(line);
      } else {
        probe.waiters.push(() => resolve(line));
      }
    });
  });
}

async function main() {
  const target = process.env.UDP_HOLEPUNCH_TARGET?.trim() || '100.86.84.63';
  const localPath = join(tmpdir(), `zterm-udp-probe-${Date.now()}.py`);
  const remotePath = `/tmp/zterm-udp-probe-${Date.now()}.py`;
  writeFileSync(localPath, PROBE_SOURCE, 'utf8');
  const copy = spawnSync('scp', ['-o', 'BatchMode=yes', localPath, `fanzhang@${target}:${remotePath}`], { encoding: 'utf8' });
  if (copy.status !== 0) throw new Error(`scp probe failed: ${copy.stderr || copy.stdout}`);
  const local = createProbe('local', 'python3', ['-u', localPath]);
  const remote = createProbe('air', 'ssh', ['-o', 'BatchMode=yes', `fanzhang@${target}`, 'python3', '-u', remotePath]);
  try {
    await nextLine(local, (line) => line.startsWith('SRFLX '), 20_000);
    await nextLine(remote, (line) => line.startsWith('SRFLX '), 20_000);
    if (!local.srflx || !remote.srflx) throw new Error('missing reflexive endpoint');
    local.child.stdin?.write(`PEER ${remote.srflx.ip} ${remote.srflx.port}\n`);
    remote.child.stdin?.write(`PEER ${local.srflx.ip} ${local.srflx.port}\n`);
    await delay(22_000);
    const localResult = local.stdout.find((line) => line.startsWith('RESULT '));
    const remoteResult = remote.stdout.find((line) => line.startsWith('RESULT '));
    const received = [...local.stdout, ...remote.stdout].some((line) => line.startsWith('RECV '));
    process.stdout.write(JSON.stringify({
      ok: received,
      local: { srflx: local.srflx, result: localResult },
      remote: { srflx: remote.srflx, result: remoteResult },
    }, null, 2) + '\n');
    if (!received) process.exitCode = 1;
  } finally {
    local.child.kill('SIGINT');
    remote.child.kill('SIGINT');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

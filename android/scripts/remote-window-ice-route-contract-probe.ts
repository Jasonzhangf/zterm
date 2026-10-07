import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../src/lib/bridge-settings';
import type { BridgeTransportSocket } from '../src/lib/traversal/types';
import type { Session } from '../src/lib/types';
import { resolveRemoteWindowStreamIceServers } from '../src/contexts/session-context-remote-window-runtime';

type ProbeResult = {
  name: string;
  status: 'pass' | 'fail';
  observed?: unknown;
  expected?: string;
  error?: string;
};

type ProbeCase = {
  name: string;
  expected: string;
  run: () => unknown;
  check: (value: unknown) => string[];
  expectError?: string;
};

const relaySettings = {
  ...DEFAULT_BRIDGE_SETTINGS,
  traversalRelay: {
    relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay',
    accessToken: 'relay-access',
    userId: 'user-1',
    username: 'jason',
    deviceId: 'device-1',
    deviceName: 'phone',
    platform: 'android',
    wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
    wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
    wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
    turnUrl: 'turn:relay.codewhisper.cc:3479?transport=udp',
    turnUsername: 'turn-user',
    turnCredential: 'turn-credential',
    updatedAt: 1,
  },
} as BridgeSettings;

function makeSession(overrides: Partial<Session> & { resolvedPath: Session['resolvedPath'] }): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'fixture',
    bridgeHost: '100.66.1.82',
    bridgePort: 3333,
    daemonHostId: 'mac-studio',
    sessionName: 'zterm',
    authToken: 'daemon-token',
    title: 'fixture',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 0,
    ...overrides,
  };
}

function makeWs(resolvedPath: NonNullable<Session['resolvedPath']>): BridgeTransportSocket {
  return {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => {},
    close: () => {},
    reportFailure: () => {},
    getDiagnostics: () => ({
      mode: 'auto',
      stage: 'open',
      resolvedPath,
      resolvedEndpoint: resolvedPath === 'rtc-relay' ? 'relay:mac-studio' : 'rtc-direct:mac-studio',
      attempts: [],
    }),
  };
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const cases: ProbeCase[] = [
  {
    name: 'rtc-relay inherits exact TURN credentials while a Tailscale host is available',
    expected: 'exact rtc-relay TURN urls/username/credential',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ resolvedPath: 'rtc-relay' }),
      ws: makeWs('rtc-relay'),
      bridgeSettings: relaySettings,
    }),
    check: (value) => {
      const actual = JSON.stringify(value);
      const expected = JSON.stringify([{
        urls: 'turn:relay.codewhisper.cc:3479?transport=udp',
        username: 'turn-user',
        credential: 'turn-credential',
      }]);
      return actual === expected ? [] : [`expected ${expected}, got ${actual}`];
    },
  },
  {
    name: 'rtc-direct uses STUN-only ICE while a LAN host is available',
    expected: 'STUN servers with no TURN credentials',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ bridgeHost: '192.168.1.20', resolvedPath: 'rtc-direct' }),
      ws: makeWs('rtc-direct'),
      bridgeSettings: relaySettings,
    }),
    check: (value) => {
      if (!Array.isArray(value) || value.length === 0) {
        return [`expected non-empty STUN list, got ${JSON.stringify(value)}`];
      }
      const failures: string[] = [];
      for (const server of value) {
        const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
        if (urls.some((url: unknown) => typeof url !== 'string' || !url.startsWith('stun:'))) {
          failures.push(`expected only stun: urls, got ${JSON.stringify(server)}`);
        }
        if (server?.username !== undefined || server?.credential !== undefined) {
          failures.push(`expected no TURN credentials, got ${JSON.stringify(server)}`);
        }
      }
      if (!JSON.stringify(value).includes('stun:relay.codewhisper.cc:3479')) {
        failures.push('expected configured TURN host to be derived as a STUN server');
      }
      return failures;
    },
  },
  {
    name: 'non-RTC actual route is not promoted to RTC media',
    expected: 'undefined for a LAN session route',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ bridgeHost: '192.168.1.20', resolvedPath: 'lan' }),
      ws: makeWs('lan'),
      bridgeSettings: relaySettings,
    }),
    check: (value) => value === undefined ? [] : [`expected undefined, got ${JSON.stringify(value)}`],
  },
  {
    name: 'missing bridge settings keeps the existing no-ICE result',
    expected: 'undefined without bridge settings',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ resolvedPath: 'rtc-relay' }),
      ws: makeWs('rtc-relay'),
      bridgeSettings: null,
    }),
    check: (value) => value === undefined ? [] : [`expected undefined, got ${JSON.stringify(value)}`],
  },
  {
    name: 'missing RTC signal configuration fails explicitly',
    expected: 'WebRTC mode requires explicit signalUrl and relay daemon target',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ resolvedPath: 'rtc-relay' }),
      ws: makeWs('rtc-relay'),
      bridgeSettings: {
        ...DEFAULT_BRIDGE_SETTINGS,
        traversalRelay: undefined,
      },
    }),
    expectError: 'WebRTC mode requires explicit signalUrl and relay daemon target',
    check: () => [],
  },
  {
    name: 'invalid RTC relay identity fails explicitly',
    expected: 'WebRTC relay mode requires selecting an online relay daemon device',
    run: () => resolveRemoteWindowStreamIceServers({
      session: makeSession({ daemonHostId: undefined, resolvedPath: 'rtc-relay' }),
      ws: makeWs('rtc-relay'),
      bridgeSettings: relaySettings,
    }),
    expectError: 'WebRTC relay mode requires selecting an online relay daemon device',
    check: () => [],
  },
];

function parseArgs(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true, outputDir: '' };
  }
  const index = argv.indexOf('--output-dir');
  if (index < 0 || !argv[index + 1]) {
    throw new Error('missing required --output-dir <path>');
  }
  return { help: false, outputDir: argv[index + 1] };
}

async function main() {
  const { help, outputDir } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write([
      'Remote-window media ICE route contract probe',
      '',
      'Validation layer: configuration-only. This imports resolveRemoteWindowStreamIceServers',
      'and checks the derived RTC ICE contract. It does not connect to Relay, cellular, TURN,',
      'a daemon, a device, or the real media route.',
      '',
      'Usage:',
      '  pnpm --dir android exec tsx scripts/remote-window-ice-route-contract-probe.ts --output-dir <evidence-dir>',
      '',
    ].join('\n'));
    return;
  }

  const results: ProbeResult[] = cases.map((probe) => {
    try {
      const value = probe.run();
      if (probe.expectError) {
        return {
          name: probe.name,
          status: 'fail',
          observed: value,
          expected: probe.expected,
          error: `expected error "${probe.expectError}", got ${JSON.stringify(value)}`,
        };
      }
      const failures = probe.check(value);
      return {
        name: probe.name,
        status: failures.length === 0 ? 'pass' : 'fail',
        observed: value,
        expected: probe.expected,
        ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
      };
    } catch (error) {
      const message = describeError(error);
      return {
        name: probe.name,
        status: probe.expectError === message ? 'pass' : 'fail',
        expected: probe.expected,
        ...(probe.expectError === message ? {} : { error: message }),
      };
    }
  });

  await mkdir(outputDir, { recursive: true });
  const evidencePath = join(outputDir, 'remote-window-ice-route-contract-probe.json');
  await writeFile(evidencePath, `${JSON.stringify({ input: 'public resolver fixture', results }, null, 2)}\n`);

  const failed = results.filter((result) => result.status === 'fail');
  process.stdout.write(`${JSON.stringify({ evidencePath, passed: results.length - failed.length, failed: failed.length }, null, 2)}\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode = 1;
});

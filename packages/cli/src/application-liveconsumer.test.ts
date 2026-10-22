import { mkdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AccountClient,
  type AuthenticatedAccount,
} from './account-client.js';
import type { createApplicationConnection } from './application-connection.js';
import { SessionConnectionError } from './connection.js';
import { assertExternalRtcRelayEvidence } from './external-rtc-evidence.js';
import type {
  RelayAccountDirectory,
  RelayEndpointCandidate,
} from '../../shared/src/connection/relay-directory.js';
import type { TraversalDiagnostics } from '../../shared/src/connection/traversal/types.js';

interface RtcFixtureReceipt {
  managedTest: true;
  publicRelayBaseUrl: string;
  username: string;
  password: string;
  deviceId: string;
  daemonHostId: string;
}

interface RtcFixture {
  receiptPath: string;
  publicReceipt: {
    ok: boolean;
    selfcheck: {
      direct: { ok: boolean } | null;
    };
  };
  close(): Promise<unknown>;
}

function safeFailureScalar(value: unknown): string | number | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function describeSessionConnectionFailure(error: SessionConnectionError) {
  const cause = typeof error.cause === 'object' && error.cause !== null
    ? error.cause as { kind?: unknown; stage?: unknown; code?: unknown }
    : undefined;
  const causeKind = safeFailureScalar(cause?.kind);
  const causeStage = safeFailureScalar(cause?.stage);
  const causeCode = safeFailureScalar(cause?.code);
  const detail = [
    `stage=${error.stage}`,
    `code=${error.code}`,
    error.serverCode === undefined ? undefined : `serverCode=${error.serverCode}`,
    causeKind === undefined ? undefined : `cause.kind=${causeKind}`,
    causeStage === undefined ? undefined : `cause.stage=${causeStage}`,
    causeCode === undefined ? undefined : `cause.code=${causeCode}`,
  ].filter((part): part is string => part !== undefined);
  return new Error(
    `${error.message}; ${detail.join(', ')}`,
    { cause: error },
  );
}

async function loadRtcFixture() {
  const moduleUrl = new URL('../scripts/rtc-fixture.mjs', import.meta.url).href;
  return await import(moduleUrl) as {
    startRtcFixture(options: {
      evidenceDir: string;
      timeoutMs?: number;
    }): Promise<RtcFixture>;
  };
}

async function loadNativeTimingObserver() {
  const observerUrl = new URL(
    '../scripts/rtc-passive-observer.mjs',
    import.meta.url,
  ).href;
  return import(observerUrl) as Promise<{
    installNativeTimingObserver(options: {
      emit: (value: Record<string, unknown>) => void;
    }): () => void;
  }>;
}

async function assertReceiptPrivacy(receiptPath: string) {
  const moduleUrl = new URL(
    '../scripts/remote-cli-blackbox-helper.mjs',
    import.meta.url,
  ).href;
  const helper = await import(moduleUrl) as {
    assertReceiptPrivacy(path: string): { kind: string; verified: boolean };
    assertReceiptNotInsideEvidence(path: string, evidenceDir: string): void;
  };
  const result = helper.assertReceiptPrivacy(receiptPath);
  expect(result).toEqual({
    kind: process.platform === 'win32'
      ? 'windows-acl'
      : 'posix-mode-0600',
    verified: true,
  });
  return helper;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`RTC fixture receipt is missing ${field}`);
  }
  return value;
}

function readReceipt(receiptPath: string): RtcFixtureReceipt {
  const value = JSON.parse(
    readFileSync(receiptPath, 'utf8'),
  ) as Record<string, unknown>;
  if (value.managedTest !== true) {
    throw new Error('RTC fixture receipt must declare managedTest: true');
  }
  return {
    managedTest: true,
    publicRelayBaseUrl: requireString(
      value.publicRelayBaseUrl,
      'publicRelayBaseUrl',
    ),
    username: requireString(value.username, 'username'),
    password: requireString(value.password, 'password'),
    deviceId: requireString(value.deviceId, 'deviceId'),
    daemonHostId: requireString(value.daemonHostId, 'daemonHostId'),
  };
}

function requirePublicRelayBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('external RTC fixture receipt must use an http(s) public relay');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost')
  ) {
    throw new Error('external RTC fixture receipt must not use a loopback relay');
  }
  return value;
}

function useUnreachableFirstWs(
  device: RelayAccountDirectory['devices'][number],
) {
  if (!device?.daemon) {
    throw new Error('RTC fixture directory omitted the daemon');
  }
  const unreachable: RelayEndpointCandidate = {
    id: 'consumer-unreachable-ws',
    kind: 'lan',
    host: '127.0.0.1',
    port: 1,
    authRequired: false,
    lastSeenAt: new Date().toISOString(),
  };
  const rtcRoutes = device.daemon.endpoints.filter((endpoint) =>
    endpoint.kind === 'rtc-direct'
    || endpoint.kind === 'relay-rtc'
  );
  device.daemon.endpoints.splice(
    0,
    device.daemon.endpoints.length,
    unreachable,
    ...rtcRoutes,
  );
}

async function loadAccount(
  receipt: RtcFixtureReceipt,
  relayBaseUrl: string,
  signal: AbortSignal,
) {
  const client = new AccountClient();
  const login = await client.login({
    relayBaseUrl,
    username: receipt.username,
    password: receipt.password,
  }, signal);
  const current = await client.me({
    relayBaseUrl,
    accessToken: login.accessToken,
  }, signal);
  const device = current.directory.devices.find((candidate) =>
    candidate.deviceId === receipt.deviceId
    && candidate.daemon?.hostId === receipt.daemonHostId);
  if (!device?.daemon) {
    throw new Error('current directory does not contain the receipt daemon target');
  }
  const account: AuthenticatedAccount = {
    relayBaseUrl,
    accessToken: current.accessToken,
    user: current.user,
    directory: current.directory,
    ws: current.ws ?? login.ws,
    turn: current.turn ?? login.turn,
  };
  return { account, device };
}

function compactRouteDiagnostics(diagnostics: TraversalDiagnostics | null) {
  if (!diagnostics) {
    throw new Error('SessionConnection did not expose traversal diagnostics');
  }
  const path = diagnostics.resolvedPath;
  const localCandidateType = diagnostics.selectedIcePair?.local?.candidateType;
  const remoteCandidateType = diagnostics.selectedIcePair?.remote?.candidateType;
  const compact = {
    stage: diagnostics.stage,
    path: path ?? null,
    relayTransport: diagnostics.resolvedRelayTransport ?? null,
    localCandidateType: localCandidateType ?? null,
    remoteCandidateType: remoteCandidateType ?? null,
  };
  process.stdout.write(`rtc-route-evidence: ${JSON.stringify(compact)}\n`);
  if (!diagnostics.selectedIcePair) {
    throw new Error(
      'TraversalSocket bound-initial diagnostics omitted selectedIcePair: '
      + 'connectInitialBatch drops the RTC onpath callback before attempt promotion',
    );
  }
  expect(diagnostics.stage).toBe('open');
  expect(path === 'rtc-direct' || path === 'rtc-relay').toBe(true);
  expect(typeof localCandidateType).toBe('string');
  expect(typeof remoteCandidateType).toBe('string');
  if (path === 'rtc-relay') {
    expect(diagnostics.resolvedRelayTransport).toBe('turn');
    expect(
      localCandidateType === 'relay' || remoteCandidateType === 'relay',
    ).toBe(true);
  } else {
    expect(diagnostics.resolvedRelayTransport).toBe('direct');
    expect(
      localCandidateType === 'relay' || remoteCandidateType === 'relay',
    ).toBe(false);
  }
  return compact;
}

type LiveConsumerInput =
  | {
      kind: 'external';
      receiptPath: string;
      evidenceDir: string | null;
    }
  | {
      kind: 'fixture';
      evidenceDir: string;
    }
  | {
      kind: 'skip';
    };

function nonEmptyEnv(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function resolveLiveConsumerInputs(
  env: NodeJS.ProcessEnv = process.env,
): LiveConsumerInput {
  const receiptPath = nonEmptyEnv(env.ZTERM_RTC_FIXTURE_RECEIPT);
  const evidenceDir = nonEmptyEnv(env.ZTERM_RTC_FIXTURE_EVIDENCE_DIR);
  if (receiptPath) {
    return {
      kind: 'external',
      receiptPath,
      evidenceDir,
    };
  }
  if (evidenceDir) {
    return {
      kind: 'fixture',
      evidenceDir,
    };
  }
  return { kind: 'skip' };
}

describe('live consumer input selection', () => {
  it('gives an external receipt precedence over the evidence directory', () => {
    expect(resolveLiveConsumerInputs({
      ZTERM_RTC_FIXTURE_RECEIPT: '/private/receipt.json',
      ZTERM_RTC_FIXTURE_EVIDENCE_DIR: '/evidence/rtc-consumer',
    })).toEqual({
      kind: 'external',
      receiptPath: '/private/receipt.json',
      evidenceDir: '/evidence/rtc-consumer',
    });
  });

  it('starts the owned fixture only when no receipt is present', () => {
    expect(resolveLiveConsumerInputs({
      ZTERM_RTC_FIXTURE_EVIDENCE_DIR: '/evidence/rtc-fixture',
    })).toEqual({
      kind: 'fixture',
      evidenceDir: '/evidence/rtc-fixture',
    });
  });

  it('skips when both consumer inputs are absent', () => {
    expect(resolveLiveConsumerInputs({})).toEqual({ kind: 'skip' });
  });
});

describe('createApplicationConnection bound-initial live consumer', () => {
  const input = resolveLiveConsumerInputs();
  const live = input.kind === 'skip' ? it.skip : it;
  live(
    'proves actual RTC route diagnostics (skipped until owned fixture evidence or an external CI receipt is supplied)',
    async () => {
      if (input.kind === 'skip') {
        throw new Error('RTC consumer input is unavailable');
      }
      let fixture: RtcFixture | null = null;
      let connection: Awaited<ReturnType<typeof createApplicationConnection>> | null = null;
      let restoreTiming: (() => void) | null = null;
      try {
        let activeReceiptPath: string;
        if (input.kind === 'fixture') {
          const { startRtcFixture } = await loadRtcFixture();
          fixture = await startRtcFixture({
            evidenceDir: input.evidenceDir,
            timeoutMs: 120_000,
          });
          expect(fixture.publicReceipt.ok).toBe(true);
          expect(fixture.publicReceipt.selfcheck.direct?.ok).toBe(true);
          activeReceiptPath = fixture.receiptPath;
        } else {
          activeReceiptPath = input.receiptPath;
          if (input.evidenceDir) {
            mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
          }
        }

        const privacyHelper = await assertReceiptPrivacy(activeReceiptPath);
        if (input.kind === 'external' && input.evidenceDir) {
          privacyHelper.assertReceiptNotInsideEvidence(
            activeReceiptPath,
            input.evidenceDir,
          );
        }
        const receipt = readReceipt(activeReceiptPath);
        const relayBaseUrl = input.kind === 'fixture'
          ? receipt.publicRelayBaseUrl
          : requirePublicRelayBaseUrl(receipt.publicRelayBaseUrl);

        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error('RTC consumer timed out')),
          120_000,
        );
        let account: AuthenticatedAccount;
        let device: RelayAccountDirectory['devices'][number];
        try {
          const loaded = await loadAccount(receipt, relayBaseUrl, controller.signal);
          account = loaded.account;
          device = loaded.device;
        } finally {
          clearTimeout(timeout);
        }

        useUnreachableFirstWs(device);
        const timing = await loadNativeTimingObserver();
        restoreTiming = timing.installNativeTimingObserver({
          emit: (value) => {
            process.stdout.write(
              `rtc-timing-evidence: ${JSON.stringify(value)}\n`,
            );
          },
        });
        const { createApplicationConnection } = await import(
          './application-connection.js'
        );
        const connectionController = new AbortController();
        const connectionTimeout = setTimeout(
          () => connectionController.abort(new Error('RTC consumer timed out')),
          120_000,
        );
        try {
          connection = await createApplicationConnection(
            account,
            {
              deviceId: device.deviceId,
              daemonHostId: receipt.daemonHostId,
            },
            connectionController.signal,
            input.kind === 'external'
              ? { rtcIceTransportPolicy: 'relay' }
              : undefined,
          );
          expect(connection.state).toBe('ready');
          if (input.kind === 'external') {
            const evidence = assertExternalRtcRelayEvidence(
              connection.getDiagnostics(),
            );
            process.stdout.write(
              `rtc-route-evidence: ${JSON.stringify(evidence)}\n`,
            );
          } else {
            compactRouteDiagnostics(connection.getDiagnostics());
          }
        } catch (error) {
          if (error instanceof SessionConnectionError) {
            throw describeSessionConnectionFailure(error);
          }
          throw error;
        } finally {
          clearTimeout(connectionTimeout);
        }
      } finally {
        connection?.close('live-consumer-complete');
        restoreTiming?.();
        if (fixture) {
          await fixture.close();
        }
      }
    },
    180_000,
  );
});

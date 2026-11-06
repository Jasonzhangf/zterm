import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyReceiptEvidence } from '../../../v2/modules/delivery/src/domain/receipt.ts';
import { DaemonAppMessagingStore } from './daemon-app-messaging-store';
import {
  createAppMessagingPersistence,
  type AcceptMessageCommand,
  type ApplyReceiptEvidenceResult,
  type AppMessagingPersistenceOptions,
  type DeliveryRef,
  type DeliveryTarget,
  type ReadReceiptResult,
  type ReceiptEvidence,
} from './daemon-app-messaging-public';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const target: DeliveryTarget = Object.freeze({
  memberId: 'member-a',
  machineId: 'machine-a',
  bindingGeneration: 3,
});

function ref(overrides: Partial<DeliveryRef> = {}, requestId = 'request-a'): DeliveryRef {
  return {
    sourceMachineId: 'machine-a',
    workspaceId: 'workspace-a',
    actorAccountId: 'actor-a',
    requestId,
    ...overrides,
  };
}

function command(options: {
  deliveryRef?: DeliveryRef;
  target?: DeliveryTarget;
  body?: string;
  subject?: string;
  omitSubject?: boolean;
} = {}): AcceptMessageCommand {
  const { deliveryRef, target: at, body = 'hello', subject, omitSubject } = options;
  return {
    deliveryRef: deliveryRef ?? ref(),
    target: at ?? target,
    kind: 'message',
    message: omitSubject ? { body } : { subject: subject ?? 'subject', body },
  };
}

function evidence(
  kind: ReceiptEvidence['kind'],
  options: { ref?: DeliveryRef; target?: DeliveryTarget; errorRef?: string; observedAt?: string } = {},
): ReceiptEvidence {
  return {
    kind,
    deliveryRef: options.ref ?? ref(),
    target: options.target ?? target,
    observedAt: options.observedAt ?? '2026-11-03T10:00:00.000Z',
    ...(kind === 'unknown' || kind === 'rejected' || kind === 'failed'
      ? { errorRef: options.errorRef ?? `err-${kind}` }
      : {}),
  } as ReceiptEvidence;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zterm-facade-'));
  roots.push(root);
  return root;
}

function createPersistence(options: AppMessagingPersistenceOptions) {
  return createAppMessagingPersistence(options, applyReceiptEvidence);
}

function applyKind(result: ApplyReceiptEvidenceResult) {
  return result.kind;
}

function readKind(result: ReadReceiptResult) {
  return result.kind;
}

describe('app messaging persistence facade', () => {
  it('created/replayed/conflict/stale/subject semantics', async () => {
    const root = await makeRoot();
    const { appRootDir } = { appRootDir: join(root, 'app') };
    const store = createPersistence({ appRootDir });

    const created = await store.acceptMessage(command({ subject: '', body: 'hello' }));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('unreachable');
    expect(created.receipt.durableStage).toBe('accepted');
    expect(created.receipt.outcome).toBe('pending');

    const replayed = await store.acceptMessage(command({ subject: '', body: 'hello' }));
    expect(replayed.kind).toBe('replayed');
    if (replayed.kind !== 'replayed') throw new Error('unreachable');
    expect(replayed.receipt).toStrictEqual(created.receipt);

    expect((await store.acceptMessage(command({ subject: '', body: 'different' }))).kind).toBe('conflict');
    expect(
      (await store.acceptMessage(command({ target: { ...target, bindingGeneration: 4 } }))).kind,
    ).toBe('target-binding-stale');
    expect(
      (await store.acceptMessage(command({ target: { ...target, memberId: 'member-b' } }))).kind,
    ).toBe('conflict');

    const separate = await store.acceptMessage(
      command({ deliveryRef: ref({}, 'request-missing-subject'), omitSubject: true }),
    );
    expect(separate.kind).toBe('created');
    expect((await store.acceptMessage(command({ omitSubject: true }))).kind).toBe('conflict');
  });

  it('full DeliveryRef isolates all identifiers', async () => {
    const root = await makeRoot();
    const appRootDir = join(root, 'app');
    const store = createPersistence({ appRootDir });
    const variants = [
      ref({}, 'request-a'),
      ref({ actorAccountId: 'actor-b' }, 'request-a'),
      ref({ workspaceId: 'workspace-b' }, 'request-a'),
      ref({ sourceMachineId: 'machine-b' }, 'request-a'),
      ref({}, 'request-b'),
    ];
    for (const variant of variants) {
      expect((await store.acceptMessage(command({ deliveryRef: variant }))).kind).toBe('created');
      expect(readKind(await store.readReceipt(variant))).toBe('found');
    }
    expect(readKind(await store.readReceipt(ref({}, 'missing')))).toBe('not-found');
  });

  it('rejects before write for invalid command; no record appears', async () => {
    const root = await makeRoot();
    const appRootDir = join(root, 'app');
    const store = createPersistence({ appRootDir });
    expect(
      (await store.acceptMessage(command({ target: { ...target, bindingGeneration: -1 } }))).kind,
    ).toBe('rejected-before-write');
    expect(
      (await store.acceptMessage(command({ deliveryRef: ref({ requestId: 'x'.repeat(192) }) }))).kind,
    ).toBe('rejected-before-write');
    expect(readKind(await store.readReceipt(ref({ requestId: 'nope' })))).toBe('not-found');
  });

  it('read side-effect free: read before write creates no delivery directory', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    expect(readKind(await store.readReceipt(ref()))).toBe('not-found');
    await expect(stat(join(root, 'app', 'app-delivery'))).rejects.toMatchObject({ code: 'ENOENT' });
    const invalid = await store.readReceipt({ ...ref(), requestId: '' });
    expect(invalid.kind).toBe('unavailable');
  });

  it('fresh restart reads persisted receipt and replays without second record', async () => {
    const root = await makeRoot();
    const appRootDir = join(root, 'app');
    const first = createPersistence({ appRootDir });
    const created = await first.acceptMessage(command({ subject: '', body: 'durable' }));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('unreachable');

    const second = createPersistence({ appRootDir });
    const read = await second.readReceipt(ref());
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt).toStrictEqual(created.receipt);
    expect((await second.acceptMessage(command({ subject: '', body: 'durable' }))).kind).toBe('replayed');
  });

  it('concurrent same-ref accepts serialize to one created', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    const kinds = (await Promise.all([
      store.acceptMessage(command({ deliveryRef: ref({}, 'race') })),
      store.acceptMessage(command({ deliveryRef: ref({}, 'race') })),
      store.acceptMessage(command({ deliveryRef: ref({}, 'race') })),
    ])).map((result) => result.kind).sort();
    expect(kinds).toStrictEqual(['created', 'replayed', 'replayed']);
    const read = await store.readReceipt(ref({}, 'race'));
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('accepted');
  });

  it('strong evidence advances monotonically; repeats and older stages ignored', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());

    const remote = await store.applyReceiptEvidence(evidence('remote-stored'));
    expect(remote.kind).toBe('applied');
    if (remote.kind !== 'applied') throw new Error('unreachable');
    expect(remote.receipt.durableStage).toBe('remote-stored');
    expect(remote.receipt.outcome).toBe('confirmed');

    const host = await store.applyReceiptEvidence(evidence('host-delivered'));
    expect(applyKind(host)).toBe('applied');
    const consumed = await store.applyReceiptEvidence(evidence('consumed'));
    expect(applyKind(consumed)).toBe('applied');

    expect(applyKind(await store.applyReceiptEvidence(evidence('remote-stored')))).toBe('ignored');
    expect(applyKind(await store.applyReceiptEvidence(evidence('consumed')))).toBe('ignored');

    const read = await store.readReceipt(ref());
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('consumed');
  });

  it('unknown/rejected/failed preserve durable stage', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());
    const host = await store.applyReceiptEvidence(evidence('host-delivered'));
    expect(host.kind).toBe('applied');

    const unknown = await store.applyReceiptEvidence(evidence('unknown'));
    expect(unknown.kind).toBe('applied');
    if (unknown.kind !== 'applied') throw new Error('unreachable');
    expect(unknown.receipt.durableStage).toBe('host-delivered');
    expect(unknown.receipt.outcome).toBe('unknown');
    expect(unknown.receipt.errorRef).toBe('err-unknown');
  });

  it('weak acknowledgements and unverified consumption do not promote stage', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());
    for (const kind of ['v1-delivered', 'app-ack', 'unverified-consumption'] as const) {
      expect(applyKind(await store.applyReceiptEvidence(evidence(kind)))).toBe('ignored');
    }
    const read = await store.readReceipt(ref());
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('accepted');
  });

  it('identity mismatch on ref/target; not-found when record absent', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());

    expect(
      applyKind(await store.applyReceiptEvidence(evidence('remote-stored', {
        ref: { ...ref(), workspaceId: 'workspace-b' },
      }))),
    ).toBe('identity-mismatch');
    expect(
      applyKind(await store.applyReceiptEvidence(evidence('remote-stored', {
        target: { ...target, bindingGeneration: 9 },
      }))),
    ).toBe('identity-mismatch');
    expect(
      applyKind(await store.applyReceiptEvidence(evidence('remote-stored', { ref: ref({}, 'nope') }))),
    ).toBe('not-found');
  });

  it('fresh reopen sees applied stage and same-ref replay has no second record', async () => {
    const root = await makeRoot();
    const appRootDir = join(root, 'app');
    const first = createPersistence({ appRootDir });
    await first.acceptMessage(command());
    expect(applyKind(await first.applyReceiptEvidence(evidence('consumed')))).toBe('applied');

    const second = createPersistence({ appRootDir });
    const read = await second.readReceipt(ref());
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('consumed');
    const replay = await second.acceptMessage(command());
    expect(replay.kind).toBe('replayed');
    if (replay.kind !== 'replayed') throw new Error('unreachable');
    expect(replay.receipt.durableStage).toBe('consumed');
  });

  it('concurrent apply evidence for same ref serializes in one facade instance', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());
    const results = await Promise.all([
      store.applyReceiptEvidence(evidence('remote-stored', { observedAt: '2026-11-03T10:01:00.000Z' })),
      store.applyReceiptEvidence(evidence('host-delivered', { observedAt: '2026-11-03T10:02:00.000Z' })),
      store.applyReceiptEvidence(evidence('consumed', { observedAt: '2026-11-03T10:03:00.000Z' })),
    ]);
    expect(results.map(applyKind).sort()).toStrictEqual(['applied', 'applied', 'applied']);
    const read = await store.readReceipt(ref());
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('consumed');
  });

  it('rejects invalid evidence without writing', async () => {
    const root = await makeRoot();
    const store = createPersistence({ appRootDir: join(root, 'app') });
    await store.acceptMessage(command());
    const invalid = {
      kind: 'host-delivered',
      deliveryRef: ref(),
      target,
      observedAt: '',
    } as ReceiptEvidence;
    expect(applyKind(await store.applyReceiptEvidence(invalid))).toBe('identity-mismatch');
    const read = await store.readReceipt(ref());
    if (read.kind !== 'found') throw new Error('unreachable');
    expect(read.observation.receipt.durableStage).toBe('accepted');
  });
});

describe('facade store error boundary', () => {
  it('corrupt durable record yields unavailable for read and apply, acceptance-unknown for accept', async () => {
    const root = await makeRoot();
    const appRootDir = join(root, 'app');
    const store = createPersistence({ appRootDir });
    expect((await store.acceptMessage(command({ deliveryRef: ref({}, 'corrupt') }))).kind).toBe('created');
    const recordPath = new DaemonAppMessagingStore({ appRootDir }).deliveryRecordPath(ref({}, 'corrupt'));
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, '{not-json', 'utf8');
    const reopened = createPersistence({ appRootDir });
    expect(readKind(await reopened.readReceipt(ref({}, 'corrupt')))).toBe('unavailable');
    expect((await reopened.acceptMessage(command({ deliveryRef: ref({}, 'corrupt') }))).kind).toBe(
      'acceptance-unknown',
    );
    expect(
      applyKind(await reopened.applyReceiptEvidence(evidence('remote-stored', { ref: ref({}, 'corrupt') }))),
    ).toBe('unavailable');
  });
});

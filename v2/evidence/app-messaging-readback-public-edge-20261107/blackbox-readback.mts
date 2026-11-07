import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppMessagingPersistence } from '../../../android/src/server/daemon-app-messaging-public.ts';
import { applyReceiptEvidence } from '../../../v2/modules/delivery/src/domain/receipt.ts';

const checks: string[] = [];
function check(name: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  checks.push(`PASS: ${name}`);
}

const root = await mkdtemp(join(tmpdir(), 'zterm-readback-blackbox-'));
try {
  const appRootDir = join(root, 'app');
  const ref = {
    sourceMachineId: 'machine-a',
    workspaceId: 'workspace-a',
    actorAccountId: 'actor-a',
    requestId: 'request-a',
  };
  const target = {
    memberId: 'member-a',
    machineId: 'machine-a',
    bindingGeneration: 3,
  };

  const store = createAppMessagingPersistence({ appRootDir }, applyReceiptEvidence);

  const invalid = await store.readAcceptedCommand({ ...ref, requestId: '' });
  check('invalid ref returns invalid-input', invalid.kind === 'invalid-input');

  const missing = await store.readAcceptedCommand({ ...ref, requestId: 'missing' });
  check('missing ref returns not-found', missing.kind === 'not-found');

  await stat(join(appRootDir, 'app-delivery')).then(
    () => {
      throw new Error('FAIL: read created app-delivery directory');
    },
    (error) => {
      check(
        'read-only paths create no app-delivery directory',
        (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    },
  );

  const created = await store.acceptMessage({
    deliveryRef: ref,
    target,
    kind: 'message',
    message: { subject: 'subject', body: 'hello' },
  });
  check('acceptMessage returns created', created.kind === 'created');
  if (created.kind !== 'created') throw new Error('unreachable');
  check(
    'created receipt carries UUID v1MessageId',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      created.receipt.v1MessageId ?? '',
    ),
  );

  const read = await store.readAcceptedCommand(ref);
  check('readAcceptedCommand returns found', read.kind === 'found');
  if (read.kind !== 'found') throw new Error('unreachable');
  check('read command is frozen', Object.isFrozen(read.command));
  check(
    'read returns exact accepted command and v1MessageId',
    read.command.deliveryRef.requestId === 'request-a'
      && read.command.target.memberId === 'member-a'
      && read.command.kind === 'message'
      && read.command.message.subject === 'subject'
      && read.command.message.body === 'hello'
      && read.command.v1MessageId === created.receipt.v1MessageId,
  );

  const reopened = createAppMessagingPersistence({ appRootDir }, applyReceiptEvidence);
  const durable = await reopened.readAcceptedCommand(ref);
  check('fresh reopen returns found', durable.kind === 'found');
  if (durable.kind !== 'found') throw new Error('unreachable');
  check(
    'durable reopen preserves v1MessageId',
    durable.command.v1MessageId === created.receipt.v1MessageId,
  );

  const applied = await reopened.applyReceiptEvidence({
    kind: 'remote-stored',
    deliveryRef: ref,
    target,
    observedAt: '2026-11-07T22:00:00.000Z',
  });
  check('applyReceiptEvidence returns applied', applied.kind === 'applied');
  const afterEvidence = await reopened.readAcceptedCommand(ref);
  check('read after evidence update returns found', afterEvidence.kind === 'found');
  if (afterEvidence.kind !== 'found') throw new Error('unreachable');
  check(
    'evidence update preserves v1MessageId',
    afterEvidence.command.v1MessageId === created.receipt.v1MessageId,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(checks.join('\n'));
console.log(`BLACKBOX PASS (${checks.length} checks)`);

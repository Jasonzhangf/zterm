import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppMessagingPersistence } from '@zterm/android/app-messaging-persistence';

const selfPath = fileURLToPath(import.meta.url);
const target = Object.freeze({ memberId: 'member-a', machineId: 'machine-a', bindingGeneration: 2 });

function ref(overrides = {}) {
  return {
    sourceMachineId: 'machine-a',
    workspaceId: 'workspace-a',
    actorAccountId: 'actor-a',
    requestId: 'request-a',
    ...overrides,
  };
}

function command(options = {}) {
  return {
    deliveryRef: options.deliveryRef ?? ref(),
    target: options.target ?? target,
    kind: 'message',
    message: options.message ?? { subject: 'subject', body: 'body' },
  };
}

async function findRecordFile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findRecordFile(next);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'record.json') {
      return next;
    }
  }
  return null;
}

if (process.argv[2] === '--child-write') {
  const childRoot = process.argv[3];
  const child = createAppMessagingPersistence({ appRootDir: childRoot });
  const result = await child.acceptMessage(command());
  if (result.kind !== 'created') process.exit(2);
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'zterm-v1-facade-blackbox-'));
assert.ok(root.startsWith(tmpdir()), 'blackbox root must be a temp root');
assert.ok(!root.includes('/.zterm'), 'blackbox root must not touch production ~/.zterm');

const appRootDir = join(root, 'app');
const store = createAppMessagingPersistence({ appRootDir });

const created = await store.acceptMessage(command());
assert.equal(created.kind, 'created');
assert.equal(created.receipt.durableStage, 'accepted');
assert.equal(created.receipt.outcome, 'pending');

const replayed = await store.acceptMessage(command());
assert.equal(replayed.kind, 'replayed');
assert.deepEqual(replayed.receipt, created.receipt);

assert.equal((await store.acceptMessage(command({ message: { subject: 'subject', body: 'different' } }))).kind, 'conflict');
assert.equal(
  (await store.acceptMessage(command({ target: { ...target, bindingGeneration: 3 } }))).kind,
  'target-binding-stale',
);
assert.equal(
  (await store.acceptMessage(command({ target: { ...target, memberId: 'member-b' } }))).kind,
  'conflict',
);

const otherActor = ref({ actorAccountId: 'actor-b' });
assert.equal((await store.acceptMessage(command({ deliveryRef: otherActor }))).kind, 'created');
assert.equal((await store.readReceipt(otherActor)).kind, 'found');
assert.equal((await store.readReceipt(ref({ requestId: 'missing' }))).kind, 'not-found');
assert.equal((await store.readReceipt({ ...ref(), requestId: '' })).kind, 'unavailable');
assert.equal(
  (await store.acceptMessage(command({ target: { ...target, bindingGeneration: -1 } }))).kind,
  'rejected-before-write',
);

const fullStore = createAppMessagingPersistence({ appRootDir: join(root, 'full'), maxInboxRecords: 1 });
assert.equal((await fullStore.acceptMessage(command({ deliveryRef: ref({ requestId: 'r1' }) }))).kind, 'created');
assert.equal(
  (await fullStore.acceptMessage(command({ deliveryRef: ref({ requestId: 'r2' }) }))).kind,
  'rejected-before-write',
);

const corruptRoot = join(root, 'corrupt');
const corruptStore = createAppMessagingPersistence({ appRootDir: corruptRoot });
assert.equal((await corruptStore.acceptMessage(command({ deliveryRef: ref({ requestId: 'corrupt' }) }))).kind, 'created');
const recordFile = await findRecordFile(join(corruptRoot, 'app-delivery'));
assert.ok(recordFile, 'expected a durable delivery record');
await writeFile(recordFile, '{not-json', 'utf8');
const reopened = createAppMessagingPersistence({ appRootDir: corruptRoot });
assert.equal(
  (await reopened.acceptMessage(command({ deliveryRef: ref({ requestId: 'corrupt' }) }))).kind,
  'acceptance-unknown',
);

// A child process commits the fact then exits before the caller observes the
// result. The parent is a fresh process and recovers the same fact.
const childRoot = join(root, 'child');
const child = spawnSync(process.execPath, [selfPath, '--child-write', childRoot], { stdio: 'inherit' });
assert.equal(child.status, 0, `child commit process failed: ${child.signal ?? child.status}`);
const recovered = createAppMessagingPersistence({ appRootDir: childRoot });
const found = await recovered.readReceipt(ref());
assert.equal(found.kind, 'found');
assert.equal(found.observation.receipt.durableStage, 'accepted');
assert.equal((await recovered.acceptMessage(command())).kind, 'replayed');

console.log(`facade-blackbox-ok root=${root}`);
process.exit(0);

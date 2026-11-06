import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { createAppMessagingPersistence } from "@zterm/android/app-messaging-persistence";
import type {
  DeliveryRef,
  DeliveryTarget,
  ReceiptEvidence,
} from "@zterm/android/app-messaging-persistence";

const selfPath = fileURLToPath(import.meta.url);
const roots: string[] = [];
const target: DeliveryTarget = Object.freeze({
  memberId: "member-a",
  machineId: "machine-a",
  bindingGeneration: 2,
});

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

function deliveryRef(
  overrides: Partial<DeliveryRef> = {},
  requestId = "request-a",
): DeliveryRef {
  return {
    sourceMachineId: "machine-a",
    workspaceId: "workspace-a",
    actorAccountId: "actor-a",
    requestId,
    ...overrides,
  };
}

function refEvidence(
  kind: "remote-stored" | "host-delivered" | "consumed",
  ref: DeliveryRef = deliveryRef(),
): ReceiptEvidence {
  return {
    kind,
    deliveryRef: ref,
    target,
    observedAt: "2026-11-03T10:01:00.000Z",
  };
}

function runChild(mode: "--write" | "--apply" | "--read", appRootDir: string, requestId: string) {
  const child = spawnSync(
    process.execPath,
    [selfPath, mode, appRootDir, requestId],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(
    child.status,
    0,
    child.stderr || child.stdout || child.signal || "child process failed",
  );
  return child.stdout;
}

if (process.argv[2] === "--write" || process.argv[2] === "--apply" || process.argv[2] === "--read") {
  const mode = process.argv[2];
  const appRootDir = process.argv[3];
  const requestId = process.argv[4];
  const store = createAppMessagingPersistence({ appRootDir });
  const ref = deliveryRef({}, requestId);

  if (mode === "--write") {
    const accepted = await store.acceptMessage({
      deliveryRef: ref,
      target,
      kind: "message",
      message: { subject: "subject", body: "child-body" },
    });
    if (accepted.kind !== "created") process.exit(2);
    process.exit(0);
  }

  if (mode === "--apply") {
    const applied = await store.applyReceiptEvidence(refEvidence("consumed", ref));
    if (applied.kind !== "applied") process.exit(3);
    process.exit(0);
  }

  const read = await store.readReceipt(ref);
  if (read.kind !== "found") process.exit(4);
  process.stdout.write(
    `CHILD_READ:${JSON.stringify(read.observation.receipt.durableStage)}\n`,
  );
  process.exit(0);
}

test("real package specifier facade creates durable receipt and reopens in child", async () => {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-specifier-consumer-"));
  roots.push(root);

  const childRoot = join(root, "child");
  runChild("--write", childRoot, "request-child");

  const reopened = createAppMessagingPersistence({ appRootDir: childRoot });
  const read = await reopened.readReceipt(deliveryRef({}, "request-child"));
  assert.equal(read.kind, "found");
  if (read.kind !== "found") assert.fail("child write was not found");
  assert.equal(read.observation.receipt.durableStage, "accepted");
  assert.deepEqual(read.observation.receipt.target, target);
});

test("lifecycle evidence through package specifier persists across fresh process reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-specifier-lifecycle-"));
  roots.push(root);
  const appRootDir = join(root, "app");
  const ref = deliveryRef({}, "request-lifecycle");
  const store = createAppMessagingPersistence({ appRootDir });

  const created = await store.acceptMessage({
    deliveryRef: ref,
    target,
    kind: "message",
    message: { subject: "subject", body: "body" },
  });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") assert.fail("acceptance was not created");
  assert.equal(created.receipt.durableStage, "accepted");

  const remote = await store.applyReceiptEvidence(refEvidence("remote-stored", ref));
  assert.equal(remote.kind, "applied");
  const host = await store.applyReceiptEvidence(refEvidence("host-delivered", ref));
  assert.equal(host.kind, "applied");

  const consumed = await store.applyReceiptEvidence(refEvidence("consumed", ref));
  assert.equal(consumed.kind, "applied");

  const output = runChild("--read", appRootDir, ref.requestId);
  const line = output.split(/\r?\n/).find((value) => value.startsWith("CHILD_READ:"));
  assert.ok(line, "child did not report a durable stage");
  assert.equal(JSON.parse(line.slice("CHILD_READ:".length)), "consumed");
});

test("fresh child applies evidence into parent-created record and parent observes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-specifier-childapply-"));
  roots.push(root);
  const appRootDir = join(root, "app");
  const ref = deliveryRef({}, "request-child-apply");
  const parent = createAppMessagingPersistence({ appRootDir });
  const created = await parent.acceptMessage({
    deliveryRef: ref,
    target,
    kind: "message",
    message: { subject: "subject", body: "body" },
  });
  assert.equal(created.kind, "created");

  runChild("--apply", appRootDir, ref.requestId);

  const read = await createAppMessagingPersistence({ appRootDir }).readReceipt(ref);
  assert.equal(read.kind, "found");
  if (read.kind !== "found") assert.fail("child apply was not found");
  assert.equal(read.observation.receipt.durableStage, "consumed");
});

test("conflicts and stale bindings do not overwrite accepted receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-specifier-conflict-"));
  roots.push(root);
  const appRootDir = join(root, "app");
  const store = createAppMessagingPersistence({ appRootDir });
  const ref = deliveryRef({}, "request-conflict");
  const first = await store.acceptMessage({
    deliveryRef: ref,
    target,
    kind: "message",
    message: { subject: "", body: "durable" },
  });
  assert.equal(first.kind, "created");

  const conflict = await store.acceptMessage({
    deliveryRef: ref,
    target,
    kind: "message",
    message: { subject: "", body: "different" },
  });
  assert.equal(conflict.kind, "conflict");
  const stale = await store.acceptMessage({
    deliveryRef: ref,
    target: { ...target, bindingGeneration: target.bindingGeneration + 1 },
    kind: "message",
    message: { subject: "", body: "durable" },
  });
  assert.equal(stale.kind, "target-binding-stale");

  const read = await store.readReceipt(ref);
  assert.equal(read.kind, "found");
  if (read.kind !== "found") assert.fail("original receipt was lost");
  assert.equal(read.observation.receipt.durableStage, "accepted");
  const entry = await readdir(join(appRootDir, "app-delivery", "records"));
  assert.ok(entry.length >= 1, "expected a durable delivery record");
});

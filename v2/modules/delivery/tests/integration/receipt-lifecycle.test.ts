import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { createV1ReceiptStore } from "../../src/adapters/v1-receipt-store.ts";
import { createDeliveryPort } from "../../src/public/delivery-port.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
  ReceiptEvidence,
} from "../../src/domain/receipt.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRoutingPort,
} from "../../src/ports/dependencies.ts";
import type { ReceiptStore } from "../../src/ports/receipt-store.ts";

type AuthContext = Readonly<{
  sourceMachineId: string;
  workspaceId: string;
  actorAccountId: string;
}>;

const selfPath = fileURLToPath(import.meta.url);
const roots: string[] = [];
const target: DeliveryTarget = Object.freeze({
  memberId: "member-a",
  machineId: "machine-a",
  bindingGeneration: 2,
});

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
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

function actorFor(ref: DeliveryRef): AuthContext {
  return {
    sourceMachineId: ref.sourceMachineId,
    workspaceId: ref.workspaceId,
    actorAccountId: ref.actorAccountId,
  };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-delivery-lifecycle-"));
  roots.push(root);
  return { root, appRootDir: join(root, "app") };
}

function strongEvidence(
  kind: "remote-stored" | "host-delivered" | "consumed",
  ref: DeliveryRef = deliveryRef(),
  observedAt = "2026-11-03T10:01:00.000Z",
): ReceiptEvidence {
  return { kind, deliveryRef: ref, target, observedAt };
}

function errorEvidence(
  kind: "unknown" | "rejected" | "failed",
  ref: DeliveryRef = deliveryRef(),
): ReceiptEvidence {
  return {
    kind,
    deliveryRef: ref,
    target,
    errorRef: `err-${kind}`,
    observedAt: "2026-11-03T10:02:00.000Z",
  };
}

function weakEvidence(
  kind: "v1-delivered" | "app-ack" | "unverified-consumption",
  ref: DeliveryRef = deliveryRef(),
): ReceiptEvidence {
  return { kind, deliveryRef: ref, target, observedAt: "2026-11-03T10:03:00.000Z" };
}

function createIntegration(
  appRootDir: string,
  options: {
    target?: DeliveryTarget;
  } = {},
) {
  const adapter = createV1ReceiptStore({ appRootDir });
  let applyCalls = 0;
  let readCalls = 0;
  let acceptCalls = 0;

  const receiptStore: ReceiptStore = {
    async acceptMessage(command) {
      acceptCalls += 1;
      return adapter.acceptMessage(command);
    },
    async readReceipt(ref) {
      readCalls += 1;
      return adapter.readReceipt(ref);
    },
    async applyReceiptEvidence(evidence) {
      applyCalls += 1;
      return adapter.applyReceiptEvidence(evidence);
    },
  };

  const authorization: DeliveryAuthorizationPort<AuthContext, string> = {
    async authorizeSubmission(actor) {
      return {
        kind: "allowed",
        identity: {
          sourceMachineId: actor.sourceMachineId,
          workspaceId: actor.workspaceId,
          actorAccountId: actor.actorAccountId,
        },
      };
    },
    async authorizeReceiptQuery() {
      return { kind: "allowed" };
    },
  };

  const routing: DeliveryRoutingPort<string> = {
    async resolveTarget() {
      return { kind: "resolved", target: options.target ?? target };
    },
  };

  return {
    port: createDeliveryPort<AuthContext, string>({
      authorization,
      routing,
      receiptStore,
    }),
    adapter,
    counts: {
      accepts: () => acceptCalls,
      reads: () => readCalls,
      applies: () => applyCalls,
    },
  };
}

async function createAccepted(
  appRootDir: string,
  ref: DeliveryRef = deliveryRef(),
) {
  const integration = createIntegration(appRootDir);
  const accepted = await integration.port.submitMessage(
    actorFor(ref),
    "member-a",
    ref.requestId,
    { subject: "subject", body: "body" },
  );
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") assert.fail("submission was not accepted");
  assert.equal(accepted.receipt.durableStage, "accepted");
  return integration;
}

function runChild(mode: string, appRootDir: string, ref: DeliveryRef, evidence?: ReceiptEvidence) {
  const child = spawnSync(
    process.execPath,
    [
      selfPath,
      mode,
      appRootDir,
      JSON.stringify(ref),
      ...(evidence === undefined ? [] : [JSON.stringify(evidence)]),
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(
    child.status,
    0,
    child.stderr || child.stdout || child.signal || "child process failed",
  );
  return child.stdout;
}

if (process.argv[2] === "--apply-and-exit" || process.argv[2] === "--query-and-exit") {
  const mode = process.argv[2];
  const appRootDir = process.argv[3];
  const ref = JSON.parse(process.argv[4]) as DeliveryRef;
  if (mode === "--apply-and-exit") {
    const evidence = JSON.parse(process.argv[5]) as ReceiptEvidence;
    const integration = createIntegration(appRootDir);
    const result = await integration.adapter.applyReceiptEvidence(evidence);
    if (result.kind !== "applied") process.exit(2);
    process.exit(0);
  }
  const integration = createIntegration(appRootDir);
  const result = await integration.port.queryReceipt(actorFor(ref), ref);
  process.stdout.write(`CHILD_QUERY:${JSON.stringify(result)}\n`);
  process.exit(0);
}

test("strong evidence monotonic through local persistence adapter", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);

  const remote = await integration.adapter.applyReceiptEvidence(strongEvidence("remote-stored", ref));
  assert.equal(remote.kind, "applied");
  const host = await integration.adapter.applyReceiptEvidence(strongEvidence("host-delivered", ref));
  assert.equal(host.kind, "applied");
  const consumed = await integration.adapter.applyReceiptEvidence(strongEvidence("consumed", ref));
  assert.equal(consumed.kind, "applied");
  if (consumed.kind !== "applied") assert.fail("consumed was not applied");
  assert.equal(consumed.receipt.durableStage, "consumed");
  assert.equal(consumed.receipt.outcome, "confirmed");

  const query = await integration.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "found");
  if (query.kind !== "found") assert.fail("query did not find receipt");
  assert.equal(query.observation.receipt.durableStage, "consumed");
});

test("repeated and older strong evidence is ignored without rollback", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);
  await integration.adapter.applyReceiptEvidence(strongEvidence("consumed", ref));

  const older = await integration.adapter.applyReceiptEvidence(strongEvidence("remote-stored", ref));
  assert.equal(older.kind, "ignored");
  if (older.kind !== "ignored") assert.fail("older evidence was not ignored");
  assert.equal(older.receipt.durableStage, "consumed");

  const duplicate = await integration.adapter.applyReceiptEvidence(strongEvidence("consumed", ref));
  assert.equal(duplicate.kind, "ignored");
  if (duplicate.kind !== "ignored") assert.fail("duplicate evidence was not ignored");
  assert.equal(duplicate.receipt.durableStage, "consumed");
});

test("unknown then later strong evidence recovers durable stage", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);

  const unknown = await integration.adapter.applyReceiptEvidence(errorEvidence("unknown", ref));
  assert.equal(unknown.kind, "applied");
  if (unknown.kind !== "applied") assert.fail("unknown evidence was not recorded");
  assert.equal(unknown.receipt.durableStage, "accepted");
  assert.equal(unknown.receipt.outcome, "unknown");

  const recovered = await integration.adapter.applyReceiptEvidence(strongEvidence("remote-stored", ref));
  assert.equal(recovered.kind, "applied");
  if (recovered.kind !== "applied") assert.fail("recovered evidence was not applied");
  assert.equal(recovered.receipt.durableStage, "remote-stored");
  assert.equal(recovered.receipt.outcome, "confirmed");
});

test("weak evidence never promotes durableStage", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);
  for (const kind of ["v1-delivered", "app-ack", "unverified-consumption"] as const) {
    const result = await integration.adapter.applyReceiptEvidence(weakEvidence(kind, ref));
    assert.equal(result.kind, "ignored");
  }
  const query = await integration.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "found");
  if (query.kind !== "found") assert.fail("receipt was not found");
  assert.equal(query.observation.receipt.durableStage, "accepted");
});

test("identity mismatch on full ref/target and not-found on absent ref", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);

  const mismatchRef = await integration.adapter.applyReceiptEvidence(
    strongEvidence("remote-stored", { ...ref, workspaceId: "workspace-b" }),
  );
  assert.equal(mismatchRef.kind, "identity-mismatch");

  const mismatchTarget = await integration.adapter.applyReceiptEvidence({
    ...strongEvidence("remote-stored", ref),
    target: { ...target, bindingGeneration: target.bindingGeneration + 1 },
  });
  assert.equal(mismatchTarget.kind, "identity-mismatch");

  const absent = await integration.adapter.applyReceiptEvidence(
    strongEvidence("remote-stored", deliveryRef({}, "missing")),
  );
  assert.equal(absent.kind, "not-found");
});

test("concurrent evidence application serializes and ends at highest durable stage", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);
  const results = await Promise.all([
    integration.adapter.applyReceiptEvidence(strongEvidence("remote-stored", ref, "2026-11-03T10:01:00.000Z")),
    integration.adapter.applyReceiptEvidence(strongEvidence("host-delivered", ref, "2026-11-03T10:02:00.000Z")),
    integration.adapter.applyReceiptEvidence(strongEvidence("consumed", ref, "2026-11-03T10:03:00.000Z")),
  ]);
  assert.equal(results.filter((result) => result.kind === "applied").length >= 1, true);
  const query = await integration.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "found");
  if (query.kind !== "found") assert.fail("receipt was not found");
  assert.equal(query.observation.receipt.durableStage, "consumed");
});

test("queryReceipt is pure read with no apply or accept side effect", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = await createAccepted(appRootDir, ref);
  const beforeReads = integration.counts.reads();
  const beforeApplies = integration.counts.applies();
  const beforeAccepts = integration.counts.accepts();
  const query = await integration.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "found");
  assert.equal(integration.counts.applies(), beforeApplies);
  assert.equal(integration.counts.accepts(), beforeAccepts);
  assert.equal(integration.counts.reads(), beforeReads + 1);
});

test("strong evidence persisted by child process is visible after parent reopen", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef({}, "request-child");
  await createAccepted(appRootDir, ref);
  const consumedEvidence = strongEvidence("consumed", ref, "2026-11-03T10:04:00.000Z");
  runChild("--apply-and-exit", appRootDir, ref, consumedEvidence);

  const reopened = createIntegration(appRootDir);
  const query = await reopened.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "found");
  if (query.kind !== "found") assert.fail("child receipt was not found");
  assert.equal(query.observation.receipt.durableStage, "consumed");
  assert.equal(
    (await reopened.adapter.applyReceiptEvidence(strongEvidence("consumed", ref))).kind,
    "ignored",
  );
});

test("child query sees parent-committed stage through fresh process", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef({}, "request-parent");
  const integration = await createAccepted(appRootDir, ref);
  const host = await integration.adapter.applyReceiptEvidence(strongEvidence("host-delivered", ref));
  assert.equal(host.kind, "applied");

  const output = runChild("--query-and-exit", appRootDir, ref);
  const line = output.split(/\r?\n/).find((value) => value.startsWith("CHILD_QUERY:"));
  assert.ok(line, "child did not return typed query result");
  const parsed = JSON.parse(line.slice("CHILD_QUERY:".length)) as {
    kind: string;
    observation?: { receipt?: { durableStage?: string } };
  };
  assert.equal(parsed.kind, "found");
  assert.equal(parsed.observation?.receipt?.durableStage, "host-delivered");
});

test("public delivery port does not expose the local evidence primitive", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef();
  const integration = createIntegration(appRootDir);

  assert.equal("applyReceiptEvidence" in integration.port, false);
  const accepted = await integration.port.submitMessage(
    actorFor(ref),
    "member-a",
    ref.requestId,
    { body: "accepted" },
  );
  assert.equal(accepted.kind, "accepted");
  const applied = await integration.port.queryReceipt(actorFor(ref), ref);
  assert.equal(applied.kind, "found");
  assert.equal(applied.observation.receipt.durableStage, "accepted");
  assert.equal(integration.counts.applies(), 0);
});

test("real delivery record path exists in temp root and does not touch production", async () => {
  const { root, appRootDir } = await makeRoot();
  const ref = deliveryRef({}, "path-check");
  const integration = await createAccepted(appRootDir, ref);
  await integration.adapter.applyReceiptEvidence(strongEvidence("remote-stored", ref));
  const entry = await readdir(join(appRootDir, "app-delivery", "records"));
  assert.ok(entry.length >= 1, "expected a durable delivery record");
  assert.ok(root.startsWith(tmpdir()), "temp root must stay under tmpdir");
});

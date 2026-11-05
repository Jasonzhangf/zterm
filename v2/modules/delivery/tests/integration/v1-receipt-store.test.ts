import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { createV1ReceiptStore } from "../../src/adapters/v1-receipt-store.ts";
import { createDeliveryPort } from "../../src/public/delivery-port.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
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
  allowSubmit?: boolean;
  allowQuery?: boolean;
}>;

type ErrorReport = {
  readonly errorRef: string;
  readonly operation: "accept" | "read";
  readonly chain: readonly {
    readonly code: string;
    readonly message: string;
    readonly source?: string;
  }[];
};

const selfPath = fileURLToPath(import.meta.url);
const roots: string[] = [];
const fixedNow = Date.parse("2026-11-03T10:00:00.000Z");
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

function actorFor(
  ref: DeliveryRef,
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    sourceMachineId: ref.sourceMachineId,
    workspaceId: ref.workspaceId,
    actorAccountId: ref.actorAccountId,
    ...overrides,
  };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "zterm-v2-delivery-adapter-"));
  roots.push(root);
  return {
    root,
    appRootDir: join(root, "app"),
  };
}

function createIntegrationPort(
  appRootDir: string,
  options: {
    target?: DeliveryTarget;
    now?: () => number;
    dedupeWindowMs?: number;
    maxInboxRecords?: number;
    onReport?: (report: ErrorReport) => void;
  } = {},
) {
  const reports: ErrorReport[] = [];
  const adapter = createV1ReceiptStore({
    appRootDir,
    now: options.now ?? (() => fixedNow),
    ...(options.dedupeWindowMs === undefined
      ? {}
      : { dedupeWindowMs: options.dedupeWindowMs }),
    ...(options.maxInboxRecords === undefined
      ? {}
      : { maxInboxRecords: options.maxInboxRecords }),
    errorReporter: (report) => {
      reports.push(report);
      options.onReport?.(report);
    },
  });

  const calls: string[] = [];
  const receiptStore: ReceiptStore = {
    async acceptMessage(command) {
      calls.push("accept");
      return adapter.acceptMessage(command);
    },
    async readReceipt(ref) {
      calls.push("read");
      return adapter.readReceipt(ref);
    },
  };

  const authorization: DeliveryAuthorizationPort<AuthContext, string> = {
    async authorizeSubmission(actor) {
      if (actor.allowSubmit === false) {
        return { kind: "denied", errorRef: "submit-denied" };
      }
      return {
        kind: "allowed",
        identity: {
          sourceMachineId: actor.sourceMachineId,
          workspaceId: actor.workspaceId,
          actorAccountId: actor.actorAccountId,
        },
      };
    },
    async authorizeReceiptQuery(actor) {
      if (actor.allowQuery === false) {
        return { kind: "denied", errorRef: "query-denied" };
      }
      return { kind: "allowed" };
    },
  };

  const routing: DeliveryRoutingPort<string> = {
    async resolveTarget() {
      return {
        kind: "resolved",
        target: options.target ?? target,
      };
    },
  };

  return {
    port: createDeliveryPort<AuthContext, string>({
      authorization,
      routing,
      receiptStore,
    }),
    calls,
    reports,
  };
}

async function findRecordFile(directory: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findRecordFile(next);
      if (found !== null) return found;
    } else if (entry.isFile() && entry.name === "record.json") {
      return next;
    }
  }
  return null;
}

function childEnv(): NodeJS.ProcessEnv {
  return process.env;
}

function runChild(
  mode: "--child-write" | "--child-query",
  appRootDir: string,
  ref: DeliveryRef,
) {
  const child = spawnSync(
    process.execPath,
    [selfPath, mode, appRootDir, JSON.stringify(ref)],
    {
      encoding: "utf8",
      env: childEnv(),
    },
  );
  assert.equal(
    child.status,
    0,
    child.stderr || child.stdout || child.signal || "child process failed",
  );
  return child.stdout;
}

if (process.argv[2] === "--child-write" || process.argv[2] === "--child-query") {
  const mode = process.argv[2];
  const appRootDir = process.argv[3];
  const ref = JSON.parse(process.argv[4]) as DeliveryRef;
  const { port } = createIntegrationPort(appRootDir);
  const actor = actorFor(ref);

  if (mode === "--child-write") {
    const result = await port.submitMessage(
      actor,
      "member-a",
      ref.requestId,
      { body: "child-body" },
    );
    if (result.kind !== "accepted" || result.disposition !== "created") {
      process.stderr.write("child write did not create a durable receipt\n");
      process.exit(2);
    }
    process.exit(0);
  }

  const result = await port.queryReceipt(actor, ref);
  process.stdout.write(`CHILD_QUERY:${JSON.stringify(result)}\n`);
  process.exit(0);
}

test("real facade adapter accepts once, replays, conflicts and rejects stale binding", async () => {
  const { appRootDir } = await makeRoot();
  const { port, calls } = createIntegrationPort(appRootDir);
  const ref = deliveryRef();
  const actor = actorFor(ref);

  const first = await port.submitMessage(
    actor,
    "member-a",
    ref.requestId,
    { subject: "", body: "hello" },
  );
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") assert.fail("first submission was not accepted");
  assert.equal(first.disposition, "created");
  assert.equal(first.receipt.durableStage, "accepted");
  assert.equal(first.receipt.outcome, "pending");
  assert.deepEqual(first.receipt.deliveryRef, ref);
  assert.deepEqual(first.receipt.target, target);
  assert.deepEqual(calls, ["accept"]);

  const replay = await port.submitMessage(
    actor,
    "member-a",
    ref.requestId,
    { subject: "", body: "hello" },
  );
  assert.equal(replay.kind, "accepted");
  if (replay.kind !== "accepted") assert.fail("replay was not accepted");
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.receipt, first.receipt);

  const conflict = await port.submitMessage(
    actor,
    "member-a",
    ref.requestId,
    { subject: "", body: "different" },
  );
  assert.equal(conflict.kind, "rejected");
  if (conflict.kind !== "rejected") assert.fail("content conflict was not rejected");
  assert.equal(conflict.code, "DELIVERY_CONFLICT");

  const missingSubject = await port.submitMessage(
    actor,
    "member-a",
    ref.requestId,
    { body: "hello" },
  );
  assert.equal(missingSubject.kind, "rejected");
  if (missingSubject.kind !== "rejected") {
    assert.fail("missing subject did not conflict with an empty subject");
  }
  assert.equal(missingSubject.code, "DELIVERY_CONFLICT");

  const separateRef = deliveryRef({}, "request-missing-subject");
  const separate = await port.submitMessage(
    actorFor(separateRef),
    "member-a",
    separateRef.requestId,
    { body: "hello" },
  );
  assert.equal(separate.kind, "accepted");
  if (separate.kind !== "accepted") assert.fail("missing subject was not accepted");

  const stale = createIntegrationPort(appRootDir, {
    target: { ...target, bindingGeneration: target.bindingGeneration + 1 },
  });
  const staleResult = await stale.port.submitMessage(
    actor,
    "member-a",
    ref.requestId,
    { subject: "", body: "hello" },
  );
  assert.equal(staleResult.kind, "rejected");
  if (staleResult.kind !== "rejected") assert.fail("stale binding was not rejected");
  assert.equal(staleResult.code, "TARGET_BINDING_STALE");

  const read = await port.queryReceipt(actor, ref);
  assert.equal(read.kind, "found");
  if (read.kind !== "found") assert.fail("accepted receipt was not found");
  assert.deepEqual(read.observation.receipt.target, target);
});

test("complete DeliveryRef isolates identifiers and query remains read-only", async () => {
  const { appRootDir } = await makeRoot();
  const { port, calls } = createIntegrationPort(appRootDir);
  const variants = [
    deliveryRef(),
    deliveryRef({ sourceMachineId: "machine-b" }),
    deliveryRef({ workspaceId: "workspace-b" }),
    deliveryRef({ actorAccountId: "actor-b" }),
  ];

  for (const variant of variants) {
    const result = await port.submitMessage(
      actorFor(variant),
      "member-a",
      variant.requestId,
      { body: JSON.stringify(variant) },
    );
    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") assert.fail("variant was not accepted");
    assert.equal(result.disposition, "created");
  }

  for (const variant of variants) {
    const result = await port.queryReceipt(actorFor(variant), variant);
    assert.equal(result.kind, "found");
    if (result.kind !== "found") assert.fail("variant was not found");
    assert.deepEqual(result.observation.receipt.deliveryRef, variant);
  }

  const missing = deliveryRef({}, "request-missing");
  const notFound = await port.queryReceipt(actorFor(missing), missing);
  assert.equal(notFound.kind, "not-found");
  assert.equal(calls.filter((call) => call === "accept").length, variants.length);
  assert.equal(calls.filter((call) => call === "read").length, variants.length + 1);
});

test("authorization denial returns before any store call", async () => {
  const { appRootDir } = await makeRoot();
  const { port, calls } = createIntegrationPort(appRootDir);
  const ref = deliveryRef();

  const submit = await port.submitMessage(
    actorFor(ref, { allowSubmit: false }),
    "member-a",
    ref.requestId,
    { body: "body" },
  );
  assert.equal(submit.kind, "rejected");
  if (submit.kind !== "rejected") assert.fail("denied submit was not rejected");
  assert.equal(submit.code, "AUTHORIZATION_DENIED");
  assert.deepEqual(calls, []);

  const query = await port.queryReceipt(
    actorFor(ref, { allowQuery: false }),
    ref,
  );
  assert.equal(query.kind, "denied");
  assert.deepEqual(calls, []);
});

test("fresh reopen and child process recover durable acceptance", async () => {
  const { appRootDir } = await makeRoot();
  const childRef = deliveryRef({}, "request-child-write");
  runChild("--child-write", appRootDir, childRef);

  const reopened = createIntegrationPort(appRootDir);
  const found = await reopened.port.queryReceipt(actorFor(childRef), childRef);
  assert.equal(found.kind, "found");
  if (found.kind !== "found") assert.fail("child write was not found");
  assert.equal(found.observation.receipt.durableStage, "accepted");
  assert.equal(found.observation.receipt.outcome, "pending");

  const replay = await reopened.port.submitMessage(
    actorFor(childRef),
    "member-a",
    childRef.requestId,
    { body: "child-body" },
  );
  assert.equal(replay.kind, "accepted");
  if (replay.kind !== "accepted") assert.fail("child receipt was not replayed");
  assert.equal(replay.disposition, "replayed");

  const parentRef = deliveryRef({}, "request-child-query");
  const parent = createIntegrationPort(appRootDir);
  const parentWrite = await parent.port.submitMessage(
    actorFor(parentRef),
    "member-a",
    parentRef.requestId,
    { body: "parent-body" },
  );
  assert.equal(parentWrite.kind, "accepted");
  if (parentWrite.kind !== "accepted") assert.fail("parent write was not accepted");

  const output = runChild("--child-query", appRootDir, parentRef);
  const line = output
    .split(/\r?\n/)
    .find((value) => value.startsWith("CHILD_QUERY:"));
  assert.ok(line, "child query did not return a typed result");
  const childResult = JSON.parse(line.slice("CHILD_QUERY:".length)) as {
    kind: string;
    observation?: { receipt?: { durableStage?: string } };
  };
  assert.equal(childResult.kind, "found");
  assert.equal(childResult.observation?.receipt?.durableStage, "accepted");
});

test("corrupt durable read preserves unavailable and acceptance-unknown chains", async () => {
  const { appRootDir } = await makeRoot();
  const ref = deliveryRef({}, "request-corrupt");
  const first = createIntegrationPort(appRootDir);
  const accepted = await first.port.submitMessage(
    actorFor(ref),
    "member-a",
    ref.requestId,
    { body: "durable" },
  );
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") assert.fail("corrupt setup was not accepted");

  const recordFile = await findRecordFile(
    join(appRootDir, "app-delivery", "records"),
  );
  assert.ok(recordFile, "expected a durable delivery record");
  await writeFile(recordFile, "{not-json", "utf8");

  const reopened = createIntegrationPort(appRootDir);
  const query = await reopened.port.queryReceipt(actorFor(ref), ref);
  assert.equal(query.kind, "unavailable");
  if (query.kind !== "unavailable") assert.fail("corrupt read was not unavailable");
  assert.ok(query.errorChain && query.errorChain.length > 0);
  assert.equal(query.errorChain[0]?.source, "daemon-app-messaging-public");
  assert.equal(reopened.reports.length, 1);
  assert.equal(reopened.reports[0].operation, "read");
  assert.equal(reopened.reports[0].errorRef, query.errorRef);
  assert.deepEqual(reopened.reports[0].chain, query.errorChain);

  const submit = await reopened.port.submitMessage(
    actorFor(ref),
    "member-a",
    ref.requestId,
    { body: "durable" },
  );
  assert.equal(submit.kind, "acceptance-unknown");
  if (submit.kind !== "acceptance-unknown") {
    assert.fail("corrupt acceptance did not stay unknown");
  }
  assert.ok(submit.errorChain && submit.errorChain.length > 0);
  assert.equal(submit.errorChain[0]?.source, "daemon-app-messaging-public");
  assert.equal(reopened.reports.length, 2);
  assert.equal(reopened.reports[1].operation, "accept");
  assert.equal(reopened.reports[1].errorRef, submit.errorRef);
  assert.deepEqual(reopened.reports[1].chain, submit.errorChain);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReceiptEvidence,
  createAcceptedReceipt,
} from "../../src/domain/receipt.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
  Receipt,
  ReceiptEvidence,
  ReceiptEvidenceResult,
} from "../../src/domain/receipt.ts";
import {
  createDeliveryPort,
} from "../../src/public/delivery-port.ts";
import type {
  AcceptMessageCommand,
  AcceptMessageResult,
  ReadReceiptResult,
  ReceiptStore,
} from "../../src/ports/receipt-store.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRoutingPort,
} from "../../src/ports/dependencies.ts";

type AuthContext = Readonly<{ actor: string }>;
type Address = string;

const observedAt = "2026-11-03T10:00:00.000Z";

function deliveryRef(
  identity: {
    sourceMachineId?: string;
    workspaceId?: string;
    actorAccountId?: string;
  } = {},
  requestId = "request-a",
): DeliveryRef {
  return {
    sourceMachineId: identity.sourceMachineId ?? "machine-a",
    workspaceId: identity.workspaceId ?? "workspace-a",
    actorAccountId: identity.actorAccountId ?? "account-a",
    requestId,
  };
}

function target(generation = 7): DeliveryTarget {
  return {
    memberId: "member-a",
    machineId: "machine-b",
    bindingGeneration: generation,
  };
}

function acceptedFor(command: AcceptMessageCommand): Receipt {
  return createAcceptedReceipt(
    command.deliveryRef,
    command.target,
    observedAt,
  );
}

class ScriptedStore implements ReceiptStore {
  readonly acceptCalls: AcceptMessageCommand[] = [];
  readonly readCalls: DeliveryRef[] = [];
  readonly calls: string[] = [];
  accept: (command: AcceptMessageCommand) => Promise<AcceptMessageResult> =
    async (command) => ({
      kind: "created",
      receipt: acceptedFor(command),
    });
  read: (ref: DeliveryRef) => Promise<ReadReceiptResult> = async () => ({
    kind: "not-found",
  });

  async acceptMessage(
    command: AcceptMessageCommand,
  ): Promise<AcceptMessageResult> {
    this.calls.push("accept");
    this.acceptCalls.push(command);
    return this.accept(command);
  }

  async readReceipt(ref: DeliveryRef): Promise<ReadReceiptResult> {
    this.calls.push("read");
    this.readCalls.push(ref);
    return this.read(ref);
  }

  async applyReceiptEvidence(
    _evidence: ReceiptEvidence,
  ): Promise<ReceiptEvidenceResult | { kind: "not-found" }> {
    this.calls.push("apply-evidence");
    return { kind: "not-found" };
  }
}

class ScriptedAuthorization implements DeliveryAuthorizationPort<AuthContext, Address> {
  readonly calls: string[] = [];
  submit: DeliveryAuthorizationPort<AuthContext, Address>["authorizeSubmission"] =
    async () => ({
      kind: "allowed",
      identity: {
        sourceMachineId: "machine-a",
        workspaceId: "workspace-a",
        actorAccountId: "account-a",
      },
    });
  query: DeliveryAuthorizationPort<AuthContext, Address>["authorizeReceiptQuery"] =
    async () => ({ kind: "allowed" });

  async authorizeSubmission(
    actor: AuthContext,
    targetAddress: Address,
  ) {
    this.calls.push("authorize-submit");
    return this.submit(actor, targetAddress);
  }

  async authorizeReceiptQuery(actor: AuthContext, ref: DeliveryRef) {
    this.calls.push("authorize-query");
    return this.query(actor, ref);
  }
}

class ScriptedRouting implements DeliveryRoutingPort<Address> {
  readonly input: ({ workspaceId: string; targetAddress: Address } | undefined)[] =
    [];
  resolve: DeliveryRoutingPort<Address>["resolveTarget"] = async () => ({
    kind: "resolved",
    target: target(),
  });

  async resolveTarget(input: {
    workspaceId: string;
    targetAddress: Address;
  }) {
    this.input.push(input);
    return this.resolve(input);
  }
}

function setup() {
  const store = new ScriptedStore();
  const authorization = new ScriptedAuthorization();
  const routing = new ScriptedRouting();
  const calls: string[] = [];

  authorization.submit = async () => {
    calls.push("authorize");
    return {
      kind: "allowed",
      identity: {
        sourceMachineId: "machine-a",
        workspaceId: "workspace-a",
        actorAccountId: "account-a",
      },
    };
  };
  authorization.query = async () => {
    calls.push("authorize-query");
    return { kind: "allowed" };
  };
  routing.resolve = async () => {
    calls.push("resolve");
    return { kind: "resolved", target: target() };
  };

  const port = createDeliveryPort<AuthContext, Address>({
    authorization,
    routing,
    receiptStore: store,
  });

  return { port, store, authorization, routing, calls };
}

test("submit creates one exact immutable command and returns one result", async () => {
  const { port, store, calls } = setup();
  const actor = { actor: "session-a" };
  const message = { subject: "", body: "exact body" };

  const result = await port.submitMessage(
    actor,
    "machine-a.workspace-a.member-a",
    "request-a",
    message,
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    assert.fail("submission was not accepted");
  }
  assert.equal(result.disposition, "created");
  assert.equal(store.acceptCalls.length, 1);
  assert.equal(store.readCalls.length, 0);
  assert.deepEqual(calls, ["authorize", "resolve"]);

  const command = store.acceptCalls[0];
  assert.deepEqual(command.deliveryRef, deliveryRef());
  assert.deepEqual(command.target, target());
  assert.equal(command.kind, "message");
  assert.deepEqual(command.message, message);
  assert.equal(Object.hasOwn(command.message, "subject"), true);
  assert.equal(Object.isFrozen(command.deliveryRef), true);
  assert.equal(Object.isFrozen(command.target), true);
  assert.equal(Object.isFrozen(command.message), true);
  assert.equal(Object.isFrozen(result.receipt), true);
});

test("missing subject remains distinct from an empty subject", async () => {
  const { port, store } = setup();
  const actor = { actor: "session-a" };

  await port.submitMessage(
    actor,
    "member-a",
    "request-missing",
    { body: "body" },
  );
  await port.submitMessage(
    actor,
    "member-a",
    "request-empty",
    { subject: "", body: "body" },
  );

  assert.equal(store.acceptCalls.length, 2);
  assert.equal(Object.hasOwn(store.acceptCalls[0].message, "subject"), false);
  assert.equal(Object.hasOwn(store.acceptCalls[1].message, "subject"), true);
  assert.equal(store.acceptCalls[1].message.subject, "");
});

test("same requestId under different full refs remains isolated", async () => {
  const { port, store, authorization } = setup();
  authorization.submit = async (actor) => ({
    kind: "allowed",
    identity: {
      sourceMachineId: actor.actor === "a" ? "machine-a" : "machine-c",
      workspaceId: actor.actor === "a" ? "workspace-a" : "workspace-b",
      actorAccountId: actor.actor === "a" ? "account-a" : "account-b",
    },
  });

  await port.submitMessage(
    { actor: "a" },
    "member-a",
    "same-request",
    { body: "first" },
  );
  await port.submitMessage(
    { actor: "b" },
    "member-a",
    "same-request",
    { body: "second" },
  );

  assert.equal(store.acceptCalls.length, 2);
  assert.deepEqual(store.acceptCalls[0].deliveryRef, {
    sourceMachineId: "machine-a",
    workspaceId: "workspace-a",
    actorAccountId: "account-a",
    requestId: "same-request",
  });
  assert.deepEqual(store.acceptCalls[1].deliveryRef, {
    sourceMachineId: "machine-c",
    workspaceId: "workspace-b",
    actorAccountId: "account-b",
    requestId: "same-request",
  });
  assert.notDeepEqual(
    store.acceptCalls[0].deliveryRef,
    store.acceptCalls[1].deliveryRef,
  );
});

test("binding generation is a nonnegative safe integer and is not stringified", async () => {
  const invalidGenerations = [
    -1,
    1.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "7",
  ];

  for (const generation of invalidGenerations) {
    const { port, store, routing } = setup();
    routing.resolve = async () => ({
      kind: "resolved",
      target: {
        memberId: "member-a",
        machineId: "machine-b",
        bindingGeneration: generation as number,
      },
    });

    const result = await port.submitMessage(
      { actor: "session-a" },
      "member-a",
      "request-a",
      { body: "body" },
    );
    assert.equal(result.kind, "rejected");
    if (result.kind !== "rejected") {
      assert.fail("invalid generation was not rejected");
    }
    assert.equal(result.code, "INVALID_TARGET");
    assert.equal(store.acceptCalls.length, 0);
  }

  const { port, store, routing } = setup();
  routing.resolve = async () => ({
    kind: "resolved",
    target: target(Number.MAX_SAFE_INTEGER),
  });
  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );
  assert.equal(result.kind, "accepted");
  assert.equal(store.acceptCalls[0].target.bindingGeneration, Number.MAX_SAFE_INTEGER);
});

test("denied or revoked authorization stops before routing and every store call", async () => {
  const { port, store, authorization, routing } = setup();
  authorization.submit = async () => ({
    kind: "denied",
    errorRef: "grant-revoked",
  });

  const submitResult = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );
  assert.equal(submitResult.kind, "rejected");
  if (submitResult.kind !== "rejected") {
    assert.fail("denied submission did not return a rejection");
  }
  assert.equal(submitResult.code, "AUTHORIZATION_DENIED");
  assert.equal(submitResult.errorRef, "grant-revoked");
  assert.equal(routing.input.length, 0);
  assert.equal(store.calls.length, 0);

  authorization.query = async () => ({
    kind: "denied",
    errorRef: "grant-revoked",
  });
  const queryResult = await port.queryReceipt(
    { actor: "session-a" },
    deliveryRef(),
  );
  assert.equal(queryResult.kind, "denied");
  if (queryResult.kind !== "denied") {
    assert.fail("revoked query did not return denial");
  }
  assert.equal(queryResult.errorRef, "grant-revoked");
  assert.equal(store.readCalls.length, 0);
});

test("atomic acceptance outcomes map without a pre-read or invented receipt", async () => {
  const scenarios: Array<{
    result: AcceptMessageResult;
    expectedKind: "accepted" | "rejected" | "acceptance-unknown";
    expectedCode?: string;
  }> = [
    {
      result: { kind: "conflict" },
      expectedKind: "rejected",
      expectedCode: "DELIVERY_CONFLICT",
    },
    {
      result: { kind: "target-binding-stale" },
      expectedKind: "rejected",
      expectedCode: "TARGET_BINDING_STALE",
    },
    {
      result: { kind: "dedupe-window-expired" },
      expectedKind: "rejected",
      expectedCode: "DEDUPE_WINDOW_EXPIRED",
    },
    {
      result: {
        kind: "rejected-before-write",
        errorRef: "quota-rejected",
      },
      expectedKind: "rejected",
      expectedCode: "REJECTED_BEFORE_WRITE",
    },
    {
      result: {
        kind: "acceptance-unknown",
        errorRef: "commit-response-lost",
      },
      expectedKind: "acceptance-unknown",
    },
  ];

  for (const scenario of scenarios) {
    const { port, store } = setup();
    store.accept = async () => scenario.result;
    const result = await port.submitMessage(
      { actor: "session-a" },
      "member-a",
      "request-a",
      { body: "body" },
    );
    assert.equal(result.kind, scenario.expectedKind);
    assert.equal("receipt" in result, false);
    if (scenario.expectedCode !== undefined && result.kind === "rejected") {
      assert.equal(result.code, scenario.expectedCode);
    }
    assert.equal(store.readCalls.length, 0);
  }
});

test("replay returns the persisted receipt without resend or extra store access", async () => {
  const { port, store } = setup();
  store.accept = async (command) => ({
    kind: "replayed",
    receipt: acceptedFor(command),
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject", body: "body" },
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    assert.fail("replay did not return the persisted receipt");
  }
  assert.equal(result.disposition, "replayed");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.equal(store.acceptCalls.length, 1);
  assert.equal(store.readCalls.length, 0);
});

test("unexpected acceptance and read exceptions stay explicit and conservative", async () => {
  const { port, store } = setup();
  store.accept = async () => {
    throw new Error("unknown commit result");
  };
  const submit = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );
  assert.equal(submit.kind, "acceptance-unknown");
  assert.equal("receipt" in submit, false);

  store.read = async () => {
    throw new Error("store unavailable");
  };
  const query = await port.queryReceipt(
    { actor: "session-a" },
    deliveryRef(),
  );
  assert.equal(query.kind, "unavailable");
  assert.notEqual(query.kind, "not-found");
});

test("query authorizes the exact full ref before reading and preserves all outcomes", async () => {
  const { port, store, calls } = setup();
  const ref = deliveryRef({ workspaceId: "workspace-exact" });
  const receipt = createAcceptedReceipt(ref, target(), observedAt);
  store.read = async () => ({
    kind: "found",
    observation: {
      receipt,
      freshness: "fresh",
      observedAt,
    },
  });

  const found = await port.queryReceipt({ actor: "session-a" }, ref);
  assert.equal(found.kind, "found");
  if (found.kind !== "found") {
    assert.fail("receipt was not found");
  }
  assert.deepEqual(store.readCalls[0], ref);
  assert.deepEqual(found.observation.receipt.deliveryRef, ref);
  assert.deepEqual(calls, ["authorize-query"]);

  store.read = async () => ({ kind: "not-found" });
  assert.equal(
    (await port.queryReceipt({ actor: "session-a" }, ref)).kind,
    "not-found",
  );

  store.read = async () => ({
    kind: "unavailable",
    errorRef: "disk-unavailable",
  });
  const unavailable = await port.queryReceipt(
    { actor: "session-a" },
    ref,
  );
  assert.equal(unavailable.kind, "unavailable");
  assert.notEqual(unavailable.kind, "not-found");
});

test("application has no path that promotes weak acknowledgement evidence", async () => {
  const accepted = createAcceptedReceipt(
    deliveryRef(),
    target(),
    observedAt,
  );
  const result = applyReceiptEvidence(accepted, {
    kind: "app-ack",
    deliveryRef: deliveryRef(),
    target: target(),
    observedAt: "2026-11-03T10:01:00.000Z",
  });

  assert.equal(result.kind, "ignored");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.equal(result.receipt.outcome, "pending");
});

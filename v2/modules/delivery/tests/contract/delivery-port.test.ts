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
  AcceptedCommandReader,
  ReadAcceptedCommandResult,
} from "../../src/ports/accepted-command-reader.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRoutingPort,
  MessageDispatchCommand,
  MessageDispatchPort,
  MessageDispatchResult,
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
    "v1-msg-a",
  );
}

function remoteStoredReceipt(ref: DeliveryRef): Receipt {
  const accepted = createAcceptedReceipt(ref, target(), observedAt, "v1-msg-a");
  const result = applyReceiptEvidence(accepted, {
    kind: "remote-stored",
    deliveryRef: ref,
    target: target(),
    observedAt: "2026-11-03T10:01:00.000Z",
  });
  if (result.kind !== "applied") {
    throw new Error("expected remote-stored evidence to be applied");
  }
  return result.receipt;
}

class ScriptedStore implements ReceiptStore {
  readonly acceptCalls: AcceptMessageCommand[] = [];
  readonly readCalls: DeliveryRef[] = [];
  readonly evidenceCalls: ReceiptEvidence[] = [];
  readonly calls: string[] = [];
  accept: (command: AcceptMessageCommand) => Promise<AcceptMessageResult> =
    async (command) => ({
      kind: "created",
      receipt: acceptedFor(command),
    });
  read: (ref: DeliveryRef) => Promise<ReadReceiptResult> = async () => ({
    kind: "not-found",
  });
  apply: (
    evidence: ReceiptEvidence,
  ) => Promise<ReceiptEvidenceResult | { readonly kind: "not-found" }> =
    async (evidence) => {
      const accepted = createAcceptedReceipt(
        evidence.deliveryRef,
        evidence.target,
        observedAt,
        "v1-msg-a",
      );
      return applyReceiptEvidence(accepted, evidence);
    };

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
    evidence: ReceiptEvidence,
  ): Promise<ReceiptEvidenceResult | { kind: "not-found" }> {
    this.calls.push("apply-evidence");
    this.evidenceCalls.push(evidence);
    return this.apply(evidence);
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
  resume: NonNullable<
    DeliveryAuthorizationPort<AuthContext, Address>["authorizeResume"]
  > = async () => ({ kind: "allowed" });

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

  async authorizeResume(input: {
    actor: AuthContext;
    ref: DeliveryRef;
    target: DeliveryTarget;
  }) {
    this.calls.push("authorize-resume");
    return this.resume(input);
  }
}

class ScriptedAcceptedCommandReader implements AcceptedCommandReader {
  readonly calls: DeliveryRef[] = [];
  read: (ref: DeliveryRef) => Promise<ReadAcceptedCommandResult> = async (ref) => ({
    kind: "found",
    command: {
      deliveryRef: ref,
      target: target(),
      kind: "message",
      message: { subject: "subject-a", body: "body-a" },
      v1MessageId: "v1-msg-a",
    },
  });

  async readAcceptedCommand(ref: DeliveryRef): Promise<ReadAcceptedCommandResult> {
    this.calls.push(ref);
    return this.read(ref);
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
  type DispatchBehavior =
    | MessageDispatchResult
    | ((command: MessageDispatchCommand) => Promise<MessageDispatchResult>);
  let dispatchResult: DispatchBehavior = {
    kind: "remote-stored",
    observedAt: "2026-11-03T10:01:00.000Z",
  };
  const dispatch: MessageDispatchPort = {
    async dispatchMessage(command) {
      calls.push("dispatch");
      return typeof dispatchResult === "function"
        ? await dispatchResult(command)
        : dispatchResult;
    },
  };

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

  const acceptedCommand = new ScriptedAcceptedCommandReader();
  const port = createDeliveryPort<AuthContext, Address>({
    authorization,
    routing,
    dispatch,
    receiptStore: store,
    acceptedCommand,
  });

  return {
    port,
    store,
    authorization,
    routing,
    acceptedCommand,
    calls,
    setDispatchResult: (result: DispatchBehavior) => {
      dispatchResult = result;
    },
  };
}

test("submit creates one exact immutable command and returns one result", async () => {
  const { port, store, calls } = setup();
  const actor = { actor: "session-a" };
  const message = { subject: "exact subject", body: "exact body" };

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
  assert.deepEqual(calls, ["authorize", "resolve", "dispatch"]);

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

test("missing subject stays accepted and empty subject fails validation", async () => {
  const { port, store } = setup();
  const actor = { actor: "session-a" };

  const missing = await port.submitMessage(
    actor,
    "member-a",
    "request-missing",
    { body: "body" },
  );
  const empty = await port.submitMessage(
    actor,
    "member-a",
    "request-empty",
    { subject: "", body: "body" },
  );

  assert.equal(missing.kind, "dispatch-unavailable");
  if (missing.kind !== "dispatch-unavailable") {
    assert.fail("missing subject did not become dispatch-unavailable");
  }
  assert.equal(missing.errorRef, "SUBJECT_REQUIRED");
  assert.equal(missing.receipt.durableStage, "accepted");
  assert.equal(empty.kind, "rejected");
  if (empty.kind !== "rejected") {
    assert.fail("empty subject did not fail validation");
  }
  assert.equal(empty.code, "INVALID_INPUT");
  assert.equal(store.acceptCalls.length, 1);
  assert.equal(Object.hasOwn(store.acceptCalls[0].message, "subject"), false);
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
    { subject: "subject", body: "body" },
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
  const { port, store, calls } = setup();
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
  assert.deepEqual(calls, ["authorize", "resolve"]);
});

test("dispatch unavailable preserves the durable receipt for query", async () => {
  const { port, store, calls, setDispatchResult } = setup();
  setDispatchResult({
    kind: "unavailable",
    errorRef: "app-connection-unavailable",
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject", body: "body" },
  );

  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") {
    assert.fail("dispatch unavailable was not returned");
  }
  assert.equal(result.code, "DISPATCH_UNAVAILABLE");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.equal(store.acceptCalls.length, 1);
  assert.deepEqual(calls, ["authorize", "resolve", "dispatch"]);
});

test("successful dispatch returns the durable receipt through the public port", async () => {
  const { port, store, calls, setDispatchResult } = setup();
  setDispatchResult({
    kind: "remote-stored",
    observedAt: "2026-11-03T10:01:00.000Z",
  });
  store.read = async () => {
    const command = store.acceptCalls[0];
    return {
      kind: "found",
      observation: {
        receipt: acceptedFor(command),
        freshness: "fresh",
        observedAt,
      },
    };
  };

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject", body: "body" },
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    assert.fail("dispatched submission was not accepted");
  }
  assert.equal(result.disposition, "created");
  assert.equal(result.receipt.durableStage, "remote-stored");
  assert.deepEqual(calls, ["authorize", "resolve", "dispatch"]);
  assert.deepEqual(store.calls, ["accept", "apply-evidence"]);

  const query = await port.queryReceipt({ actor: "session-a" }, result.receipt.deliveryRef);
  assert.equal(query.kind, "found");
  if (query.kind !== "found") {
    assert.fail("dispatched receipt was not queryable");
  }
  assert.equal(query.observation.receipt.deliveryRef.requestId, "request-a");
  assert.deepEqual(
    calls,
    ["authorize", "resolve", "dispatch", "authorize-query"],
  );
  assert.deepEqual(store.calls, ["accept", "apply-evidence", "read"]);
  assert.equal(store.evidenceCalls.length, 1);
  assert.equal(store.evidenceCalls[0]?.kind, "remote-stored");
  assert.equal(store.evidenceCalls[0]?.observedAt, "2026-11-03T10:01:00.000Z");
});

test("successful protocol send with lost receipt evidence stays unknown", async () => {
  const { port, store, calls, setDispatchResult } = setup();
  setDispatchResult({
    kind: "remote-stored",
    observedAt: "2026-11-03T10:01:00.000Z",
  });
  store.apply = async () => ({
    kind: "unavailable",
    errorRef: "receipt-evidence-write-failed",
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject", body: "body" },
  );

  assert.equal(result.kind, "dispatch-unknown");
  if (result.kind !== "dispatch-unknown") {
    assert.fail("lost receipt evidence did not stay unknown");
  }
  assert.equal(result.code, "DISPATCH_UNKNOWN");
  assert.equal(result.errorRef, "receipt-evidence-write-failed");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.deepEqual(calls, ["authorize", "resolve", "dispatch"]);
  assert.deepEqual(store.calls, ["accept", "apply-evidence"]);
});

test("dispatch exception stays typed with an error chain and keeps the receipt", async () => {
  const { port, store, calls, setDispatchResult } = setup();
  setDispatchResult(async () => {
    throw new Error("app connection gone", {
      cause: new Error("socket hung up"),
    });
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject", body: "body" },
  );

  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") {
    assert.fail("dispatch exception was not typed");
  }
  assert.equal(result.code, "DISPATCH_UNAVAILABLE");
  assert.equal(result.errorRef, "delivery.dispatch.unavailable");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.ok(result.errorChain);
  assert.equal(result.errorChain[0]?.message, "app connection gone");
  assert.equal(result.errorChain[0]?.source, "delivery-message-dispatch");
  assert.equal(result.errorChain[1]?.message, "socket hung up");
  assert.equal(result.errorChain[1]?.source, "cause");
  assert.equal(store.acceptCalls.length, 1);
  assert.deepEqual(calls, ["authorize", "resolve", "dispatch"]);
  assert.deepEqual(store.calls, ["accept"]);
});

test("missing dispatch capability never fakes connected delivery", async () => {
  const { port, store, setDispatchResult } = setup();
  setDispatchResult({
    kind: "unavailable",
    errorRef: "no-public-send-port",
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );

  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") {
    assert.fail("missing dispatch did not return dispatch-unavailable");
  }
  assert.notEqual(result.kind, "accepted");
  assert.notEqual(result.code, "connected");
  assert.equal(result.receipt.durableStage, "accepted");
  assert.equal(store.acceptCalls.length, 1);
});

test("missing routing capability returns a typed unavailable result", async () => {
  const { port, store, calls, routing } = setup();
  routing.resolve = async () => {
    calls.push("resolve");
    return {
      kind: "unavailable",
      errorRef: "routing-resolver-offline",
    };
  };

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );

  assert.equal(result.kind, "routing-unavailable");
  if (result.kind !== "routing-unavailable") {
    assert.fail("missing routing did not return routing-unavailable");
  }
  assert.equal(result.code, "ROUTING_UNAVAILABLE");
  assert.equal(result.errorRef, "routing-resolver-offline");
  assert.equal("receipt" in result, false);
  assert.equal(store.acceptCalls.length, 0);
  assert.deepEqual(calls, ["authorize", "resolve"]);
});

test("wrong token, unauthorized workspace, and unknown member reject before write", async () => {
  const denied: Array<{ case: string; errorRef: string }> = [
    { case: "wrong-token", errorRef: "token-invalid" },
    { case: "unauthorized-workspace", errorRef: "workspace-not-authorized" },
  ];

  for (const scenario of denied) {
    const store = new ScriptedStore();
    const routing = new ScriptedRouting();
    const port = createDeliveryPort<AuthContext, Address>({
      authorization: {
        async authorizeSubmission() {
          return { kind: "denied", errorRef: scenario.errorRef };
        },
        async authorizeReceiptQuery() {
          return { kind: "allowed" };
        },
      },
      routing,
      dispatch: {
        async dispatchMessage() {
          assert.fail("denied submission must not dispatch");
        },
      },
      receiptStore: store,
    });
    const result = await port.submitMessage(
      { actor: "session-a" },
      "member-a",
      "request-a",
      { body: "body" },
    );
    assert.equal(result.kind, "rejected", scenario.case);
    if (result.kind !== "rejected") assert.fail(scenario.case);
    assert.equal(result.code, "AUTHORIZATION_DENIED", scenario.case);
    assert.equal(result.errorRef, scenario.errorRef, scenario.case);
    assert.equal(routing.input.length, 0, scenario.case);
    assert.equal(store.calls.length, 0, scenario.case);
  }

  const unknownStore = new ScriptedStore();
  const port = createDeliveryPort<AuthContext, Address>({
    authorization: {
      async authorizeSubmission() {
        return {
          kind: "allowed",
          identity: {
            sourceMachineId: "machine-a",
            workspaceId: "workspace-a",
            actorAccountId: "account-a",
          },
        };
      },
      async authorizeReceiptQuery() {
        return { kind: "allowed" };
      },
    },
    routing: {
      async resolveTarget() {
        return { kind: "not-found", errorRef: "member-unknown" };
      },
    },
    dispatch: {
      async dispatchMessage() {
        assert.fail("unknown member must not dispatch");
      },
    },
    receiptStore: unknownStore,
  });
  const unknown = await port.submitMessage(
    { actor: "session-a" },
    "member-missing",
    "request-a",
    { body: "body" },
  );
  assert.equal(unknown.kind, "rejected");
  if (unknown.kind !== "rejected") {
    assert.fail("unknown member did not return a rejection");
  }
  assert.equal(unknown.code, "TARGET_NOT_FOUND");
  assert.equal(unknown.errorRef, "member-unknown");
  assert.equal(unknownStore.calls.length, 0);
});

test("no production port method promotes consumed evidence", async () => {
  const { port } = setup();

  assert.equal("applyReceiptEvidence" in port, false);
  assert.equal(typeof (port as unknown as Record<string, unknown>).submitMessage, "function");
  assert.equal(typeof (port as unknown as Record<string, unknown>).queryReceipt, "function");
  assert.equal(typeof (port as unknown as Record<string, unknown>).resumeDispatch, "function");
  assert.equal(
    Object.keys(port).sort().join(","),
    "queryReceipt,resumeDispatch,submitMessage",
  );
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

test("resume dispatches the immutable accepted command after send authorization", async () => {
  const {
    port,
    store,
    authorization,
    acceptedCommand,
    calls,
    setDispatchResult,
  } = setup();
  const ref = deliveryRef();
  const dispatched: MessageDispatchCommand[] = [];
  const command = {
    deliveryRef: ref,
    target: target(),
    kind: "message",
    message: { subject: "subject-a", body: "body-a" },
    v1MessageId: "v1-msg-a",
  } as const;
  acceptedCommand.read = async () => ({ kind: "found", command });
  store.read = async (observed) => ({
    kind: "found",
    observation: {
      receipt: createAcceptedReceipt(observed, target(), observedAt),
      freshness: "fresh",
      observedAt,
    },
  });
  const seen: DeliveryTarget[] = [];
  authorization.resume = async (input) => {
    seen.push(input.target);
    return { kind: "allowed" };
  };
  setDispatchResult(async (input) => {
    dispatched.push(input);
    return {
      kind: "remote-stored",
      observedAt: "2026-11-03T10:01:00.000Z",
    };
  });

  const result = await port.resumeDispatch({ actor: "session-a" }, ref);
  assert.equal(result.kind, "resumed");
  if (result.kind !== "resumed") return;
  assert.deepEqual(result.receipt.deliveryRef, ref);
  assert.equal(result.receipt.durableStage, "remote-stored");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], command.target);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].message.subject, "subject-a");
  assert.equal(dispatched[0].message.body, "body-a");
  assert.deepEqual(dispatched[0].deliveryRef, ref);
  assert.deepEqual(dispatched[0].target, command.target);
  assert.equal(acceptedCommand.calls.length, 1);
  assert.deepEqual(authorization.calls, [
    "authorize-query",
    "authorize-resume",
  ]);
  assert.deepEqual(calls, ["authorize-query", "dispatch"]);
});

test("resume returns already-dispatched only for durable remote-stored evidence", async () => {
  const { port, store, setDispatchResult, calls } = setup();
  const ref = deliveryRef();
  setDispatchResult(async () => {
    assert.fail("durable remote-stored evidence must not re-dispatch");
  });
  store.read = async (observed) => ({
    kind: "found",
    observation: {
      receipt: remoteStoredReceipt(observed),
      freshness: "fresh",
      observedAt,
    },
  });

  const result = await port.resumeDispatch({ actor: "session-a" }, ref);
  assert.equal(result.kind, "already-dispatched");
  if (result.kind !== "already-dispatched") return;
  assert.equal(result.receipt.durableStage, "remote-stored");
  assert.deepEqual(result.receipt.deliveryRef, ref);
  assert.equal(calls.includes("dispatch"), false);
});

test("resume rejects a read-only actor before any dispatch", async () => {
  const { port, authorization, setDispatchResult } = setup();
  authorization.resume = async () => ({
    kind: "denied",
    errorRef: "query-only",
  });
  setDispatchResult(async () => {
    assert.fail("denied resume must not dispatch");
  });

  const result = await port.resumeDispatch(
    { actor: "session-a" },
    deliveryRef(),
  );
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "AUTHORIZATION_DENIED");
  assert.equal(result.errorRef, "query-only");
});

test("resume reports subject-required and never dispatches", async () => {
  const { port, acceptedCommand, setDispatchResult } = setup();
  const ref = deliveryRef();
  acceptedCommand.read = async () => ({
    kind: "found",
    command: {
      deliveryRef: ref,
      target: target(),
      kind: "message",
      message: { body: "body-a" },
    },
  });
  setDispatchResult(async () => {
    assert.fail("subject-required resume must not dispatch");
  });

  const result = await port.resumeDispatch({ actor: "session-a" }, ref);
  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") return;
  assert.equal(result.code, "DISPATCH_UNAVAILABLE");
  assert.equal(result.errorRef, "SUBJECT_REQUIRED");
});

test("resume without a command reader stays typed unavailable", async () => {
  const { authorization, routing, dispatch, store } = setup();
  const port = createDeliveryPort<AuthContext, Address>({
    authorization,
    routing,
    dispatch,
    receiptStore: store,
  });

  const result = await port.resumeDispatch(
    { actor: "session-a" },
    deliveryRef(),
  );
  assert.equal(result.kind, "resume-unavailable");
  if (result.kind !== "resume-unavailable") return;
  assert.equal(result.code, "RESUME_UNAVAILABLE");
  assert.equal(
    result.errorRef,
    "delivery.resume.accepted-command-unavailable",
  );
});

test("resume reports an unknown delivery", async () => {
  const { port, acceptedCommand, setDispatchResult } = setup();
  acceptedCommand.read = async () => ({ kind: "not-found" });
  setDispatchResult(async () => {
    assert.fail("unknown delivery must not dispatch");
  });

  const result = await port.resumeDispatch(
    { actor: "session-a" },
    deliveryRef(),
  );
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "DELIVERY_NOT_FOUND");
});

test("resume keeps the durable receipt when dispatch is unavailable", async () => {
  const { port, store, setDispatchResult } = setup();
  const ref = deliveryRef();
  store.read = async (observed) => ({
    kind: "found",
    observation: {
      receipt: createAcceptedReceipt(observed, target(), observedAt),
      freshness: "fresh",
      observedAt,
    },
  });
  setDispatchResult({ kind: "unavailable", errorRef: "gateway-unreachable" });

  const result = await port.resumeDispatch({ actor: "session-a" }, ref);
  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") return;
  assert.equal(result.code, "DISPATCH_UNAVAILABLE");
  assert.equal(result.errorRef, "gateway-unreachable");
  assert.equal(result.receipt?.durableStage, "accepted");
  assert.deepEqual(result.receipt?.deliveryRef, ref);
});

test("submit refuses to dispatch without the persisted v1MessageId", async () => {
  const { port, store, calls } = setup();
  store.accept = async (command) => ({
    kind: "created",
    receipt: createAcceptedReceipt(
      command.deliveryRef,
      command.target,
      observedAt,
    ),
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject-a", body: "body-a" },
  );
  assert.equal(result.kind, "dispatch-unavailable");
  if (result.kind !== "dispatch-unavailable") return;
  assert.equal(
    result.errorRef,
    "delivery.dispatch.v1-message-id-unavailable",
  );
  assert.equal(result.receipt.v1MessageId, undefined);
  assert.deepEqual(calls, ["authorize", "resolve"]);
});

test("submit keeps a possible-write dispatch result as typed unknown", async () => {
  const { port, setDispatchResult } = setup();
  setDispatchResult({
    kind: "unknown",
    errorRef: "result-loss-after-possible-write",
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { subject: "subject-a", body: "body-a" },
  );
  assert.equal(result.kind, "dispatch-unknown");
  if (result.kind !== "dispatch-unknown") return;
  assert.equal(result.code, "DISPATCH_UNKNOWN");
  assert.equal(result.errorRef, "result-loss-after-possible-write");
  assert.equal(result.receipt.durableStage, "accepted");
});

test("resume refuses to dispatch without the persisted v1MessageId", async () => {
  const { port, acceptedCommand, setDispatchResult } = setup();
  const ref = deliveryRef();
  acceptedCommand.read = async () => ({
    kind: "found",
    command: {
      deliveryRef: ref,
      target: target(),
      kind: "message",
      message: { subject: "subject-a", body: "body-a" },
      v1MessageId: "",
    },
  });
  setDispatchResult(async () => {
    assert.fail("missing v1MessageId must not dispatch");
  });

  const result = await port.resumeDispatch({ actor: "session-a" }, ref);
  assert.equal(result.kind, "resume-unavailable");
  if (result.kind !== "resume-unavailable") return;
  assert.equal(result.errorRef, "delivery.resume.v1-message-id-unavailable");
});

test("resume denies ref access before reading the accepted command", async () => {
  const { port, authorization, acceptedCommand, setDispatchResult } = setup();
  authorization.query = async () => ({
    kind: "denied",
    errorRef: "wrong-workspace",
  });
  setDispatchResult(async () => {
    assert.fail("denied ref access must not dispatch");
  });

  const result = await port.resumeDispatch(
    { actor: "session-a" },
    deliveryRef({ workspaceId: "workspace-other" }),
  );
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "AUTHORIZATION_DENIED");
  assert.equal(result.errorRef, "wrong-workspace");
  assert.equal(acceptedCommand.calls.length, 0);
});

test("resume never reads or dispatches another scope's command", async () => {
  const { port, authorization, acceptedCommand, setDispatchResult } = setup();
  authorization.resume = async () => ({ kind: "allowed" });
  authorization.query = async () => ({
    kind: "denied",
    errorRef: "cross-scope-ref",
  });
  setDispatchResult(async () => {
    assert.fail("cross-scope resume must not dispatch");
  });

  const result = await port.resumeDispatch(
    { actor: "session-b" },
    deliveryRef({ actorAccountId: "account-b" }),
  );
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "AUTHORIZATION_DENIED");
  assert.equal(result.errorRef, "cross-scope-ref");
  assert.equal(acceptedCommand.calls.length, 0);
});

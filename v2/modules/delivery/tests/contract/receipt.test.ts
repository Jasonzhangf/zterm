import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReceiptEvidence,
  createAcceptedReceipt,
} from "../../src/domain/receipt.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
  ReceiptEvidence,
} from "../../src/domain/receipt.ts";

const deliveryRef: DeliveryRef = {
  sourceMachineId: "machine-a",
  workspaceId: "workspace-a",
  actorAccountId: "account-a",
  requestId: "request-a",
};

const target: DeliveryTarget = {
  memberId: "member-a",
  machineId: "machine-b",
  bindingGeneration: 7,
};

const observedAt = "2026-11-03T10:00:00.000Z";

function strong(
  kind: "remote-stored" | "host-delivered" | "consumed",
  nextObservedAt: string,
): ReceiptEvidence {
  return {
    kind,
    deliveryRef,
    target,
    observedAt: nextObservedAt,
  };
}

test("receipt factory returns immutable accepted/pending with exact identity", () => {
  const receipt = createAcceptedReceipt(deliveryRef, target, observedAt);

  assert.deepEqual(receipt.deliveryRef, deliveryRef);
  assert.deepEqual(receipt.target, target);
  assert.equal(receipt.durableStage, "accepted");
  assert.equal(receipt.outcome, "pending");
  assert.equal(receipt.observedAt, observedAt);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.deliveryRef), true);
  assert.equal(Object.isFrozen(receipt.target), true);
});

test("strong evidence advances monotonically and confirms the stage", () => {
  const accepted = createAcceptedReceipt(deliveryRef, target, observedAt);
  const remote = applyReceiptEvidence(
    accepted,
    strong("remote-stored", "2026-11-03T10:01:00.000Z"),
  );

  assert.equal(remote.kind, "applied");
  if (remote.kind !== "applied") {
    assert.fail("remote evidence was not applied");
  }
  assert.equal(remote.receipt.durableStage, "remote-stored");
  assert.equal(remote.receipt.outcome, "confirmed");
  assert.equal(remote.receipt.observedAt, "2026-11-03T10:01:00.000Z");

  const host = applyReceiptEvidence(
    remote.receipt,
    strong("host-delivered", "2026-11-03T10:02:00.000Z"),
  );
  assert.equal(host.kind, "applied");
  if (host.kind !== "applied") {
    assert.fail("host evidence was not applied");
  }
  assert.equal(host.receipt.durableStage, "host-delivered");

  const regression = applyReceiptEvidence(
    host.receipt,
    strong("remote-stored", "2026-11-03T10:03:00.000Z"),
  );
  assert.equal(regression.kind, "ignored");
  assert.equal(regression.receipt, host.receipt);

  const duplicate = applyReceiptEvidence(
    host.receipt,
    strong("host-delivered", "2026-11-03T10:04:00.000Z"),
  );
  assert.equal(duplicate.kind, "ignored");
  assert.equal(duplicate.receipt, host.receipt);
});

test("error evidence preserves the proven stage and records current outcome", () => {
  const accepted = createAcceptedReceipt(deliveryRef, target, observedAt);
  const hostResult = applyReceiptEvidence(
    accepted,
    strong("host-delivered", "2026-11-03T10:01:00.000Z"),
  );
  assert.equal(hostResult.kind, "applied");
  if (hostResult.kind !== "applied") {
    assert.fail("host evidence was not applied");
  }

  const unknown = applyReceiptEvidence(hostResult.receipt, {
    kind: "unknown",
    deliveryRef,
    target,
    errorRef: "receipt-timeout",
    observedAt: "2026-11-03T10:02:00.000Z",
  });
  assert.equal(unknown.kind, "applied");
  if (unknown.kind !== "applied") {
    assert.fail("unknown evidence was not applied");
  }
  assert.equal(unknown.receipt.durableStage, "host-delivered");
  assert.equal(unknown.receipt.outcome, "unknown");
  assert.equal(unknown.receipt.errorRef, "receipt-timeout");

  const rejected = applyReceiptEvidence(unknown.receipt, {
    kind: "rejected",
    deliveryRef,
    target,
    errorRef: "host-rejected",
    observedAt: "2026-11-03T10:03:00.000Z",
  });
  assert.equal(rejected.kind, "applied");
  if (rejected.kind !== "applied") {
    assert.fail("rejected evidence was not applied");
  }
  assert.equal(rejected.receipt.durableStage, "host-delivered");
  assert.equal(rejected.receipt.outcome, "rejected");
  assert.equal(rejected.receipt.errorRef, "host-rejected");
});

test("weak acknowledgements and unverified consumption do not promote stages", () => {
  const accepted = createAcceptedReceipt(deliveryRef, target, observedAt);

  for (const kind of [
    "v1-delivered",
    "app-ack",
    "unverified-consumption",
  ] as const) {
    const result = applyReceiptEvidence(accepted, {
      kind,
      deliveryRef,
      target,
      observedAt: "2026-11-03T10:01:00.000Z",
    });
    assert.equal(result.kind, "ignored");
    assert.equal(result.receipt, accepted);
  }
});

test("evidence with a different full ref or target is an identity mismatch", () => {
  const accepted = createAcceptedReceipt(deliveryRef, target, observedAt);

  const changedRef = applyReceiptEvidence(accepted, {
    ...strong("remote-stored", "2026-11-03T10:01:00.000Z"),
    deliveryRef: {
      ...deliveryRef,
      workspaceId: "workspace-b",
    },
  });
  assert.equal(changedRef.kind, "identity-mismatch");

  const changedTarget = applyReceiptEvidence(accepted, {
    ...strong("remote-stored", "2026-11-03T10:01:00.000Z"),
    target: {
      ...target,
      bindingGeneration: 8,
    },
  });
  assert.equal(changedTarget.kind, "identity-mismatch");
});

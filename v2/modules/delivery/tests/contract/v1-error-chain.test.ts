import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeliveryPort,
} from "../../src/public/delivery-port.ts";
import type {
  AcceptMessageResult,
  DeliveryErrorChain,
  ReadReceiptResult,
  ReceiptStore,
} from "../../src/ports/receipt-store.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRoutingPort,
} from "../../src/ports/dependencies.ts";

type AuthContext = Readonly<{ actor: string }>;

const deliveryRef = {
  sourceMachineId: "machine-a",
  workspaceId: "workspace-a",
  actorAccountId: "account-a",
  requestId: "request-a",
} as const;

const target = {
  memberId: "member-a",
  machineId: "machine-b",
  bindingGeneration: 7,
} as const;

const chain: DeliveryErrorChain = [
  {
    code: "delivery.read.storage_error",
    message: "corrupt delivery record",
    source: "daemon-app-messaging-store",
  },
];

const authorization: DeliveryAuthorizationPort<AuthContext, string> = {
  async authorizeSubmission() {
    return {
      kind: "allowed",
      identity: {
        sourceMachineId: deliveryRef.sourceMachineId,
        workspaceId: deliveryRef.workspaceId,
        actorAccountId: deliveryRef.actorAccountId,
      },
    };
  },
  async authorizeReceiptQuery() {
    return { kind: "allowed" };
  },
};

const routing: DeliveryRoutingPort<string> = {
  async resolveTarget() {
    return { kind: "resolved", target };
  },
};

function storeWith(result: {
  accept?: AcceptMessageResult;
  read?: ReadReceiptResult;
}): ReceiptStore {
  return {
    async acceptMessage() {
      if (result.accept === undefined) {
        throw new Error("unexpected acceptance");
      }
      return result.accept;
    },
    async readReceipt() {
      if (result.read === undefined) {
        throw new Error("unexpected read");
      }
      return result.read;
    },
    async applyReceiptEvidence(): Promise<{ kind: "not-found" }> {
      throw new Error("unexpected evidence");
    },
  };
}

test("acceptance-unknown preserves the public error chain", async () => {
  const port = createDeliveryPort<AuthContext, string>({
    authorization,
    routing,
    receiptStore: storeWith({
      accept: {
        kind: "acceptance-unknown",
        errorRef: "delivery.accept.unknown#1",
        errorChain: chain,
      },
    }),
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );

  assert.equal(result.kind, "acceptance-unknown");
  if (result.kind !== "acceptance-unknown") {
    assert.fail("acceptance-unknown was not returned");
  }
  assert.equal(result.errorRef, "delivery.accept.unknown#1");
  assert.deepEqual(result.errorChain, chain);
});

test("unavailable query preserves the public error chain", async () => {
  const port = createDeliveryPort<AuthContext, string>({
    authorization,
    routing,
    receiptStore: storeWith({
      read: {
        kind: "unavailable",
        errorRef: "delivery.read.unknown#1",
        errorChain: chain,
      },
    }),
  });

  const result = await port.queryReceipt(
    { actor: "session-a" },
    deliveryRef,
  );

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") {
    assert.fail("unavailable was not returned");
  }
  assert.equal(result.errorRef, "delivery.read.unknown#1");
  assert.deepEqual(result.errorChain, chain);
});

const throwingStore: ReceiptStore = {
  async acceptMessage() {
    throw new Error("unknown commit result", {
      cause: new Error("disk write failed"),
    });
  },
  async readReceipt() {
    throw new Error("store unavailable", {
      cause: new Error("socket hung up"),
    });
  },
  async applyReceiptEvidence(): Promise<never> {
    throw new Error("store unavailable", {
      cause: new Error("socket hung up"),
    });
  },
};

test("unexpected acceptance exception preserves message and nested cause", async () => {
  const port = createDeliveryPort<AuthContext, string>({
    authorization,
    routing,
    receiptStore: throwingStore,
  });

  const result = await port.submitMessage(
    { actor: "session-a" },
    "member-a",
    "request-a",
    { body: "body" },
  );

  assert.equal(result.kind, "acceptance-unknown");
  if (result.kind !== "acceptance-unknown") {
    assert.fail("unexpected acceptance was not acceptance-unknown");
  }
  assert.equal("receipt" in result, false);
  assert.ok(result.errorChain);
  assert.equal(result.errorChain[0]?.message, "unknown commit result");
  assert.equal(result.errorChain[0]?.source, "delivery-receipt-store");
  assert.equal(result.errorChain[1]?.message, "disk write failed");
  assert.equal(result.errorChain[1]?.source, "cause");
});

test("unexpected read exception preserves message and nested cause", async () => {
  const port = createDeliveryPort<AuthContext, string>({
    authorization,
    routing,
    receiptStore: throwingStore,
  });

  const result = await port.queryReceipt({ actor: "session-a" }, deliveryRef);

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") {
    assert.fail("unexpected read was not unavailable");
  }
  assert.ok(result.errorChain);
  assert.equal(result.errorChain[0]?.message, "store unavailable");
  assert.equal(result.errorChain[0]?.source, "delivery-receipt-store");
  assert.equal(result.errorChain[1]?.message, "socket hung up");
  assert.equal(result.errorChain[1]?.source, "cause");
});

test("receiptStore rejections with undefined or null stay typed and isolated", async () => {
  for (const thrown of [undefined, null]) {
    const port = createDeliveryPort<AuthContext, string>({
      authorization,
      routing,
      receiptStore: {
        async acceptMessage() {
          throw thrown;
        },
        async readReceipt() {
          throw thrown;
        },
        async applyReceiptEvidence(): Promise<never> {
          throw thrown;
        },
      },
    });

    const submit = await port.submitMessage(
      { actor: "session-a" },
      "member-a",
      "request-a",
      { body: "body" },
    );
    assert.equal(submit.kind, "acceptance-unknown");
    if (submit.kind !== "acceptance-unknown") {
      assert.fail("undefined/null acceptance was not acceptance-unknown");
    }
    assert.equal("receipt" in submit, false);
    assert.ok(submit.errorChain);
    assert.equal(submit.errorChain[0]?.code, "delivery.accept.unknown");
    assert.equal(submit.errorChain[0]?.message, String(thrown));
    assert.equal(submit.errorChain[0]?.source, "delivery-receipt-store");

    const query = await port.queryReceipt(
      { actor: "session-a" },
      deliveryRef,
    );
    assert.equal(query.kind, "unavailable");
    if (query.kind !== "unavailable") {
      assert.fail("undefined/null read was not unavailable");
    }
    assert.ok(query.errorChain);
    assert.equal(query.errorChain[0]?.code, "delivery.read.unknown");
    assert.equal(query.errorChain[0]?.message, String(thrown));
    assert.equal(query.errorChain[0]?.source, "delivery-receipt-store");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { asTypedError, TypedError } from "../src/typed-error.mjs";

test("typed errors preserve owner, operation and cause", () => {
  const error = new TypedError({
    code: "TARGET_NOT_FOUND",
    owningModule: "host-adapters",
    operationId: "capture",
    cause: "target does-not-exist",
    message: "Terminal target was not found.",
  });

  assert.deepEqual(error.toJSON(), {
    code: "TARGET_NOT_FOUND",
    owningModule: "host-adapters",
    operationId: "capture",
    cause: "target does-not-exist",
    message: "Terminal target was not found.",
  });
  assert.equal(asTypedError(error, {}), error);
});

test("plain errors become the declared typed error", () => {
  const error = asTypedError(new Error("socket closed"), {
    code: "DAEMON_FAILURE",
    owningModule: "daemon",
    operationId: "request",
    message: "The request failed.",
  });

  assert.equal(error.code, "DAEMON_FAILURE");
  assert.equal(error.owningModule, "daemon");
  assert.equal(error.cause, "socket closed");
});

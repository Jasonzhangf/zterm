# terminal admission real product composition scope

Date: 2026-11-07
Parent task: `terminal-admission-composition-1107`
Status: scope for Jenny routing; implementation is not authorized by this file

## Purpose

Replace the dev-auth, simulated-mux matrix with evidence from the supported V2
product startup and real owner modules. Preserve the existing module and HTTP
receipts. Do not treat the current fixture matrix as composition acceptance.

## Reuse

- Accepted accounts workspace/machine authorization adapters:
  `accounts-workspace-auth-adapters-1106`.
- Accepted connections catalog edge and shared runtime prerequisites:
  `2f82ddf4`, `03d3de3a`.
- Accepted binding contract:
  `/Volumes/extension/code/zterm/tmp/v2-webui-audit/terminal-binding-contract-decision-20261107.md`.
- Existing members `terminalTarget` persistence and
  `resolveBindingTarget({binding, catalog})`.
- Existing daemon admission ordering, typed refusals, raw-input semantics, and
  machine-terminal consumer.

## Required routing

1. daemon production composition owner: wire a supported startup/config path
   that assembles accounts, organization/members/routing, connections,
   machine-scoped terminal consumer, and terminal admission. Missing required
   production dependencies must return a typed unavailable result. They must
   not select a token-only legacy path.
2. members/host adapter owner: provide the public launch/restore/explicit-bind
   producer that observes and persists the exact `{backend, stableId}` target
   for the member binding generation.
3. connections owner: confirm the public machine-scoped catalog and terminal
   channel APIs are sufficient for the daemon consumer. If a signature is
   missing, return the exact owner and signature gap before implementation.
4. Jenny: integrate accepted prerequisites on the local composition base and
   route the above owners. No remote push, PR, publish, shared-service restart,
   or production deployment.

## Product startup contract

The supported command must start the daemon through `v2/modules/daemon/src/main.mjs`
or a declared equivalent entry. It must accept configuration that identifies
the real accounts authority, persistent control-plane stores, V1 connection
endpoint, and V2 bind settings without test seeds or automatic diagnostics.

The receipt must show the exact command, redacted configuration source, and
the listening process. Missing accounts/connections/admission composition must
fail before a terminal route serves a request.

## Real acceptance sequence

1. Login and grant
   - Authenticate a real account through the accepted accounts adapter.
   - Authorize the target machine and verify the handshake `daemonHostId`.
2. Bind
   - Invoke the public host binding producer at launch, restore, or explicit
     bind.
   - Persist the exact terminal target in the current members binding
     generation. Do not infer it from session name, anchor, or request data.
3. Committed body frame
   - Open the daemon terminal stream through its public HTTP route.
   - Wait for a committed frame containing known terminal output from the
     selected session.
   - `event: ready`, HTTP 200, or a fixture frame does not satisfy this step.
4. Real input execution
   - Send an actual CR byte (`0x0d`), not the two literal characters `\` and
     `r`.
   - Execute a command whose output contains a unique marker that cannot be
     satisfied by input echo.
   - Capture the returned stream body or tmux output as the execution receipt.
5. Real revocation
   - Revoke the accounts machine grant while the transport remains connected.
   - Reject the next stream or input with the owner's typed error and zero new
     channel opens or input writes.
   - Closing the fixture socket is only disconnect evidence, not revocation.
6. Refusal regression
   - Wrong machine, wrong daemon identity, old binding generation after rebind,
     unrelated existing target, missing target, and missing production
     dependency must fail closed with zero terminal side effects.

## Evidence

Store raw commands, redacted configuration, process/listening receipt,
login/grant receipt, binding record, committed frame, execution output,
revocation receipt, and each refusal result in this evidence directory. Mark
secrets as redacted. Keep module tests separate from product composition
evidence.

## Non-goals

No Board/tickets work, no two-machine E2E, no Android/device action, no shared
service mutation, no merge to remote, no PR, and no publish.

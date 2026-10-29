# CLI cross-machine messaging and file delivery

Status: accepted for implementation

## Scope

Provide a non-interactive zterm CLI transport that Collab can use to deliver
structured messages and files between two authenticated zterm daemons. Collab
keeps ownership of CEO/master identities, recipient routing, business
persistence, queueing, and consumption. zterm owns device discovery,
authentication, transport, durable inbox storage, file landing, transfer
receipts, and connection status.

This increment does not add Collab roles to zterm. It does not simulate
terminal keystrokes, require a terminal session, or start/stop tmux.

## Ownership

- `shared.app_protocol` in `packages/shared/src/connection/app-protocol.ts`
  owns the versioned wire frames, payload validation, limits, and stable IDs.
- `daemon.app_messaging` in `android/src/server/daemon-app-messaging-runtime.ts`
  owns the persistent inbox/outbox, delivery state transitions, deduplication,
  peer WebSocket connections, and push fan-out.
- `daemon.app_gateway` in
  `android/src/server/daemon-app-websocket-runtime.ts` owns only the authenticated
  `/app` WebSocket admission, handshake, framing, connection lifetime, and
  backpressure. It delegates business state to `daemon.app_messaging`.
- `cli.app_messaging` in `packages/cli/src/commands/app-messaging.ts` owns CLI
  argument parsing, endpoint discovery through the existing account directory,
  the local CLI-daemon stream, machine-readable output, and exit codes.
- `daemon.connection_gateway` keeps its existing network listener and auth
  token. `/app` is a separate WebSocket endpoint on the same HTTP server and
  auth boundary. It must not reuse terminal channel/session state.
- `client.cli` owns registration of the new CLI modules and public help text.

The daemon does not infer Collab role, CEO, master, or business consumption.

## DAG

The implementation adds one SESE graph:

```text
CLI target
  -> resolve authenticated device endpoint
  -> CLI local /app handshake
  -> daemon outbound peer /app handshake
  -> remote daemon persist message or complete file
  -> remote daemon push inbound event to local subscribers
  -> remote daemon returns transport receipt
  -> local daemon returns correlated send result to CLI
  -> CLI emits structured event

Inbound recovery:
  -> authenticated /app handshake
  -> replay unacknowledged durable records
  -> Collab enqueue ack
  -> later consume ack

Failure exits:
  -> unreachable
  -> unauthorized/rejected
  -> inbox full
  -> transfer incomplete
  -> result unknown
```

Graph artifact: `android/docs/dagpipe/daemon-app-messaging.graph.json`.
The graph must remain single-entry/single-exit. Terminal error responses are
terminal exits for the affected request, not edges back to admission.

## Public CLI

```text
zterm app stream [--json]
zterm app send --peer <deviceId> [--daemon-host-id <hostId>] \
  [--message-id <id>] --subject <text> --body <text>
zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] \
  [--message-id <id>] --file <path> [--subject <text>]
zterm app status --message-id <id> [--sender-daemon-host-id <hostId>] \
  [--remote --peer <deviceId>]
zterm app ack --message-id <id> [--sender-daemon-host-id <hostId>]
zterm app consume --message-id <id> [--sender-daemon-host-id <hostId>]
```

`stream` is the normal Collab integration. It establishes one persistent local
WebSocket to the local daemon, performs one handshake, then emits newline
delimited JSON events. It accepts newline delimited JSON commands on stdin for
send, file send, ack, consume, and status. It never polls for inbound messages.

The stream handshake includes `protocolVersion`, `clientInstanceId`, `deviceId`,
`daemonHostId`, and capabilities. The daemon replies once with `app-ready`.
Connection state and errors are pushed on the same stream. The stream exits
non-zero only when the initial handshake fails or stdin closes; a later peer
disconnect is an event and may recover without hiding the durable record.
The local daemon stream is a physical connection: an unrequested `app-error`
such as `slow_consumer` and the physical `close` code/reason are emitted as
events, so the caller can reopen a stream and replay unacked records.

`send` and `send-file` are one-shot wrappers over the same local protocol. They
use a stable message ID. If the connection closes after transmission but before
a receipt, they return `resultUnknown` and preserve the ID for safe retry.

## Wire protocol

Protocol version: `1`.

Client frames:

```text
app-hello
app-send-message
app-send-file-start
app-send-file-chunk
app-send-file-commit
app-ack
app-consume
app-status
app-ping
```

Server frames:

```text
app-ready
app-inbound-message
app-inbound-file
app-send-result
app-status-result
app-connection-state
app-error
app-pong
```

`app-hello.role` is `local` or `peer`. A local connection may subscribe and
send. A peer connection may only deliver or query by stable message ID; it may
not read the remote inbox. Every request has a caller-generated `requestId`.
Message and file transfers have a stable `messageId` or `transferId`.

Capabilities include:

```json
{
  "serverName": "zterm.app",
  "protocolVersion": 1,
  "messages": true,
  "files": true,
  "durableInbox": true,
  "push": true,
  "ackStates": ["delivered", "consumed"],
  "resumeFileTransfer": true,
  "maxMessageBytes": 1048576,
  "maxFileBytes": 268435456,
  "fileChunkBytes": 16384
}
```

Authentication uses the existing daemon token in the `Authorization: Bearer`
header. Tokens must never appear in command arguments, JSON output, events, or
logs. The existing URL token compatibility remains unchanged for terminal
clients, but new CLI code should use the header.

## Durable records and state

Daemon root:

```text
~/.zterm/app-inbox/
  records/<encoded-sender-daemon-host-id>/<encoded-message-id>/record.json
  files/<encoded-sender-daemon-host-id>/<encoded-message-id>/<safe-file-name>
  staging/<encoded-sender-daemon-host-id>/<encoded-transfer-id>/meta.json
  staging/<encoded-sender-daemon-host-id>/<encoded-transfer-id>/data.part
~/.zterm/app-outbox/
  records/<encoded-target-daemon-host-id>/<encoded-message-id>/record.json
```

The public `messageId` and `transferId` do not change. A path segment uses
base64url without padding over the UTF-8 identity bytes. Empty identities and
identities longer than 191 UTF-8 bytes are rejected, so each encoded segment is
at most 255 ASCII bytes, which is exactly the file-system `NAME_MAX` for one
path component. An identity therefore owns a directory and every durable file
name below it is a fixed short name (`record.json`, `meta.json`, `data.part`);
no `.json` or `.part` suffix is appended to an encoded identity. Raw network
identity values are never concatenated into a path. Inbox and file assets are
partitioned by sending daemon; Outbox records are partitioned by target daemon.
The safe file name remains a validated single basename and cannot escape its
message directory.

Inbox record states:

- `received`: complete data is durably stored and pushed to subscribers.
- `delivered`: the local Collab consumer acknowledged durable enqueue.
- `consumed`: the local Collab consumer acknowledged business consumption.
- `rejected`: explicitly rejected before acceptance.

Transport receipt means `received`. It never means `delivered` or `consumed`.

The record key is `(senderDaemonHostId, messageId)`. Repeated sends with the
same key and identical content are idempotent and return the current status.
The same key with different content fails with `message_id_conflict`.

Unacknowledged records are replayed after a stream or daemon restart. A
replayed record retains one stable message ID; it is not duplicated in the
inbox. Acknowledgement is monotonic: `received -> delivered -> consumed`.
A late lower-state acknowledgement is an idempotent no-op.

Limits:

- Max message body: 1 MiB.
- Max file: 256 MiB.
- Max safe file name: 255 bytes after sanitization.
- File chunk: 16 KiB.
- Max durable inbox: 512 records or 2 GiB, whichever comes first.
- Acked/consumed record retention: 7 days; unacknowledged data is never
  silently evicted. If admission would exceed the inbox limit, return
  `inbox_full`; the sender must report the failure.
- Slow-consumer pending limit: 4 MiB of application-undelivered inbound work
  per local stream, with a 20 second grace period. Pending bytes count the
  serialized durable inbound events sent to that stream and not yet
  acknowledged or consumed by the application. Pending messages count distinct
  unacknowledged `(senderDaemonHostId, messageId)` keys, so two senders that
  reuse one `messageId` stay independent. An event's pending age starts when it
  is enqueued to the stream. `last_progress_ms` advances only on a settled ACK
  or consume, never on a rejected or failing one.
- Close the local stream with code `4008` and reason `slow_consumer` only when
  pending bytes exceed 4 MiB, the oldest pending event exceeds the grace
  period, and there has been no ACK progress. Send `app-error` with code
  `slow_consumer` before the close while the socket is open. A matching ACK or
  consume, or dropping below the limit, clears the closure condition. A late
  ACK is idempotent.
- Transport buffering, including `ws.bufferedAmount`, is not the closure
  signal. Loopback kernel buffering must not hide an application that has
  stopped acknowledging inbound events.
- `4008` closes only the stream. It does not delete durable inbox records or
  files and does not change `received` state. A fresh stream replays the
  unacknowledged records once.

Records and file metadata use write-temp, fsync, and rename. Files are not
published until chunk count, total bytes, and SHA-256 match. `.part` files are
never returned as inbound files. A resumed transfer uses the same transfer ID
and byte offset. Duplicate chunks at the already persisted offset are accepted
idempotently; conflicting bytes fail.

An interrupted atomic write leaves a `.tmp-<uuid>.json` sibling. Temp files are
never published: enumeration, recovery, retention, replay, and capacity count
only the formal `record.json` and `meta.json` files. A corrupt formal file still
fails loudly instead of being skipped. Durable inbox byte usage counts the
UTF-8 bytes of persisted message bodies plus landed files and staging
reservations; a same-id retry does not consume capacity a second time.

The sending daemon binds each outbound file transfer to the local connection
that started it, and checks the bound `messageId` before forwarding any chunk or
commit. Two local CLIs may therefore use the same `--message-id` (and so the
same derived `transferId`) for different peers. One connection cannot rebind a
live `transferId` to another message or target; that request fails with
`transfer_conflict` instead of replacing the route. The outbox keeps its
per-target partition, and the CLI stays free of routing state.

Commit recovery distinguishes "part missing" from "part length 0". A verified
entry with a complete part is renamed and published again after a restart. A
verified entry whose inbox record already exists is released only when the
record describes the same file; a mismatch is reported as `storage_inconsistent`
and never overwrites the record. Retention therefore never leaves an orphaned
staging reservation that would block later `/app` admission.

## Delivery lifecycle

1. CLI obtains the current account directory and resolves exactly one target
   `deviceId` and `daemonHostId`.
2. CLI connects to the local daemon `/app` with the existing daemon token.
3. Local daemon opens one outbound `/app` WebSocket to the target daemon using
   the target endpoint from the authenticated account directory.
4. Both sides exchange `app-hello` and `app-ready`.
5. The remote daemon persists a message or completes an atomic file.
6. The remote daemon pushes the inbound event to all authenticated local
   subscribers and returns a transport receipt.
7. The local daemon returns a correlated result to the CLI stream.
8. Collab enqueues the event locally and sends `app-ack`; business consumption
   later sends `app-consume`.

On disconnect before a receipt, the CLI reports `resultUnknown` and keeps a
local outbox record. It does not blindly resend. A later retry uses the same
message ID; the remote daemon returns the existing record status. If the
target daemon is offline, report `unreachable`. No relay offline queue is
claimed by this increment.

## Security and file policy

- Every `/app` connection requires the target daemon token.
- The CLI passes only an authenticated account-directory endpoint to the local
  daemon. Tokens are never written to app records.
- Peer connections cannot enumerate other peers' inboxes.
- File names are sanitized to a single basename. Path traversal is rejected.
- Received files land under the daemon-owned inbox only. The receiver gets the
  absolute path and may copy it after `delivered`; arbitrary destination paths
  are not accepted over the wire.
- File metadata includes byte length and SHA-256. Completion is reported only
  after both the chunk contract and the final file stat/hash match.
- Message bodies preserve newlines and arbitrary JSON strings.
- No terminal session, tmux action, resize, or input injection is part of this
  path.

## Architecture mapping

Task classification: `补链`.

- Graph: `daemon-app-messaging.graph.json`.
- Unique owners: `daemon.app_messaging`, `daemon.app_gateway`,
  `shared.app_protocol`, `cli.app_messaging`.
- Allowed cross-module edge: CLI -> daemon `/app`; daemon peer -> remote
  `/app`; daemon store -> local subscribers. No terminal channel edge.
- Required gates: shared protocol tests, daemon store/gateway tests,
  two-daemon real WebSocket E2E, CLI build/type-check, installed CLI black box,
  feature registry/import graph, and `git diff --check`.
- Non-goals: Collab role logic, terminal session transport, tmux lifecycle,
  relay-host offline queue, mobile UI changes, production daemon restart.

## Acceptance

1. With two isolated real daemon processes on different ports:
   - A local CLI sends a multiline message to B while B has no CLI running.
   - B daemon persists it and returns a transport receipt.
   - Starting B's CLI stream receives it by push, with no polling.
   - Ack-before-disconnect and restart replay produce one record.
2. The same two daemons deliver a file in both directions. B's file is absent
   until commit, then exists with matching bytes and SHA-256. A broken transfer
   can resume and complete; incomplete files are never published.
3. Deduplication proves identical retry is idempotent and conflicting content
   is rejected.
4. Offline target, unauthorized token, inbox limit, slow consumer, and daemon
   restart produce distinguishable states rather than false success.
5. The packed and installed `zterm` executable runs the documented commands
   and emits parseable JSON.
6. A two-machine isolated deployment on the Mac and Studio host is required
   before claiming cross-machine delivery. Production daemon replacement is
   not part of this task unless separately authorized.

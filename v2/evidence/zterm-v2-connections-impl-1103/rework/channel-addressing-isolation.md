# Real consumer: channel addressing and isolation (R4)

Evidence kinds kept separate: a real `ws` WebSocketServer that speaks the real
V1 mux wire protocol, and read-only black-box against the running product daemon.
Loopback is explicitly labelled, not presented as a two-machine proof.

## Positive: real remote open/ack (product daemon)

`tests/integration/real-daemon.test.ts`, "opens an existing terminal channel
through real mux open/ack and closes it":

- reads the real `list-sessions` catalog from `192.168.0.3:3333` and takes an
  existing tmux `stableId`;
- `manager.openChannel(link, "terminal", { sessionName, backend: "tmux",
  expectedSessionIdentity: stableId, existingOnly: true, bodySubscribed: false })`;
- the daemon replies `mux-channel-opened` (channel id + sessionName + stableId +
  reliableInput capability) before the V2 ChannelRef exists;
- `closeChannel` releases it; `observeLink` still returns `connected`.

No cols/rows are sent, so no tmux geometry is written; `bodySubscribed:false`
means no body capture and no tmux content write.

## Positive: addressed delivery and sibling isolation (real ws fixture)

- `tests/integration/real-entry.test.ts`, "isolates two accepted terminal
  channels by address": opens two terminal channels on one physical link; the
  server delivers `mux-channel-message` only on the accepted `channelId`; only
  the addressed consumer receives it; closing one keeps the sibling usable.
- `tests/contract/connection-manager.contract.test.ts`, "isolates channels":
  opening is real (fake transport records the open request) and an orphan
  address reaches no consumer.

## Negative: unsupported and rejected targets

- `message/file/receipt/status` on a terminal mux link throw
  `unsupported_channel`; the link stays connected (both contract and real
  daemon tests).
- `mux-channel-open` for an unknown session returns `mux-channel-closed`, mapped
  to `link_closed`; the link stays connected.
- Wrong token: the real bridge sends `{type:"error",payload:{code:"unauthorized"}}`
  then closes 4001; the adapter classifies it `unauthorized`.

## Wire frames actually exercised

- Handshake: `mux-hello` -> `mux-ready` (real daemon omits `daemonHostId`).
- Open: `mux-channel-open { channelId, sessionName, backend,
  expectedSessionIdentity, existingOnly, bodySubscribed }` -> `mux-channel-opened
  { channelId, sessionName, stableId, capabilities }`.
- Send only after accept: `mux-channel-binary { channelId, dataBase64 }`.
- Close: `mux-channel-close { channelId, reason }`.

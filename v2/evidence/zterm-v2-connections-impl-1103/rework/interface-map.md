# Connections rework R4: public interface mapping and real consumer

Task: `zterm-v2-connections-impl-1103` rework (rev16). Scope:
`v2/modules/connections/**` and `v2/evidence/zterm-v2-connections-impl-1103/**`.

## Public surface

| Entry | Owner | Rework behavior |
| --- | --- | --- |
| `connect(machineId, verifiedAuthorization?) -> LinkRef` | `application/connection-manager.ts` | Opens transport; on failure checks current generation before writing link state. |
| `observeLink(LinkRef) -> LinkObservation` | `application/connection-manager.ts` | Real path/status/freshness from the transport, never assumed. |
| `openChannel(LinkRef, kind, target?) -> Promise<ChannelRef>` | `application/connection-manager.ts` -> `channels/dispatch.ts` | Async. Checks peer-declared kinds; for terminal sends real `mux-channel-open` and waits for `mux-channel-opened`. Only after ack does it register and return the ChannelRef. |
| `onChannelMessage(ChannelRef, handler) -> unsubscribe` | `application/connection-manager.ts` -> `channels/dispatch.ts` | Delivers only frames addressed to that channel. |
| `sendChannel(ChannelRef, data)` | `application/connection-manager.ts` -> `channels/dispatch.ts` | Only accepted channels; writes legal addressed envelope. |
| `closeChannel` / `closeOwnLink` | `application/connection-manager.ts` | Local isolation; sibling channel and link stay usable. |

## Transport port

| Member | Meaning |
| --- | --- |
| `openChannel(request)` | For `terminal`, sends `mux-channel-open` and waits for remote ack. Generic kinds reject `unsupported_channel` immediately. |
| `peerChannelKinds` | `["terminal"]` when `channelEnvelope === true`; never generic message/file from terminal mux. |
| `sendChannel(channelId, data)` | Writes `mux-channel-binary { channelId, dataBase64 }` only on an accepted channel. |
| `onChannelMessage(handler)` | Delivers addressed `mux-channel-binary` / `mux-channel-message` frames by `channelId`. |

## Terminal mux capability mapping (R4 truth)

| Real mux capability | V2 channel kind | Otherwise |
| --- | --- | --- |
| `channelEnvelope === true` | `terminal` (requires real target open/ack) | no channel |
| `bulkChannel` present | NOT `file`; transport capability only | no generic file |
| (never declared) | `message`, `file`, `receipt`, `status` | `unsupported_channel` |

The previous mapping treated `channelEnvelope` as `message` and `bulkChannel` as
`file`. That was wrong: those are terminal mux transport capabilities, not
business service declarations. `message`/`file` belong to the separate V1 `/app`
service (Bearers, app-hello/app-ready) and are not wired in this increment.

## Real consumer evidence

- `tests/integration/real-daemon.test.ts` against running daemon
  `192.168.0.3:3333`: connect -> connected/direct/`["terminal"]`;
  generic kinds all `unsupported_channel`; real `mux-channel-open` for an
  existing tmux session returns `mux-channel-opened`; close leaves link
  connected; wrong token classified `unauthorized`.
- Logs: `rework/real-daemon-vitest.log`, `rework/final-vitest.log`,
  `rework/final-tsc.log`.

## Not implemented (honest boundaries)

- Generic message/file/receipt/status service: separate V1 `/app`; only the
  codec boundary exists in `adapters/app-websocket.ts`. Not mixed into mux.
- Cross-machine independent-LAN E2E: not run by this worker; remains for Jenny
  integration.

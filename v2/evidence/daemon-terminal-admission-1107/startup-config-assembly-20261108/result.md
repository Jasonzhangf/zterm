# startup-config assembly real black box

## Result

BLOCKED. The production entry `node v2/modules/daemon/src/main.mjs --config <file>` assembled accounts, organization, members, routing, connections, host adapter, terminal, and admission. An authorized member input was admitted and submitted. The marker did not appear in the real tmux capture, so positive terminal output is not proven.

## Positive path

- Entry: `node v2/modules/daemon/src/main.mjs --config <redacted path>`
- Stream returned HTTP 200 with an admitted `ready` event.
- Input returned HTTP 200 with `accepted: true`.
- Unique marker seen in real tmux capture: false.
- Receipts: `green-stream-ready.json`, `green-input-response.json`, `green-input-output.json`, `green-tmux-capture.txt`.
- Blocker: the V1 traversal adapter sends terminal input as `mux-channel-binary`, but the V1 terminal mux runtime treats terminal input as `mux-channel-message` and binary frames as file transfer. The daemon cannot send that message shape through the current connections public edge, so the marker does not reach the shell.

## Typed failures

| Case | Status | Error code | Zero side effect |
|---|---:|---|---|
| missing config | 503 | TERMINAL_ADMISSION_REQUIRED | yes |
| missing host probe | startup-exit | DAEMON_STARTUP_CONFIG_INVALID | yes |
| missing resolver | 424 | TERMINAL_TARGET_BINDING_UNAVAILABLE | yes |
| wrong terminal target | 424 | TERMINAL_TARGET_BINDING_UNAVAILABLE | yes |
| stale binding generation | 409 | BINDING_GENERATION_STALE | yes |
| wrong machine | 404 | MEMBER_NOT_FOUND | yes |

Each failure receipt records the HTTP response and confirms the real tmux buffer did not change. The missing-resolver case also proves zero connection-manager channel-open/input calls.

## Notes

- The production config always injects `members.resolveBindingTarget`. The missing-resolver case therefore uses the same daemon HTTP boundary with `resolveBindingTarget: null` to prove the daemon itself fails closed; this is documented rather than hidden.
- The isolated V1 fixture, relay, and tmux socket were task-owned. No shared daemon or shared port was touched.
- Credentials and the real config file contents are intentionally omitted from the receipts.


# Bootstrap R3 rework R4F plan

## Scope

Close David's Bootstrap R3 findings 1-3 only. Keep the public package consumer
gap open for Jenny/package owner. Do not change packages, Android, Mac,
Windows, iOS, or another V2 module.

## Affected SESE

Repair path:

1. V1 mux delivers `buffer-sync`.
2. `terminal-port` passes the chunk to `resource.client_buffer_frame_assembly`.
3. A rejected result with a valid `repairRange` becomes one exact
   `buffer-sync-request`.
4. V1 mux delivers the repair frame.
5. The same assembly resource commits one complete frame and publishes it
   once to terminal subscribers.

Late-open release path:

1. `openChannel` times out and retains the channel id as awaiting release.
2. A late `mux-channel-opened` makes one close attempt.
3. A failed close keeps the id retryable and emits typed
   `V1_CHANNEL_CLOSE_FAILED`.
4. A later successful retry removes the id.
5. A physical transport close also ends the pending release state.

## Ownership

- `v2/modules/terminal/src/terminal-port.mjs`: repair request projection.
- `v2/modules/terminal/src/v1-mux-client.mjs`: physical channel reference and
  close retry.
- `packages/stream-boundary/src/terminal-buffer-render-runtime.ts`: unchanged

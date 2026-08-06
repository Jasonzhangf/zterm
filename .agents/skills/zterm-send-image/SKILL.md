---
name: zterm-send-image
description: Send an image from an Agent to one or more zterm client devices through the daemon attachment API.
---

# zterm Send Image

Use the daemon attachment API. Do not write `~/.zterm/attachments` directly and do not put image bytes in terminal input, mux frames, heartbeat payloads, or debug metadata.

## Command

```bash
zterm-send-image --file /absolute/path/image.png --target-device phone-a --message "optional context"
```

The command must return the structured `attachmentId` and `queued` status. Generate a stable `clientRequestId` when retrying the same Agent operation so retries are idempotent.

## API

`POST /api/v1/attachments/images` with a JSON body containing `fileName`, `mimeType`, `dataBase64`, `senderAgentId`, `senderName`, `clientRequestId`, `targetDeviceIds`, and optional `message`. Authenticate with the daemon token.

The daemon creates a durable 48-hour attachment and per-device delivery records. The remote client pulls the preview first and the original only on demand.

## Boundaries

- Push is only a control-plane wake-up; clients recover missed pushes through attachment sync.
- A receipt acknowledges only the current target device and asset (`preview` or `original`).
- Never report delivery from local enqueue alone.
- Never reuse the terminal session file-transfer API for inbox attachments.

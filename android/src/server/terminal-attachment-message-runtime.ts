import type {
  AttachmentHistoryPayload,
  BridgeClientMessage,
  PendingAttachmentsPayload,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type { AttachmentDeliveryRuntime } from './attachment-delivery-runtime';
import type { TerminalTransportConnection, TerminalSessionTransport } from './terminal-runtime-types';

export type TerminalAttachmentClientMessage = Extract<
  BridgeClientMessage,
  | { type: 'pending-attachments-query' }
  | { type: 'attachment-history-query' }
  | { type: 'attachment-asset-request' }
  | { type: 'attachment-receipt' }
>;

export interface TerminalAttachmentMessageRuntimeDeps {
  attachmentDeliveryRuntime: AttachmentDeliveryRuntime;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}

export interface TerminalAttachmentMessageRuntime {
  handleMessage: (
    connection: TerminalTransportConnection,
    message: TerminalAttachmentClientMessage,
  ) => Promise<void>;
}

export function createTerminalAttachmentMessageRuntime(
  deps: TerminalAttachmentMessageRuntimeDeps,
): TerminalAttachmentMessageRuntime {
  function sendError(
    connection: TerminalTransportConnection,
    code: string,
    message: string,
  ) {
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: { message, code },
    });
  }

  async function handleMessage(
    connection: TerminalTransportConnection,
    message: TerminalAttachmentClientMessage,
  ) {
    switch (message.type) {
      case 'pending-attachments-query': {
        const { deviceId } = (message as { payload?: { deviceId?: string } }).payload || {};
        if (!deviceId) {
          sendError(connection, 'invalid_payload', 'pending-attachments-query requires deviceId');
          break;
        }
        try {
          const manifests = await deps.attachmentDeliveryRuntime.listForDevice(deviceId);
          const pending: PendingAttachmentsPayload['pending'] = manifests.map((m) => ({
            attachmentId: m.attachmentId,
            kind: m.kind,
            senderName: m.senderName,
            sourceSession: m.sourceSession,
            fileName: m.fileName,
            mimeType: m.mimeType,
            previewSize: m.preview.size,
            originalSize: m.original.size,
            message: m.message,
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
          }));
          deps.sendTransportMessage(connection.transport, {
            type: 'pending-attachments',
            payload: { schemaVersion: 1, pending },
          });
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] pending-query device=${deviceId} -> ${pending.length} pending`);
        } catch (err) {
          sendError(connection, 'attachment_query_failed', err instanceof Error ? err.message : 'attachment query failed');
        }
        break;
      }
      case 'attachment-history-query': {
        const { deviceId } = (message as { payload?: { deviceId?: string } }).payload || {};
        if (!deviceId) {
          sendError(connection, 'invalid_payload', 'attachment-history-query requires deviceId');
          break;
        }
        try {
          const manifests = await deps.attachmentDeliveryRuntime.listForDevice(deviceId, 'preview', true);
          const items: AttachmentHistoryPayload['items'] = manifests.map((m) => {
            const delivery = m.deliveries.find((item) => item.targetDeviceId === deviceId);
            return {
              attachmentId: m.attachmentId,
              kind: m.kind,
              senderName: m.senderName,
              sourceSession: m.sourceSession,
              fileName: m.fileName,
              mimeType: m.mimeType,
              previewSize: m.preview.size,
              originalSize: m.original.size,
              message: m.message,
              createdAt: m.createdAt,
              expiresAt: m.expiresAt,
              previewStatus: delivery?.previewStatus === 'acknowledged' ? 'acknowledged' : 'pending',
              originalStatus: delivery?.originalStatus === 'acknowledged' ? 'acknowledged' : 'pending',
            };
          });
          deps.sendTransportMessage(connection.transport, {
            type: 'attachment-history',
            payload: { schemaVersion: 1, items },
          });
        } catch (err) {
          sendError(connection, 'attachment_history_failed', err instanceof Error ? err.message : 'attachment history query failed');
        }
        break;
      }
      case 'attachment-asset-request': {
        const { attachmentId, asset, deviceId } = (
          message as { payload?: { attachmentId?: string; asset?: 'preview' | 'original'; deviceId?: string } }
        ).payload || {};
        if (!attachmentId || !asset || !deviceId) {
          sendError(connection, 'invalid_payload', 'attachment-asset-request requires attachmentId, asset, and deviceId');
          break;
        }
        try {
          const { manifest, data } = await deps.attachmentDeliveryRuntime.readAsset(attachmentId, asset, deviceId);
          const base64 = data.toString('base64');
          deps.sendTransportMessage(connection.transport, {
            type: 'attachment-asset-data',
            payload: {
              attachmentId: manifest.attachmentId,
              deviceId,
              asset,
              dataBase64: base64,
              sha256: manifest[asset].sha256,
              mimeType: manifest.mimeType,
            },
          });
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] asset-request attachment=${attachmentId} asset=${asset} device=${deviceId} bytes=${data.byteLength} -> delivered`);
        } catch (err) {
          sendError(connection, 'attachment_read_failed', err instanceof Error ? err.message : 'attachment read failed');
        }
        break;
      }
      case 'attachment-receipt': {
        const { attachmentId, asset, sha256, deviceId } = (
          message as { payload?: { attachmentId?: string; asset?: 'preview' | 'original'; sha256?: string; deviceId?: string } }
        ).payload || {};
        if (!attachmentId || !asset || !sha256 || !deviceId) {
          sendError(connection, 'invalid_payload', 'attachment-receipt requires attachmentId, asset, sha256, and deviceId');
          break;
        }
        try {
          await deps.attachmentDeliveryRuntime.acknowledge(attachmentId, deviceId, asset, sha256);
          // eslint-disable-next-line no-console
          console.log(`[zterm:attach] receipt attachment=${attachmentId} asset=${asset} device=${deviceId} sha256=${sha256.slice(0, 8)} -> ack`);
        } catch (err) {
          sendError(connection, 'attachment_acknowledge_failed', err instanceof Error ? err.message : 'attachment acknowledge failed');
        }
        break;
      }
    }
  }

  return { handleMessage };
}

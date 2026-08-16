import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalTransportServerFrame } from '@zterm/shared/protocol';
import type { AttachmentManifest } from './attachment-delivery-runtime';
import type { TerminalSessionTransport } from './terminal-runtime-types';
import {
  createTerminalAttachmentMessageRuntime,
  type TerminalAttachmentClientMessage,
} from './terminal-attachment-message-runtime';

function createTransport(): TerminalSessionTransport {
  return {
    kind: 'ws',
    readyState: 1,
    requestOrigin: 'http://127.0.0.1:3333',
    connectedSent: false,
    sendText: vi.fn(),
    close: vi.fn(),
  };
}

function createConnection() {
  return {
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: 'control' as const,
    boundSubscriberId: null,
  };
}

function makeManifest(id: string): AttachmentManifest {
  return {
    schemaVersion: 1,
    attachmentId: id,
    kind: 'image',
    senderAgentId: 'agent-id',
    senderName: 'agent',
    sourceSession: 'demo',
    fileName: 'photo.png',
    mimeType: 'image/png',
    original: { size: 34, sha256: 'original-sha' },
    preview: { fileName: 'preview.png', mimeType: 'image/png', size: 12, sha256: 'preview-sha' },
    message: 'hello',
    clientRequestId: `request-${id}`,
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-17T00:00:00.000Z',
    status: 'available',
    deliveries: [],
  };
}

function withDelivery(manifest: AttachmentManifest, delivery: AttachmentManifest['deliveries'][number]) {
  return { ...manifest, deliveries: [delivery] };
}

function createRuntime() {
  const attachmentDeliveryRuntime = {
    enqueueImage: vi.fn(),
    listForDevice: vi.fn(async () => [] as AttachmentManifest[]),
    readAsset: vi.fn(async () => ({
      manifest: makeManifest('att_00000000-0000-4000-8000-000000000001'),
      data: Buffer.from('asset'),
    })),
    acknowledge: vi.fn(async () => makeManifest('att_00000000-0000-4000-8000-000000000001')),
    cleanup: vi.fn(),
  };
  const sendTransportMessage = vi.fn();
  const runtime = createTerminalAttachmentMessageRuntime({
    attachmentDeliveryRuntime,
    sendTransportMessage,
  });
  return {
    runtime,
    connection: createConnection(),
    attachmentDeliveryRuntime,
    sendTransportMessage,
  };
}

async function handleMessage(
  runtime: ReturnType<typeof createTerminalAttachmentMessageRuntime>,
  connection: ReturnType<typeof createConnection>,
  message: TerminalAttachmentClientMessage,
) {
  await runtime.handleMessage(connection, message);
}

function sentMessages(sendTransportMessage: ReturnType<typeof vi.fn>) {
  return sendTransportMessage.mock.calls.map((call) => call[1] as TerminalTransportServerFrame);
}

describe('terminal attachment message runtime', () => {
  it('maps pending attachment manifests to the legacy pending-attachments wire payload', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();
    attachmentDeliveryRuntime.listForDevice.mockResolvedValue([
      makeManifest('att_00000000-0000-4000-8000-000000000001'),
    ]);

    await handleMessage(runtime, connection, {
      type: 'pending-attachments-query',
      payload: { deviceId: 'phone-a' },
    });

    expect(attachmentDeliveryRuntime.listForDevice).toHaveBeenCalledWith('phone-a');
    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'pending-attachments',
      payload: {
        schemaVersion: 1,
        pending: [{
          attachmentId: 'att_00000000-0000-4000-8000-000000000001',
          kind: 'image',
          senderName: 'agent',
          sourceSession: 'demo',
          fileName: 'photo.png',
          mimeType: 'image/png',
          previewSize: 12,
          originalSize: 34,
          message: 'hello',
          createdAt: '2026-08-15T00:00:00.000Z',
          expiresAt: '2026-08-17T00:00:00.000Z',
        }],
      },
    });
  });

  it('rejects a pending attachment query without a device id explicitly', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();

    await handleMessage(runtime, connection, {
      type: 'pending-attachments-query',
      payload: { deviceId: '' },
    });

    expect(attachmentDeliveryRuntime.listForDevice).not.toHaveBeenCalled();
    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'error',
      payload: {
        message: 'pending-attachments-query requires deviceId',
        code: 'invalid_payload',
      },
    });
  });

  it('keeps attachment query failures explicit on the error frame', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();
    attachmentDeliveryRuntime.listForDevice.mockRejectedValue(new Error('list failed'));

    await handleMessage(runtime, connection, {
      type: 'pending-attachments-query',
      payload: { deviceId: 'phone-a' },
    });

    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'error',
      payload: { message: 'list failed', code: 'attachment_query_failed' },
    });
  });

  it('maps per-device delivery status into the attachment history payload', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();
    attachmentDeliveryRuntime.listForDevice.mockResolvedValue([
      withDelivery(
        makeManifest('att_00000000-0000-4000-8000-000000000002'),
        {
        targetDeviceId: 'phone-a',
        previewStatus: 'acknowledged',
        originalStatus: 'pending',
          attemptCount: 1,
        },
      ),
    ]);

    await handleMessage(runtime, connection, {
      type: 'attachment-history-query',
      payload: { deviceId: 'phone-a' },
    });

    expect(attachmentDeliveryRuntime.listForDevice).toHaveBeenCalledWith('phone-a', 'preview', true);
    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'attachment-history',
      payload: {
        schemaVersion: 1,
        items: [{
          attachmentId: 'att_00000000-0000-4000-8000-000000000002',
          kind: 'image',
          senderName: 'agent',
          sourceSession: 'demo',
          fileName: 'photo.png',
          mimeType: 'image/png',
          previewSize: 12,
          originalSize: 34,
          message: 'hello',
          createdAt: '2026-08-15T00:00:00.000Z',
          expiresAt: '2026-08-17T00:00:00.000Z',
          previewStatus: 'acknowledged',
          originalStatus: 'pending',
        }],
      },
    });
  });

  it('serves an attachment asset with base64 data and verified checksum metadata', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();
    attachmentDeliveryRuntime.readAsset.mockResolvedValue({
      manifest: makeManifest('att_00000000-0000-4000-8000-000000000003'),
      data: Buffer.from('asset-bytes'),
    });

    await handleMessage(runtime, connection, {
      type: 'attachment-asset-request',
      payload: {
        attachmentId: 'att_00000000-0000-4000-8000-000000000003',
        asset: 'preview',
        deviceId: 'phone-a',
      },
    });

    expect(attachmentDeliveryRuntime.readAsset).toHaveBeenCalledWith(
      'att_00000000-0000-4000-8000-000000000003',
      'preview',
      'phone-a',
    );
    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'attachment-asset-data',
      payload: {
        attachmentId: 'att_00000000-0000-4000-8000-000000000003',
        deviceId: 'phone-a',
        asset: 'preview',
        dataBase64: Buffer.from('asset-bytes').toString('base64'),
        sha256: 'preview-sha',
        mimeType: 'image/png',
      },
    });
  });

  it('rejects an asset request with missing identity fields', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();

    await handleMessage(runtime, connection, {
      type: 'attachment-asset-request',
      payload: { attachmentId: '', asset: 'preview', deviceId: '' },
    });

    expect(attachmentDeliveryRuntime.readAsset).not.toHaveBeenCalled();
    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'error',
      payload: {
        message: 'attachment-asset-request requires attachmentId, asset, and deviceId',
        code: 'invalid_payload',
      },
    });
  });

  it('acknowledges one device asset receipt without sending a success frame', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();

    await handleMessage(runtime, connection, {
      type: 'attachment-receipt',
      payload: {
        attachmentId: 'att_00000000-0000-4000-8000-000000000004',
        asset: 'preview',
        sha256: 'preview-sha',
        deviceId: 'phone-a',
      },
    });

    expect(attachmentDeliveryRuntime.acknowledge).toHaveBeenCalledWith(
      'att_00000000-0000-4000-8000-000000000004',
      'phone-a',
      'preview',
      'preview-sha',
    );
    expect(sendTransportMessage).not.toHaveBeenCalled();
  });

  it('reports a receipt failure as an explicit attachment acknowledge error', async () => {
    const { runtime, connection, attachmentDeliveryRuntime, sendTransportMessage } = createRuntime();
    attachmentDeliveryRuntime.acknowledge.mockRejectedValue(new Error('receipt failed'));

    await handleMessage(runtime, connection, {
      type: 'attachment-receipt',
      payload: {
        attachmentId: 'att_00000000-0000-4000-8000-000000000004',
        asset: 'preview',
        sha256: 'preview-sha',
        deviceId: 'phone-a',
      },
    });

    expect(sentMessages(sendTransportMessage)).toContainEqual({
      type: 'error',
      payload: { message: 'receipt failed', code: 'attachment_acknowledge_failed' },
    });
  });
});

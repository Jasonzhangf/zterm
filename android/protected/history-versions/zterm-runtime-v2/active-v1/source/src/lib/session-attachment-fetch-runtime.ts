/**
 * Session attachment fetch runtime.
 *
 * Manages the lifecycle of fetching pending attachments from daemon:
 * 1. On session connect, send `pending-attachments-query` via mux target message
 * 2. On `pending-attachments` response, upsert entries into attachment store
 * 3. For each attachment with pending preview, fetch preview binary via daemon HTTP API
 * 4. On fetch success, mark preview ready and acknowledge; on failure, mark error
 *
 * The runtime is session-agnostic — shares the attachment store across all sessions.
 */

import type { AttachmentHistoryPayload, PendingAttachmentsPayload } from '@zterm/shared/protocol';
import type {
  SessionAttachmentStore,
} from './session-attachment-store';
import {
  buildTerminalMuxTargetMessage,
  type TerminalMuxClientFrame,
} from '@zterm/shared/protocol';

export interface SessionAttachmentFetchRuntime {
  /** Start the runtime with mux send/read capabilities. */
  start: (options: {
    sendMuxTargetMessage: (msg: TerminalMuxClientFrame) => boolean;
    readMuxReady: () => boolean;
  }) => void;
  /** Stop the runtime and clean up timers. */
  stop: () => void;
  /** Manually trigger a pending attachments poll. */
  pollPendingAttachments: () => void;
  /** Request the full attachment history (incl. acknowledged items) for this device. */
  queryAttachmentHistory: (onHistory: (payload: AttachmentHistoryPayload) => void) => void;
  /** Fetch a single asset (preview/original) for an attachment (used by history re-download). */
  fetchAsset: (attachmentId: string, asset: 'preview' | 'original') => boolean;
  /** Process an incoming `pending-attachments` mux target message. Returns new pending count. */
  processPendingAttachmentsResponse: (payload: PendingAttachmentsPayload) => number;
  /** Process an incoming `attachment-history` mux target message. */
  processAttachmentHistoryPayload: (payload: AttachmentHistoryPayload) => void;
  /** Called when `attachment-asset-data` arrives over the mux channel:
   *  sends the `attachment-receipt` ack back to the daemon. */
  onAssetDataReceived: (attachmentId: string, asset: 'preview' | 'original', sha256: string) => boolean;
}

const POLL_INTERVAL_MS = 60_000; // poll every 60s

export function createSessionAttachmentFetchRuntime(options: {
  attachmentStore: SessionAttachmentStore;
  deviceId: string;
  now?: () => number;
}): SessionAttachmentFetchRuntime {
  const { attachmentStore, deviceId } = options;

  let sendMuxTargetMessage: ((msg: TerminalMuxClientFrame) => boolean) | null = null;
  let readMuxReady: (() => boolean) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fetchQueue: string[] = [];
  let isProcessingQueue = false;

  const isMuxReady = () => readMuxReady?.() ?? false;

  const sendQuery = () => {
    if (!sendMuxTargetMessage || !isMuxReady()) return;
    sendMuxTargetMessage(
      buildTerminalMuxTargetMessage({
        type: 'pending-attachments-query',
        payload: { deviceId },
      }),
    );
  };

  const requestAsset = (attachmentId: string, asset: 'preview' | 'original'): boolean => {
    if (!sendMuxTargetMessage || !isMuxReady()) {
      // eslint-disable-next-line no-console
      console.log('[zterm:attach-dbg]', 'requestAsset skipped', { attachmentId, asset, hasSender: !!sendMuxTargetMessage, muxReady: isMuxReady() });
      return false;
    }
    const sent = sendMuxTargetMessage(
      buildTerminalMuxTargetMessage({
        type: 'attachment-asset-request',
        payload: { attachmentId, asset, deviceId },
      }),
    );
    // eslint-disable-next-line no-console
    console.log('[zterm:attach-dbg]', 'requestAsset', { attachmentId, asset, sent });
    return sent;
  };

  const processQueue = async () => {
    if (isProcessingQueue || fetchQueue.length === 0) return;
    isProcessingQueue = true;
    while (fetchQueue.length > 0) {
      const attachmentId = fetchQueue.shift()!;
      const entry = attachmentStore.get(attachmentId);
      if (!entry) continue;

      // Request the preview via the mux channel first; the daemon streams the
      // binary back as `attachment-asset-data` (works for relay routes too,
      // where a direct HTTP fetch to the daemon is not possible).
      if (entry.status === 'pending-preview' && !entry.previewUrl) {
        if (!requestAsset(attachmentId, 'preview')) {
          attachmentStore.markError(attachmentId, 'mux transport unavailable for preview');
        }
      }

      // Then the original
      const updated = attachmentStore.get(attachmentId);
      if (updated?.status === 'pending-original' && !updated.originalUrl) {
        if (!requestAsset(attachmentId, 'original')) {
          attachmentStore.markError(attachmentId, 'mux transport unavailable for original');
        }
      }
    }
    isProcessingQueue = false;
  };

  const enqueueFetch = (attachmentId: string) => {
    if (!fetchQueue.includes(attachmentId)) {
      fetchQueue.push(attachmentId);
      void processQueue();
    }
  };

  let historyCallback: ((payload: AttachmentHistoryPayload) => void) | null = null;

  return {
    start: (ctx) => {
      sendMuxTargetMessage = ctx.sendMuxTargetMessage;
      readMuxReady = ctx.readMuxReady;
      sendQuery();
      // Restore the attachment list on cold start (Activity re-created / app
      // re-launched) so previously delivered files reappear without waiting
      // for the user to open the history section.
      if (sendMuxTargetMessage && isMuxReady()) {
        sendMuxTargetMessage(
          buildTerminalMuxTargetMessage({
            type: 'attachment-history-query',
            payload: { deviceId },
          }),
        );
      }
      pollTimer = setInterval(sendQuery, POLL_INTERVAL_MS);
    },

    queryAttachmentHistory: (onHistory) => {
      historyCallback = onHistory;
      if (!sendMuxTargetMessage || !isMuxReady()) return;
      sendMuxTargetMessage(
        buildTerminalMuxTargetMessage({
          type: 'attachment-history-query',
          payload: { deviceId },
        }),
      );
    },

    fetchAsset: (attachmentId, asset) => requestAsset(attachmentId, asset),

    processAttachmentHistoryPayload: (payload: AttachmentHistoryPayload) => {
      attachmentStore.upsertHistory(payload.items);
      historyCallback?.(payload);
    },

    stop: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      sendMuxTargetMessage = null;
      readMuxReady = null;
      fetchQueue = [];
    },

    pollPendingAttachments: () => {
      sendQuery();
    },

    processPendingAttachmentsResponse: (payload) => {
      attachmentStore.upsertPending(payload.pending);
      // Enqueue all pending-preview attachments for fetch
      for (const item of payload.pending) {
        const entry = attachmentStore.get(item.attachmentId);
        if (entry?.status === 'pending-preview') {
          enqueueFetch(item.attachmentId);
        }
      }
      return attachmentStore.getPendingCount();
    },

    onAssetDataReceived: (attachmentId, asset, sha256) => {
      if (!sendMuxTargetMessage || !isMuxReady()) return false;
      return sendMuxTargetMessage(
        buildTerminalMuxTargetMessage({
          type: 'attachment-receipt',
          payload: { attachmentId, asset, sha256, deviceId },
        }),
      );
    },
  };
}

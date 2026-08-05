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

import type { PendingAttachmentsPayload } from '@zterm/shared/protocol';
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
  /** Process an incoming `pending-attachments` mux target message. Returns new pending count. */
  processPendingAttachmentsResponse: (payload: PendingAttachmentsPayload) => number;
}

const POLL_INTERVAL_MS = 60_000; // poll every 60s

export function createSessionAttachmentFetchRuntime(options: {
  attachmentStore: SessionAttachmentStore;
  deviceId: string;
  fetchDaemonHttpAsset: (attachmentId: string, asset: 'preview' | 'original') => Promise<{ blob: Blob; sha256: string }>;
  acknowledgeAsset: (attachmentId: string, asset: 'preview' | 'original', sha256: string) => Promise<void>;
  now?: () => number;
}): SessionAttachmentFetchRuntime {
  const { attachmentStore, deviceId, fetchDaemonHttpAsset, acknowledgeAsset } = options;

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

  const processQueue = async () => {
    if (isProcessingQueue || fetchQueue.length === 0) return;
    isProcessingQueue = true;
    while (fetchQueue.length > 0) {
      const attachmentId = fetchQueue.shift()!;
      const entry = attachmentStore.get(attachmentId);
      if (!entry) continue;

      // Try preview first if needed
      if (entry.status === 'pending-preview' && !entry.previewUrl) {
        try {
          const { blob, sha256 } = await fetchDaemonHttpAsset(attachmentId, 'preview');
          attachmentStore.markPreviewReady(attachmentId, blob);
          await acknowledgeAsset(attachmentId, 'preview', sha256);
        } catch (err) {
          attachmentStore.markError(attachmentId, err instanceof Error ? err.message : 'preview fetch failed');
        }
      }

      // Then original
      const updated = attachmentStore.get(attachmentId);
      if (updated?.status === 'pending-original' && !updated.originalUrl) {
        try {
          const { blob, sha256 } = await fetchDaemonHttpAsset(attachmentId, 'original');
          attachmentStore.markOriginalReady(attachmentId, blob);
          await acknowledgeAsset(attachmentId, 'original', sha256);
        } catch (err) {
          attachmentStore.markError(attachmentId, err instanceof Error ? err.message : 'original fetch failed');
        }
      }
    }
    isProcessingQueue = false;
  };

  const enqueueFetch = (attachmentId: string) => {
    if (!fetchQueue.includes(attachmentId)) {
      fetchQueue.push(attachmentId);
      processQueue();
    }
  };

  return {
    start: (ctx) => {
      sendMuxTargetMessage = ctx.sendMuxTargetMessage;
      readMuxReady = ctx.readMuxReady;
      sendQuery();
      pollTimer = setInterval(sendQuery, POLL_INTERVAL_MS);
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
  };
}

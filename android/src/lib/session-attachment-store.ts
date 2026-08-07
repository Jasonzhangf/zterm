/**
 * Session attachment store — manages pending attachments fetched from daemon.
 *
 * Attachments are shared across all sessions (unique per attachmentId).
 * Each attachment goes through two download phases:
 * 1. preview: low-res thumbnail for quick display
 * 2. original: full-resolution image
 *
 * 48h TTL is handled server-side; client just polls on session connect.
 */

import type { AttachmentHistoryPayload, PendingAttachmentsPayload } from '@zterm/shared/protocol';

export type AttachmentStatus = 'pending-preview' | 'preview-ready' | 'pending-original' | 'complete' | 'error';

export interface AttachmentEntry {
  attachmentId: string;
  kind: 'image';
  senderName: string;
  /** Optional tmux session name the sender was working in. */
  sourceSession?: string;
  fileName: string;
  mimeType: string;
  previewUrl?: string;   // object URL after preview download
  originalUrl?: string;  // object URL after original download
  previewSize: number;
  originalSize: number;
  message?: string;
  status: AttachmentStatus;
  receivedAt: number;    // Date.now() when we first learned about it
  error?: string;
  /** 'pending' = newly delivered (drives the notification); 'history' = past delivery. */
  origin?: 'pending' | 'history';
  /** Delivery acknowledgement state reported by the daemon (history entries). */
  acknowledgedPreview?: boolean;
  acknowledgedOriginal?: boolean;
}

export interface SessionAttachmentStore {
  /** Upsert a batch of pending attachments from daemon. Returns count of new entries. */
  upsertPending: (batch: PendingAttachmentsPayload['pending']) => number;
  /** Upsert a batch of history attachments (incl. acknowledged past deliveries). Returns count of new entries. */
  upsertHistory: (batch: AttachmentHistoryPayload['items']) => number;
  /** Mark preview downloaded for an attachment. */
  markPreviewReady: (attachmentId: string, blob: Blob) => void;
  /** Mark original downloaded for an attachment. */
  markOriginalReady: (attachmentId: string, blob: Blob) => void;
  /** Mark attachment as errored. */
  markError: (attachmentId: string, error: string) => void;
  /** Get all attachments, newest first. */
  getAll: () => AttachmentEntry[];
  /** Get attachments filtered by status. */
  getByStatus: (status: AttachmentStatus) => AttachmentEntry[];
  /** Get pending count (preview not yet downloaded). */
  getPendingCount: () => number;
  /** Get a single attachment by id. */
  get: (attachmentId: string) => AttachmentEntry | null;
  /** Clear all entries. */
  clear: () => void;
  /** Remove a single entry and revoke its object URLs. */
  remove: (attachmentId: string) => void;
}

export function createSessionAttachmentStore(): SessionAttachmentStore {
  const attachments = new Map<string, AttachmentEntry>();

  const revokeUrls = (entry: AttachmentEntry) => {
    if (entry.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
    }
    if (entry.originalUrl) {
      URL.revokeObjectURL(entry.originalUrl);
    }
  };

  return {
    upsertPending: (batch) => {
      let newCount = 0;
      for (const item of batch) {
        if (!attachments.has(item.attachmentId)) {
          attachments.set(item.attachmentId, {
            attachmentId: item.attachmentId,
            kind: item.kind,
            senderName: item.senderName,
            sourceSession: item.sourceSession,
            fileName: item.fileName,
            mimeType: item.mimeType,
            previewSize: item.previewSize,
            originalSize: item.originalSize,
            message: item.message,
            status: 'pending-preview',
            receivedAt: Date.now(),
            origin: 'pending',
          });
          newCount++;
        }
      }
      return newCount;
    },

    upsertHistory: (batch) => {
      let newCount = 0;
      for (const item of batch) {
        const existing = attachments.get(item.attachmentId);
        if (!existing) {
          attachments.set(item.attachmentId, {
            attachmentId: item.attachmentId,
            kind: item.kind,
            senderName: item.senderName,
            sourceSession: item.sourceSession,
            fileName: item.fileName,
            mimeType: item.mimeType,
            previewSize: item.previewSize,
            originalSize: item.originalSize,
            message: item.message,
            status: 'pending-preview',
            receivedAt: Date.parse(item.createdAt) || Date.now(),
            origin: 'history',
            acknowledgedPreview: item.previewStatus === 'acknowledged',
            acknowledgedOriginal: item.originalStatus === 'acknowledged',
          });
          newCount++;
        } else if (existing.origin !== 'history') {
          // A pending entry that already arrived: upgrade it with the history state.
          attachments.set(item.attachmentId, {
            ...existing,
            acknowledgedPreview: item.previewStatus === 'acknowledged',
            acknowledgedOriginal: item.originalStatus === 'acknowledged',
          });
        }
      }
      return newCount;
    },

    markPreviewReady: (attachmentId, blob) => {
      const entry = attachments.get(attachmentId);
      if (!entry) return;
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      const url = URL.createObjectURL(blob);
      attachments.set(attachmentId, { ...entry, previewUrl: url, status: 'pending-original' });
    },

    markOriginalReady: (attachmentId, blob) => {
      const entry = attachments.get(attachmentId);
      if (!entry) return;
      if (entry.originalUrl) URL.revokeObjectURL(entry.originalUrl);
      const url = URL.createObjectURL(blob);
      attachments.set(attachmentId, { ...entry, originalUrl: url, status: 'complete' });
    },

    markError: (attachmentId, error) => {
      const entry = attachments.get(attachmentId);
      if (!entry) return;
      attachments.set(attachmentId, { ...entry, status: 'error', error });
    },

    getAll: () => Array.from(attachments.values()).sort((a, b) => b.receivedAt - a.receivedAt),

    getByStatus: (status) => Array.from(attachments.values()).filter((e) => e.status === status),

    getPendingCount: () =>
      Array.from(attachments.values()).filter((e) => e.status !== 'complete' && e.status !== 'error').length,

    get: (attachmentId) => attachments.get(attachmentId) ?? null,

    clear: () => {
      for (const entry of attachments.values()) revokeUrls(entry);
      attachments.clear();
    },

    remove: (attachmentId) => {
      const entry = attachments.get(attachmentId);
      if (entry) {
        revokeUrls(entry);
        attachments.delete(attachmentId);
      }
    },
  };
}

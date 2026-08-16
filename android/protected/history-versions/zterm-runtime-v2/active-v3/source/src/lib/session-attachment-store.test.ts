import { describe, expect, it } from 'vitest';
import { createSessionAttachmentStore } from './session-attachment-store';
import type { AttachmentHistoryPayload, PendingAttachmentsPayload } from '@zterm/shared/protocol';

function pendingItem(overrides: Partial<PendingAttachmentsPayload['pending'][number]> = {}): PendingAttachmentsPayload['pending'][number] {
  return {
    attachmentId: 'att-1',
    kind: 'image',
    senderName: 'agent',
    fileName: 'a.png',
    mimeType: 'image/png',
    previewSize: 100,
    originalSize: 1000,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    ...overrides,
  };
}

function historyItem(overrides: Partial<AttachmentHistoryPayload['items'][number]> = {}): AttachmentHistoryPayload['items'][number] {
  return {
    attachmentId: 'att-hist-1',
    kind: 'image',
    senderName: 'agent',
    fileName: 'old.png',
    mimeType: 'image/png',
    previewSize: 90,
    originalSize: 900,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 47 * 3600_000).toISOString(),
    previewStatus: 'acknowledged',
    originalStatus: 'pending',
    ...overrides,
  };
}

describe('createSessionAttachmentStore', () => {
  it('upserts pending entries with origin pending and counts new ones', () => {
    const store = createSessionAttachmentStore();
    expect(store.upsertPending([pendingItem({ attachmentId: 'a' }), pendingItem({ attachmentId: 'b' })])).toBe(2);
    expect(store.upsertPending([pendingItem({ attachmentId: 'a' }), pendingItem({ attachmentId: 'c' })])).toBe(1);
    expect(store.get('a')).toMatchObject({ origin: 'pending', status: 'pending-preview' });
    expect(store.getAll().length).toBe(3);
  });

  it('upserts history entries with origin history and delivery state', () => {
    const store = createSessionAttachmentStore();
    store.upsertHistory([historyItem({ attachmentId: 'h1', previewStatus: 'acknowledged', originalStatus: 'pending' })]);
    const entry = store.get('h1');
    expect(entry).toMatchObject({
      origin: 'history',
      acknowledgedPreview: true,
      acknowledgedOriginal: false,
    });
  });

  it('keeps pending origin when history arrives for the same id (no re-notify for pending)', () => {
    const store = createSessionAttachmentStore();
    store.upsertPending([pendingItem({ attachmentId: 'x' })]);
    store.upsertHistory([{ ...historyItem({ attachmentId: 'x' }) }]);
    // The pending entry stays pending-origin; history state is attached.
    expect(store.get('x')).toMatchObject({ origin: 'pending', acknowledgedPreview: true });
  });

  it('separates pending vs history lists via origin', () => {
    const store = createSessionAttachmentStore();
    store.upsertPending([pendingItem({ attachmentId: 'p1' })]);
    store.upsertHistory([historyItem({ attachmentId: 'h1' })]);
    const all = store.getAll();
    expect(all.filter((a) => a.origin === 'pending').map((a) => a.attachmentId)).toEqual(['p1']);
    expect(all.filter((a) => a.origin === 'history').map((a) => a.attachmentId)).toEqual(['h1']);
  });
});

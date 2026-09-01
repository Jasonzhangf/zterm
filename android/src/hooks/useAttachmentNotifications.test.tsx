// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentEntry } from '../lib/session-attachment-store';
import { useAttachmentNotifications } from './useAttachmentNotifications';

const { scheduleNotification, ensurePermission } = vi.hoisted(() => ({
  scheduleNotification: vi.fn(async () => undefined),
  ensurePermission: vi.fn(async () => true),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: { schedule: scheduleNotification },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    writeFile: vi.fn(async () => undefined),
    getUri: vi.fn(async () => ({ uri: 'file:///preview.png' })),
  },
}));

vi.mock('../lib/notification-helper', () => ({
  ensureNotificationPermission: ensurePermission,
  nextNotificationId: vi.fn(() => 101),
}));

function attachment(): AttachmentEntry {
  return {
    attachmentId: 'att-test',
    kind: 'image',
    senderName: 'Reasonix',
    fileName: 'proof.png',
    mimeType: 'image/png',
    previewUrl: 'blob:preview',
    previewSize: 120,
    originalSize: 2048,
    status: 'pending-original',
    receivedAt: Date.now(),
    origin: 'pending',
  };
}

function Harness({ getEntries }: { getEntries?: () => AttachmentEntry[] }) {
  useAttachmentNotifications({ getPendingAttachments: getEntries, pollIntervalMs: 1_000 });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  scheduleNotification.mockClear();
  ensurePermission.mockReset();
  ensurePermission.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    blob: async () => new Blob(['preview'], { type: 'image/png' }),
  })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAttachmentNotifications', () => {
  it('does nothing when an older SessionContext mock has no attachment getter', async () => {
    render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it('notifies a new preview while no terminal page or drawer is mounted', async () => {
    let entries: AttachmentEntry[] = [];
    render(<Harness getEntries={() => entries} />);

    entries = [attachment()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(scheduleNotification).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({
        title: '附件：proof.png',
        extra: { kind: 'attachment', attachmentId: 'att-test' },
      })],
    });
  });

  it('records permission denial as a terminal delivery failure for the attachment', async () => {
    const entries = [attachment()];
    ensurePermission.mockResolvedValue(false);
    render(<Harness getEntries={() => entries} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(scheduleNotification).not.toHaveBeenCalled();
    expect(ensurePermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(ensurePermission).toHaveBeenCalledTimes(1);
  });

  it('records scheduler rejection as a terminal delivery failure for the attachment', async () => {
    const entries = [attachment()];
    scheduleNotification.mockRejectedValueOnce(new Error('permission rejected'));
    render(<Harness getEntries={() => entries} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(scheduleNotification).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(scheduleNotification).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated polls for the same attachment', async () => {
    const entries = [attachment()];
    render(<Harness getEntries={() => entries} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(scheduleNotification).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a duplicate while the first notification is in flight', async () => {
    const entries = [attachment()];
    let releaseSchedule: (() => void) | undefined;
    scheduleNotification.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseSchedule = () => resolve(undefined);
    }));
    render(<Harness getEntries={() => entries} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(scheduleNotification).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(scheduleNotification).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSchedule?.();
      await Promise.resolve();
    });
  });
});

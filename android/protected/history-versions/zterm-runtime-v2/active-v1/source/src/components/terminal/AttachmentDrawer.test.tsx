// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentDrawer } from './AttachmentDrawer';
import type { AttachmentEntry } from '../../lib/session-attachment-store';

const { scheduleNotification } = vi.hoisted(() => ({
  scheduleNotification: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: scheduleNotification,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    writeFile: vi.fn(async () => undefined),
    getUri: vi.fn(async () => ({ uri: 'file:///preview.png' })),
  },
}));

vi.mock('../../lib/notification-helper', () => ({
  ensureNotificationPermission: vi.fn(async () => true),
  nextNotificationId: vi.fn(() => 101),
}));

vi.mock('../../plugins/StoragePermissionPlugin', () => ({
  StoragePermissionPlugin: {
    saveToDownloads: vi.fn(async () => undefined),
  },
}));

function attachment(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  scheduleNotification.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['preview'], { type: 'image/png' }) })));
});

describe('AttachmentDrawer delivery UX', () => {
  function openPreview(overrides: Partial<AttachmentEntry> = {}) {
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => [attachment(overrides)]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByAltText('proof.png'));
    return screen.getByTestId('attachment-preview-image');
  }

  function pinchToScale(preview: HTMLElement, targetScale: number) {
    const startDist = 100;
    const endDist = startDist * targetScale;
    fireEvent.touchStart(preview, {
      touches: [
        { clientX: 20, clientY: 20 },
        { clientX: 20 + startDist, clientY: 20 },
      ],
    });
    fireEvent.touchMove(preview, {
      touches: [
        { clientX: 20, clientY: 20 },
        { clientX: 20 + endDist, clientY: 20 },
      ],
    });
    fireEvent.touchEnd(preview, { touches: [] });
  }

  function dragBy(preview: HTMLElement, dx: number, dy: number) {
    fireEvent.touchStart(preview, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(preview, { touches: [{ clientX: 10 + dx, clientY: 10 + dy }] });
    fireEvent.touchEnd(preview, { touches: [] });
  }

  it('supports pinch zoom and one-finger pan in the full-screen preview', () => {
    const preview = openPreview();
    const scaler = screen.getByTestId('attachment-preview-scaler');

    pinchToScale(preview, 2);
    expect(Number.parseFloat(scaler.style.width)).toBeCloseTo(0.9 * window.innerWidth * 2);
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth * 2) / 2);

    dragBy(preview, 35, 50);
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth * 2) / 2 + 35);
    expect(Number.parseFloat(scaler.style.top)).toBeCloseTo((window.innerHeight - 0.85 * window.innerHeight * 2) / 2 + 50);
  });

  it('resets pan when zooming back out to 1 so the image stays centered instead of a black screen', () => {
    const preview = openPreview();
    const scaler = screen.getByTestId('attachment-preview-scaler');

    pinchToScale(preview, 3);
    dragBy(preview, 220, 260);
    expect(Number.parseFloat(scaler.style.width)).toBeCloseTo(0.9 * window.innerWidth * 3);

    fireEvent.click(screen.getByRole('button', { name: '－' }));
    fireEvent.click(screen.getByRole('button', { name: '－' }));
    fireEvent.click(screen.getByRole('button', { name: '－' }));
    fireEvent.click(screen.getByRole('button', { name: '－' }));

    expect(Number.parseFloat(scaler.style.width)).toBeCloseTo(0.9 * window.innerWidth);
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth) / 2);
    expect(Number.parseFloat(scaler.style.top)).toBeCloseTo((window.innerHeight - 0.85 * window.innerHeight) / 2);
  });

  it('resets pan when double-tapping back to 1 so the image cannot stay off-screen', () => {
    const preview = openPreview();
    const scaler = screen.getByTestId('attachment-preview-scaler');

    pinchToScale(preview, 2.5);
    dragBy(preview, 300, 400);

    fireEvent.doubleClick(preview);
    expect(Number.parseFloat(scaler.style.width)).toBeCloseTo(0.9 * window.innerWidth);
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth) / 2);
    expect(Number.parseFloat(scaler.style.top)).toBeCloseTo((window.innerHeight - 0.85 * window.innerHeight) / 2);
  });

  it('clamps pan so the zoomed image cannot be dragged fully off-screen', () => {
    const preview = openPreview();
    const scaler = screen.getByTestId('attachment-preview-scaler');
    pinchToScale(preview, 3);

    dragBy(preview, 5000, 5000);

    // clamp 后图片边缘与视口平齐（居中位置），不允许完全拖出视口
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth) / 2);
    expect(Number.parseFloat(scaler.style.top)).toBeCloseTo((window.innerHeight - 0.85 * window.innerHeight) / 2);
  });

  it('resets zoom and pan when reopening the preview', () => {
    const first = openPreview();
    pinchToScale(first, 3);
    dragBy(first, 120, 90);

    fireEvent.click(screen.getByTestId('attachment-preview-close'));
    fireEvent.click(screen.getByAltText('proof.png'));
    const scaler = screen.getByTestId('attachment-preview-scaler');

    expect(Number.parseFloat(scaler.style.width)).toBeCloseTo(0.9 * window.innerWidth);
    expect(Number.parseFloat(scaler.style.left)).toBeCloseTo((window.innerWidth - 0.9 * window.innerWidth) / 2);
    expect(Number.parseFloat(scaler.style.top)).toBeCloseTo((window.innerHeight - 0.85 * window.innerHeight) / 2);
  });

  it('offers an explicit original receive action for an unreceived history item', async () => {
    const fetchAttachmentAsset = vi.fn(() => true);
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => [attachment({
          origin: 'history',
          acknowledgedPreview: true,
          acknowledgedOriginal: false,
        })]}
        fetchAttachmentAsset={fetchAttachmentAsset}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '接收原图' }));

    await waitFor(() => {
      expect(fetchAttachmentAsset).toHaveBeenCalledWith('att-test', 'original');
    });
  });

  it('lets an errored pending preview retry instead of opening an endless loading overlay', () => {
    const fetchAttachmentAsset = vi.fn(() => true);
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => [attachment({
          previewUrl: undefined,
          status: 'error',
          error: 'preview expired',
        })]}
        fetchAttachmentAsset={fetchAttachmentAsset}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('proof.png'));

    expect(fetchAttachmentAsset).toHaveBeenCalledWith('att-test', 'preview');
    expect(screen.queryByText('预览加载中...')).toBeNull();
  });

  it('shows an inline visible error when receiving the original fails immediately', () => {
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => [attachment({
          origin: 'history',
          acknowledgedPreview: true,
          acknowledgedOriginal: false,
        })]}
        fetchAttachmentAsset={() => false}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '接收原图' }));

    expect(screen.getByText('暂时无法接收原图，请检查连接后重试')).toBeTruthy();
  });

  it('shows a receiving state while the original download is in flight', () => {
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => [attachment({
          origin: 'history',
          acknowledgedPreview: true,
          acknowledgedOriginal: false,
        })]}
        fetchAttachmentAsset={() => true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '接收原图' }));

    expect(screen.getByText('接收中…')).toBeTruthy();
  });

  it('switches to 已接收 once the original arrives and originalUrl is set', () => {
    let entries = [attachment({
      origin: 'history',
      acknowledgedPreview: true,
      acknowledgedOriginal: false,
    })];
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => entries}
        fetchAttachmentAsset={() => true}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '接收原图' }));
    expect(screen.getByText('接收中…')).toBeTruthy();

    entries = [attachment({
      origin: 'history',
      acknowledgedPreview: true,
      acknowledgedOriginal: false,
      originalUrl: 'blob:original',
      status: 'complete',
    })];
    render(
      <AttachmentDrawer
        open
        getPendingAttachments={() => entries}
        fetchAttachmentAsset={() => true}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('已接收')).toBeTruthy();
  });
});

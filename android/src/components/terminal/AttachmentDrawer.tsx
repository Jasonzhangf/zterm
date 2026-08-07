/**
 * AttachmentDrawer - 显示从其他设备发送的附件列表
 * 
 * 支持功能：
 * - 预览图片（点击缩略图全屏预览）
 * - 下载原图
 * - 48h TTL 自动清理
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { ensureNotificationPermission, nextNotificationId } from '../../lib/notification-helper';
import type { AttachmentEntry } from '../../lib/session-attachment-store';

export interface AttachmentDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  /** 从 context 获取的附件列表 getter */
  getPendingAttachments: () => AttachmentEntry[];
  onClose: () => void;
  terminalShellSkin?: 'light' | 'blue' | 'black';
}

const SWIPE_CLOSE_THRESHOLD_PX = 48;

function buildAttachmentNotificationBody(entry: AttachmentEntry): string {
  const source = entry.sourceSession?.trim()
    ? `session ${entry.sourceSession.trim()} · ${entry.senderName || '未知'}`
    : (entry.senderName || '未知');
  return `来自 ${source}`;
}

async function writePreviewToCache(entry: AttachmentEntry): Promise<string | null> {
  if (!entry.previewUrl) return null;
  try {
    const response = await fetch(entry.previewUrl);
    const blob = await response.blob();
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const path = `zterm-preview-${entry.attachmentId}.png`;
    await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache });
    const uri = await Filesystem.getUri({ path, directory: Directory.Cache });
    return uri.uri;
  } catch (error) {
    console.warn('[AttachmentDrawer] failed to stage preview for notification:', error);
    return null;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function AttachmentDrawerComponent({
  open,
  topInsetPx = 0,
  bottomInsetPx = 0,
  getPendingAttachments,
  onClose,
  terminalShellSkin = 'light',
}: AttachmentDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [previewEntry, setPreviewEntry] = useState<AttachmentEntry | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const deltaX = e.touches[0].clientX - touchStartRef.current.x;
    if (deltaX > SWIPE_CLOSE_THRESHOLD_PX && Math.abs(e.touches[0].clientY - touchStartRef.current.y) < 30) {
      onClose();
      touchStartRef.current = null;
    }
  }, [onClose]);

  const handleTouchEnd = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  const handleDownloadOriginal = useCallback(async (entry: AttachmentEntry) => {
    if (!entry.originalUrl || downloading.has(entry.attachmentId)) return;
    setDownloading((prev) => new Set(prev).add(entry.attachmentId));
    try {
      const response = await fetch(entry.originalUrl);
      const blob = await response.blob();
      const filename = entry.fileName;
      // Save to downloads directory
      await Filesystem.writeFile({
        path: filename,
        data: blob,
        directory: Directory.Documents,
      });
      // Show notification
      await LocalNotifications.schedule({
        notifications: [{
          title: '下载完成',
          body: `${filename} 已保存`,
          id: nextNotificationId(),
        }],
      });
    } catch (err) {
      console.error('[AttachmentDrawer] Download failed:', err);
    } finally {
      setDownloading((prev) => {
        const next = new Set(prev);
        next.delete(entry.attachmentId);
        return next;
      });
    }
  }, [downloading]);

  const handlePreviewClose = useCallback(() => {
    setPreviewEntry(null);
  }, []);

  // Notify on new attachments once their preview is ready so the notification
  // can carry the image thumbnail, source session, sender and attachmentId.
  const prevNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const attachments = getPendingAttachments();
    const notified = new Set(prevNotifiedRef.current);
    for (const entry of attachments) {
      if (notified.has(entry.attachmentId)) continue;
      if (!entry.previewUrl) continue; // wait until the preview thumbnail is downloaded
      notified.add(entry.attachmentId);
      const entrySnapshot = entry;
      // Android 13+ requires runtime permission before notifications show.
      void ensureNotificationPermission().then(async (granted) => {
        if (!granted) return;
        const iconUri = await writePreviewToCache(entrySnapshot);
        return LocalNotifications.schedule({
          notifications: [{
            title: `📎 ${entrySnapshot.fileName}`,
            body: buildAttachmentNotificationBody(entrySnapshot),
            id: nextNotificationId(),
            ...(iconUri ? { largeIcon: iconUri } : {}),
            extra: { kind: 'attachment', attachmentId: entrySnapshot.attachmentId },
          }],
        }).catch((err) => {
          console.warn('[AttachmentDrawer] schedule notification failed:', err);
        });
      });
    }
    prevNotifiedRef.current = notified;
  });

  // Tap on an attachment notification -> open the drawer and jump straight
  // into the full-screen preview of that image.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ attachmentId?: string }>).detail;
      if (!detail?.attachmentId) return;
      const entry = getPendingAttachments().find((a) => a.attachmentId === detail.attachmentId);
      if (entry) {
        setPreviewEntry(entry);
      }
    };
    window.addEventListener('zterm:preview-attachment', handler);
    return () => window.removeEventListener('zterm:preview-attachment', handler);
  }, [getPendingAttachments]);

  const attachments = open ? getPendingAttachments() : [];
  const isEmpty = attachments.length === 0;

  // Shell skin theming
  const isDark = terminalShellSkin === 'black';
  const isBlue = terminalShellSkin === 'blue';
  const bgColor = isDark ? '#0d1117' : isBlue ? '#1a1a2e' : '#ffffff';
  const textColor = isDark ? '#e6edf3' : isBlue ? '#c9d1d9' : '#24292f';
  const secondaryTextColor = isDark ? '#8b949e' : isBlue ? '#8b949e' : '#57606a';
  const dividerColor = isDark ? '#30363d' : isBlue ? '#30363d' : '#e1e4e8';
  const itemBg = isDark ? '#161b22' : isBlue ? '#1e2433' : '#f6f8fa';
  const accentColor = '#3b7aff';

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          zIndex: 900,
        }}
      />

      {/* Drawer */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          position: 'fixed',
          top: topInsetPx,
          right: 0,
          bottom: bottomInsetPx,
          width: '85vw',
          maxWidth: 400,
          backgroundColor: bgColor,
          borderLeft: `1px solid ${dividerColor}`,
          zIndex: 901,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px',
            borderBottom: `1px solid ${dividerColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 600, color: textColor }}>
            附件 ({attachments.length})
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: secondaryTextColor,
              fontSize: 24,
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {isEmpty ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '50vh',
                color: secondaryTextColor,
              }}
            >
              <span style={{ fontSize: 40, marginBottom: 12 }}>📭</span>
              <span style={{ fontSize: 15 }}>暂无附件</span>
            </div>
          ) : (
            <div style={{ padding: '8px 0' }}>
              {attachments.map((entry) => (
                <div
                  key={entry.attachmentId}
                  style={{
                    display: 'flex',
                    padding: '10px 16px',
                    borderBottom: `1px solid ${dividerColor}`,
                    backgroundColor: itemBg,
                    cursor: 'pointer',
                  }}
                  onClick={() => setPreviewEntry(entry)}
                >
                  {/* Preview thumbnail */}
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 6,
                      backgroundColor: dividerColor,
                      flexShrink: 0,
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {entry.previewUrl ? (
                      <img
                        src={entry.previewUrl}
                        alt={entry.fileName}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : entry.status === 'error' ? (
                      <span style={{ fontSize: 20 }}>⚠️</span>
                    ) : (
                      <span style={{ fontSize: 20 }}>⏳</span>
                    )}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: textColor,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.fileName}
                    </div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginTop: 2 }}>
                      {entry.senderName} · {formatRelativeTime(entry.receivedAt)}
                    </div>
                    <div style={{ fontSize: 11, color: secondaryTextColor }}>
                      {formatFileSize(entry.previewSize)} → {formatFileSize(entry.originalSize)}
                    </div>
                  </div>

                  {/* Download button */}
                  {entry.status === 'complete' && entry.originalUrl && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadOriginal(entry);
                      }}
                      style={{
                        background: downloading.has(entry.attachmentId) ? dividerColor : accentColor,
                        border: 'none',
                        borderRadius: 6,
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 500,
                        padding: '4px 10px',
                        cursor: 'pointer',
                        alignSelf: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {downloading.has(entry.attachmentId) ? '保存中' : '保存'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        {!isEmpty && (
          <div
            style={{
              padding: '10px 16px',
              borderTop: `1px solid ${dividerColor}`,
              textAlign: 'center',
              fontSize: 12,
              color: secondaryTextColor,
            }}
          >
            附件保留 48 小时后自动删除
          </div>
        )}
      </div>

      {/* Preview overlay */}
      {previewEntry && (
        <div
          onClick={handlePreviewClose}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <button
            onClick={handlePreviewClose}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              borderRadius: 20,
              color: '#fff',
              fontSize: 20,
              width: 40,
              height: 40,
              cursor: 'pointer',
              zIndex: 1001,
            }}
          >
            ×
          </button>
          {previewEntry.previewUrl ? (
            <img
              src={previewEntry.previewUrl}
              alt={previewEntry.fileName}
              style={{
                maxWidth: '90vw',
                maxHeight: '85vh',
                objectFit: 'contain',
                borderRadius: 8,
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span style={{ color: '#fff', fontSize: 16 }}>预览加载中...</span>
          )}
          {previewEntry.status === 'complete' && previewEntry.originalUrl && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownloadOriginal(previewEntry);
              }}
              style={{
                position: 'absolute',
                bottom: 24,
                left: '50%',
                transform: 'translateX(-50%)',
                background: accentColor,
                border: 'none',
                borderRadius: 22,
                color: '#fff',
                fontSize: 15,
                fontWeight: 600,
                padding: '12px 28px',
                cursor: 'pointer',
              }}
            >
              {downloading.has(previewEntry.attachmentId) ? '保存中...' : '保存到本地'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

export const AttachmentDrawer = memo(AttachmentDrawerComponent);

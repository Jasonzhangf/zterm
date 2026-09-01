import { useEffect, useRef } from 'react';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { AttachmentEntry } from '../lib/session-attachment-store';
import { ensureNotificationPermission, nextNotificationId } from '../lib/notification-helper';

export interface UseAttachmentNotificationsOptions {
  getPendingAttachments?: () => AttachmentEntry[];
  pollIntervalMs?: number;
}

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
    console.warn('[attachment-notification] failed to stage preview:', error);
    return null;
  }
}

export function useAttachmentNotifications({
  getPendingAttachments,
  pollIntervalMs = 1_000,
}: UseAttachmentNotificationsOptions): void {
  const getPendingAttachmentsRef = useRef(getPendingAttachments);
  getPendingAttachmentsRef.current = getPendingAttachments;
  const notifiedRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const check = () => {
      const readAttachments = getPendingAttachmentsRef.current;
      if (typeof readAttachments !== 'function') return;
      for (const entry of readAttachments()) {
        if (entry.origin === 'history') continue;
        if (!entry.previewUrl
          || notifiedRef.current.has(entry.attachmentId)
          || failedRef.current.has(entry.attachmentId)
          || inFlightRef.current.has(entry.attachmentId)) continue;
        const snapshot = entry;
        inFlightRef.current.add(snapshot.attachmentId);
        void ensureNotificationPermission()
          .then(async (granted) => {
            if (!granted || notifiedRef.current.has(snapshot.attachmentId)) {
              if (!granted) failedRef.current.add(snapshot.attachmentId);
              return;
            }
            const iconUri = await writePreviewToCache(snapshot);
            if (snapshot.previewUrl && !iconUri) {
              failedRef.current.add(snapshot.attachmentId);
              return;
            }
            await LocalNotifications.schedule({
              notifications: [{
                title: `附件：${snapshot.fileName}`,
                body: buildAttachmentNotificationBody(snapshot),
                id: nextNotificationId(),
                ...(iconUri ? { largeIcon: iconUri } : {}),
                extra: { kind: 'attachment', attachmentId: snapshot.attachmentId },
              }],
            });
            notifiedRef.current.add(snapshot.attachmentId);
          })
          .catch((error) => {
            failedRef.current.add(snapshot.attachmentId);
            console.warn('[attachment-notification] delivery failed:', error);
          })
          .finally(() => {
            inFlightRef.current.delete(snapshot.attachmentId);
          });
      }
    };
    check();
    const timer = setInterval(check, pollIntervalMs);
    return () => clearInterval(timer);
  }, [pollIntervalMs]);
}

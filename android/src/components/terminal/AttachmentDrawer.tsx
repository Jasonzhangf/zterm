/**
 * AttachmentDrawer - 显示从其他设备发送的附件列表
 * 
 * 支持功能：
 * - 预览图片（点击缩略图全屏预览）
 * - 下载原图
 * - 48h TTL 自动清理
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import {
  blobToBase64,
  clampPanForScale,
  formatRelativeTime,
  formatFileSize,
  MAX_ZOOM,
  MIN_ZOOM,
} from './attachment-drawer-helpers';
import { LocalNotifications } from '@capacitor/local-notifications';
import { nextNotificationId } from '../../lib/notification-helper';
import { StoragePermissionPlugin } from '../../plugins/StoragePermissionPlugin';
import type { AttachmentEntry } from '../../lib/session-attachment-store';


const zoomButtonStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.15)',
  border: 'none',
  borderRadius: 20,
  color: '#fff',
  fontSize: 18,
  width: 40,
  height: 40,
  cursor: 'pointer',
  lineHeight: 1,
};

export interface AttachmentDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  /** 从 context 获取的附件列表 getter */
  getPendingAttachments: () => AttachmentEntry[];
  /** 查询 daemon 附件历史（含已确认收过的） */
  queryAttachmentHistory?: () => void;
  /** 重新拉取某个附件的 preview/original（历史重下载） */
  fetchAttachmentAsset?: (attachmentId: string, asset: 'preview' | 'original') => boolean;
  onClose: () => void;
  terminalShellSkin?: 'light' | 'blue' | 'black';
}

const SWIPE_CLOSE_THRESHOLD_PX = 48;

/**
 * 把 pan 限制在“图片放大后仍与视口有重叠”的范围内，避免把图片完全
 * 拖出视口后只看到黑色 overlay 背景。scale <= 1 时图片应居中，pan 归零。
 */



/**
 * 预览图缩放容器。
 *
 * 实现方式：纯布局缩放（width/height/left/top 按 scale 计算），img 用
 * object-fit: contain 填满容器。刻意**不使用 transform: scale**——
 * Android WebView 对"大图 transform scale 从 N>1 缩小到 1"存在光栅化
 * 自旋死循环（实测：缩小瞬间 renderer 进程 utime 每秒暴涨 ~2.8s CPU，
 * 屏幕黑屏，CDP/compositor 全部无响应；transform 终态无论 scale(1) 还是
 * none 都会触发）。布局缩放走常规重采样路径，不经过 transform 合成层。
 */
function PreviewScaler({
  scale,
  pan,
  onDoubleClick,
  src,
  fileName,
}: {
  scale: number;
  pan: { x: number; y: number };
  onDoubleClick: () => void;
  src: string;
  fileName: string;
}) {
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 360;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 640;
  const baseW = 0.9 * viewportW;
  const baseH = 0.85 * viewportH;
  const wrapperW = baseW * scale;
  const wrapperH = baseH * scale;
  return (
    <div
      data-testid="attachment-preview-scaler"
      style={{
        position: 'absolute',
        left: (viewportW - wrapperW) / 2 + pan.x,
        top: (viewportH - wrapperH) / 2 + pan.y,
        width: wrapperW,
        height: wrapperH,
        touchAction: 'none',
      }}
    >
      <img
        src={src}
        alt={fileName}
        data-testid="attachment-preview-image"
        onDoubleClick={onDoubleClick}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          touchAction: 'none',
          userSelect: 'none',
        }}
      />
    </div>
  );
}

function AttachmentDrawerComponent({
  open,
  topInsetPx = 0,
  bottomInsetPx = 0,
  getPendingAttachments,
  queryAttachmentHistory,
  fetchAttachmentAsset,
  onClose,
  terminalShellSkin = 'light',
}: AttachmentDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [previewEntry, setPreviewEntry] = useState<AttachmentEntry | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchQueue, setBatchQueue] = useState<Set<string>>(new Set());
  const [batchMessage, setBatchMessage] = useState('');
  const [receiveFeedback, setReceiveFeedback] = useState<{
    attachmentId: string;
    message: string;
    kind: 'error' | 'pending';
  } | null>(null);
  const batchTotalRef = useRef(0);
  const batchDoneCountRef = useRef(0);

  const applyZoom = useCallback((nextScaleRaw: number) => {
    const nextScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextScaleRaw));
    setScale(nextScale);
    // 缩小到 1（任何路径：按钮、双击、pinch）必须把图片拉回中心，否则
    // 残留的 pan 偏移会让图片停留在视口外，只剩黑色 overlay 背景（黑屏）。
    if (nextScale <= MIN_ZOOM) {
      setPan({ x: 0, y: 0 });
    } else {
      setPan((current) => clampPanForScale(current, nextScale));
    }
  }, []);

  // 重新打开预览时重置缩放/位移，避免上次预览的状态泄漏导致黑屏。
  const previousPreviewRef = useRef<AttachmentEntry | null>(null);
  useEffect(() => {
    if (previewEntry && previousPreviewRef.current === null) {
      setScale(1);
      setPan({ x: 0, y: 0 });
    }
    previousPreviewRef.current = previewEntry;
  }, [previewEntry]);

  const handlePreviewClose = useCallback(() => {
    setPreviewEntry(null);
    setScale(1);
    setPan({ x: 0, y: 0 });
    setPendingPreviewId(null);
  }, []);

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

  const saveEntryToDownloads = useCallback(async (entry: AttachmentEntry) => {
    if (!entry.originalUrl) return false;
    const response = await fetch(entry.originalUrl);
    const blob = await response.blob();
    const dataBase64 = await blobToBase64(blob);
    await StoragePermissionPlugin.saveToDownloads({
      dataBase64,
      fileName: entry.fileName,
      mimeType: entry.mimeType || 'application/octet-stream',
    });
    return true;
  }, []);

  const handleDownloadOriginal = useCallback(async (entry: AttachmentEntry) => {
    if (!entry.originalUrl || downloading.has(entry.attachmentId)) return;
    setDownloading((prev) => new Set(prev).add(entry.attachmentId));
    try {
      await saveEntryToDownloads(entry);
      // Show notification
      await LocalNotifications.schedule({
        notifications: [{
          title: '下载完成',
          body: `${entry.fileName} 已保存到下载目录`,
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
  }, [downloading, saveEntryToDownloads]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(getPendingAttachments().map((a) => a.attachmentId)));
  }, [getPendingAttachments]);

  const markBatchDone = useCallback(() => {
    batchDoneCountRef.current += 1;
    const done = batchDoneCountRef.current;
    if (done >= batchTotalRef.current) {
      setBatchMessage(`已保存 ${done} 个文件到下载目录`);
      LocalNotifications.schedule({
        notifications: [{
          title: '批量下载完成',
          body: `${done} 个文件已保存到下载目录`,
          id: nextNotificationId(),
        }],
      }).catch(() => {});
      setSelectionMode(false);
      setSelectedIds(new Set());
    } else {
      setBatchMessage(`下载中 ${done}/${batchTotalRef.current} ...`);
    }
  }, []);

  const handleBatchDownload = useCallback(() => {
    if (selectedIds.size === 0) return;
    batchTotalRef.current = selectedIds.size;
    batchDoneCountRef.current = 0;
    setBatchMessage(`准备下载 ${selectedIds.size} 个文件...`);
    for (const id of selectedIds) {
      const entry = getPendingAttachments().find((a) => a.attachmentId === id);
      if (!entry) continue;
      if (entry.originalUrl) {
        saveEntryToDownloads(entry)
          .then((ok) => { if (ok) markBatchDone(); })
          .catch(() => markBatchDone());
      } else if (fetchAttachmentAsset) {
        // 原图尚未下载：先通过 mux 拉取 original，轮询 effect 会在 originalUrl 出现后保存
        setBatchQueue((prev) => new Set(prev).add(id));
        fetchAttachmentAsset(id, 'original');
      } else {
        markBatchDone();
      }
    }
  }, [selectedIds, getPendingAttachments, saveEntryToDownloads, fetchAttachmentAsset, markBatchDone]);

  // 渲染时处理批量下载队列：originalUrl 出现后立即保存（store 非响应式，依赖轮询刷新驱动）
  useEffect(() => {
    if (batchQueue.size === 0) return;
    for (const id of batchQueue) {
      const entry = getPendingAttachments().find((a) => a.attachmentId === id);
      if (entry?.originalUrl) {
        setBatchQueue((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        saveEntryToDownloads(entry)
          .then((ok) => { if (ok) markBatchDone(); })
          .catch(() => markBatchDone());
      }
    }
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
        return;
      }
      // Cold start: the store may not have this attachment yet (Activity was
      // re-created). Pull the history list, then re-download + preview it.
      queryAttachmentHistory?.();
      window.setTimeout(() => {
        const after = getPendingAttachments().find((a) => a.attachmentId === detail.attachmentId);
        if (after) {
          setPendingPreviewId(after.attachmentId);
          fetchAttachmentAsset?.(after.attachmentId, 'preview');
        }
      }, 1200);
    };
    window.addEventListener('zterm:preview-attachment', handler);
    return () => window.removeEventListener('zterm:preview-attachment', handler);
  }, [getPendingAttachments, queryAttachmentHistory, fetchAttachmentAsset]);

  // History: always visible once loaded; load automatically whenever the
  // drawer opens so missed notifications can still be pulled up.
  const [historyLoaded, setHistoryLoaded] = useState(true);
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
  const [lastClickDiag, setLastClickDiag] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const autoFetchingRef = useRef<Set<string>>(new Set());
  const gestureRef = useRef<{
    mode: 'pinch' | 'pan' | null;
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    if (open) {
      setHistoryLoaded(true);
      queryAttachmentHistory?.();
    }
  }, [open, queryAttachmentHistory]);
  // 附件 store 是非响应式 ref：轮询触发重渲染，让 pendingPreviewId 检查与诊断面板跟随 store 变化刷新
  // 同时自动加载无预览条目的缩略图（限流：每个 tick 最多请求 1 个，避免请求风暴）
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setRefreshTick((t) => t + 1);
      if (fetchAttachmentAsset) {
        const entry = getPendingAttachments().find(
          (a) => !a.previewUrl && !autoFetchingRef.current.has(a.attachmentId),
        );
        if (entry) {
          autoFetchingRef.current.add(entry.attachmentId);
          fetchAttachmentAsset(entry.attachmentId, 'preview');
        }
      }
    }, 500);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!pendingPreviewId) return;
    const entry = getPendingAttachments().find((a) => a.attachmentId === pendingPreviewId);
    if (entry?.previewUrl) {
      setPreviewEntry(entry);
      setPendingPreviewId(null);
    }
  });

  const attachments = open ? getPendingAttachments() : [];
  const pendingItems = attachments.filter((a) => a.origin !== 'history');
  const historyItems = attachments.filter((a) => a.origin === 'history');
  const isEmpty = pendingItems.length === 0;

  const handleHistoryEntryClick = (entry: AttachmentEntry) => {
    if (entry.previewUrl) {
      setPreviewEntry(entry);
      setLastClickDiag(`预览已就绪: ${entry.attachmentId.slice(0, 8)} (直接打开)`);
      return;
    }
    if (fetchAttachmentAsset) {
      setPendingPreviewId(entry.attachmentId);
      const sent = fetchAttachmentAsset(entry.attachmentId, 'preview');
      setLastClickDiag(`请求: ${entry.attachmentId.slice(0, 8)} sent=${sent ? 'true' : 'false'}`);
    } else {
      setLastClickDiag(`无 fetchAttachmentAsset 能力 (${entry.attachmentId.slice(0, 8)})`);
    }
  };

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
            附件 ({pendingItems.length})
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {!selectionMode ? (
              <button
                onClick={() => setSelectionMode(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: accentColor,
                  fontSize: 14,
                  cursor: 'pointer',
                  padding: '4px 8px',
                }}
              >
                选择
              </button>
            ) : (
              <button
                onClick={() => {
                  setSelectionMode(false);
                  setSelectedIds(new Set());
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: textColor,
                  fontSize: 14,
                  cursor: 'pointer',
                  padding: '4px 8px',
                }}
              >
                取消
              </button>
            )}
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
        </div>
        {/* 诊断面板：附件链路状态（点击历史条目后的结果直接可见） */}
        <div
          style={{
            padding: '6px 16px',
            borderBottom: `1px solid ${dividerColor}`,
            fontSize: 11,
            color: secondaryTextColor,
            fontFamily: 'monospace',
            lineHeight: 1.5,
          }}
        >
          <div>pending={pendingItems.length} history={historyItems.length} refresh={refreshTick}</div>
          <div>预览={previewEntry ? '已打开' : '未打开'}{lastClickDiag ? ` | 上次点击: ${lastClickDiag}` : ''}</div>
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
              {pendingItems.map((entry) => (
                <div
                  key={entry.attachmentId}
                  style={{
                    display: 'flex',
                    padding: '10px 16px',
                    borderBottom: `1px solid ${dividerColor}`,
                    backgroundColor: selectedIds.has(entry.attachmentId) ? `${accentColor}26` : itemBg,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    if (selectionMode) {
                      toggleSelected(entry.attachmentId);
                      return;
                    }
                    if (entry.previewUrl) {
                      setPreviewEntry(entry);
                      return;
                    }
                    autoFetchingRef.current.delete(entry.attachmentId);
                    handleHistoryEntryClick(entry);
                  }}
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
                  {entry.status === 'error' && (
                    <div
                      style={{
                        fontSize: 11,
                        color: '#cf222e',
                        alignSelf: 'center',
                        maxWidth: 120,
                        flexShrink: 0,
                      }}
                    >
                      {entry.error || '接收失败'}
                    </div>
                  )}
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

        {/* History */}
        {historyLoaded && historyItems.length > 0 && (
          <div style={{ borderTop: `1px solid ${dividerColor}` }}>
            <div
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                color: secondaryTextColor,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>历史文件</span>
              <span style={{ fontSize: 11, fontWeight: 400 }}>{historyItems.length} 个</span>
            </div>
            <div style={{ padding: '0 0 8px' }}>
              {historyItems.map((entry) => (
                <div
                  key={entry.attachmentId}
                  style={{
                    display: 'flex',
                    padding: '10px 16px',
                    borderBottom: `1px solid ${dividerColor}`,
                    backgroundColor: selectedIds.has(entry.attachmentId) ? `${accentColor}26` : itemBg,
                    cursor: 'pointer',
                  }}
                  onClick={() =>
                    selectionMode
                      ? toggleSelected(entry.attachmentId)
                      : handleHistoryEntryClick(entry)
                  }
                >
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
                      fontSize: 24,
                    }}
                  >
                    {entry.previewUrl ? (
                      <img
                        src={entry.previewUrl}
                        alt={entry.fileName}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : autoFetchingRef.current.has(entry.attachmentId) ? (
                      <span style={{ fontSize: 20 }}>⏳</span>
                    ) : (
                      '🖼️'
                    )}
                  </div>
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
                      {entry.previewUrl ? '点击预览' : '点击重新下载'}
                    </div>
                  </div>
                  {entry.status === 'error' ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: '#cf222e',
                        alignSelf: 'center',
                        maxWidth: 110,
                        flexShrink: 0,
                      }}
                    >
                      {entry.error || '接收失败'}
                    </span>
                  ) : entry.acknowledgedOriginal || Boolean(entry.originalUrl) ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: '#2da44e',
                        alignSelf: 'center',
                        flexShrink: 0,
                      }}
                    >
                      已接收
                    </span>
                  ) : receiveFeedback && receiveFeedback.attachmentId === entry.attachmentId ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: receiveFeedback.kind === 'error' ? '#cf222e' : accentColor,
                        alignSelf: 'center',
                        maxWidth: 110,
                        flexShrink: 0,
                      }}
                    >
                      {receiveFeedback.message}
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!fetchAttachmentAsset?.(entry.attachmentId, 'original')) {
                          setReceiveFeedback({
                            attachmentId: entry.attachmentId,
                            message: '暂时无法接收原图，请检查连接后重试',
                            kind: 'error',
                          });
                        } else {
                          setReceiveFeedback({
                            attachmentId: entry.attachmentId,
                            message: '接收中…',
                            kind: 'pending',
                          });
                        }
                      }}
                      style={{
                        background: accentColor,
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
                      接收原图
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            padding: '8px 16px',
            borderTop: `1px solid ${dividerColor}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {!isEmpty && (
            <span style={{ fontSize: 11, color: secondaryTextColor }}>
              附件保留 48 小时后自动删除
            </span>
          )}
          {selectionMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: secondaryTextColor }}>
                {batchMessage || `已选 ${selectedIds.size} 项`}
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={selectAll}
                style={{
                  background: 'none',
                  border: `1px solid ${dividerColor}`,
                  borderRadius: 18,
                  color: textColor,
                  fontSize: 14,
                  cursor: 'pointer',
                  padding: '8px 16px',
                }}
              >
                全选
              </button>
              <button
                onClick={handleBatchDownload}
                disabled={selectedIds.size === 0 || batchMessage.startsWith('下载中')}
                style={{
                  background: accentColor,
                  border: 'none',
                  borderRadius: 18,
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '8px 18px',
                  opacity: selectedIds.size === 0 ? 0.5 : 1,
                }}
              >
                下载 ({selectedIds.size})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Preview overlay */}
      {previewEntry && (
        <div
          onClick={handlePreviewClose}
          onTouchStart={(e) => {
            e.stopPropagation();
            if (e.touches.length >= 2) {
              const d = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
              );
              gestureRef.current = { mode: 'pinch', startDist: d, startScale: scale, startX: 0, startY: 0, startPan: pan };
            } else if (e.touches.length === 1) {
              gestureRef.current = {
                mode: 'pan',
                startDist: 0,
                startScale: scale,
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startPan: pan,
              };
            }
          }}
          onTouchMove={(e) => {
            e.stopPropagation();
            const g = gestureRef.current;
            if (!g) return;
            if (g.mode === 'pinch' && e.touches.length >= 2) {
              const d = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
              );
              if (d > 0 && g.startDist > 0) {
                applyZoom(g.startScale * (d / g.startDist));
              }
            } else if (g.mode === 'pan' && e.touches.length === 1 && g.startScale > MIN_ZOOM) {
              setPan(clampPanForScale({
                x: g.startPan.x + (e.touches[0].clientX - g.startX),
                y: g.startPan.y + (e.touches[0].clientY - g.startY),
              }, g.startScale));
            }
          }}
          onTouchEnd={() => {
            gestureRef.current = null;
          }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none',
          }}
        >
          <button
            data-testid="attachment-preview-close"
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
            <PreviewScaler
              scale={scale}
              pan={pan}
              onDoubleClick={() => applyZoom(scale > MIN_ZOOM ? MIN_ZOOM : 2.5)}
              src={previewEntry.previewUrl}
              fileName={previewEntry.fileName}
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
          {/* 缩放控制（移动端 pinch 的补充入口） */}
          <div
            style={{
              position: 'absolute',
              bottom: 90,
              right: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                applyZoom(scale + 0.5);
              }}
              style={zoomButtonStyle}
            >
              ＋
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                applyZoom(scale - 0.5);
              }}
              style={zoomButtonStyle}
            >
              －
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export const AttachmentDrawer = memo(AttachmentDrawerComponent);

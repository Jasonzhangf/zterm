import { useCallback, useEffect, useRef, useState } from 'react';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { mobileTheme } from '../../lib/mobile-ui';
import type {
  FileEntry,
  FileListRequestPayload,
  FileListResponsePayload,
  FileDownloadRequestPayload,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileUploadStartPayload,
  FileUploadChunkPayload,
  FileUploadEndPayload,
  TransferProgress,
} from '../../lib/types';

const FILE_CHUNK_SIZE = 256 * 1024; // 256KB per chunk (must match daemon)

interface FileTransferSheetProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson: (msg: unknown) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
}

interface RemoteFileEntry extends FileEntry {}
interface LocalFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
  uri?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 2) + '…';
}

const sheetOverlayStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 92,
  background: 'rgba(5, 8, 14, 0.82)',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'stretch',
};

const sheetContainerStyle = {
  width: '100%',
  height: '88vh',
  display: 'flex',
  flexDirection: 'column' as const,
  borderTopLeftRadius: '20px',
  borderTopRightRadius: '20px',
  border: `1px solid ${mobileTheme.colors.cardBorder}`,
  background: mobileTheme.colors.shell,
  boxShadow: '0 -16px 40px rgba(0,0,0,0.32)',
  overflow: 'hidden',
};

const headerStyle = {
  padding: '12px 14px 8px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0,
};

const fileListContainerStyle = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto' as const,
  WebkitOverflowScrolling: 'touch' as const,
  padding: '4px 10px',
};

const fileRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: '10px',
  cursor: 'pointer',
};

const fileCheckboxStyle = (checked: boolean) => ({
  width: '18px',
  height: '18px',
  borderRadius: '4px',
  border: checked ? `2px solid ${mobileTheme.colors.accent}` : '2px solid rgba(255,255,255,0.25)',
  background: checked ? mobileTheme.colors.accent : 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  color: '#000',
  fontSize: '12px',
  fontWeight: 800,
});

const pathBreadcrumbStyle = {
  fontSize: '12px',
  color: mobileTheme.colors.textSecondary,
  padding: '2px 10px 6px',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
  overflowX: 'auto' as const,
  whiteSpace: 'nowrap' as const,
};

const actionButtonStyle = (bg: string, color: string) => ({
  minHeight: '36px',
  padding: '0 14px',
  borderRadius: '12px',
  border: 'none',
  background: bg,
  color,
  fontWeight: 700,
  fontSize: '14px',
  cursor: 'pointer',
  flexShrink: 0,
});

const sectionLabelStyle = {
  fontSize: '13px',
  fontWeight: 700,
  color: mobileTheme.colors.textPrimary,
  padding: '6px 10px 2px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const progressRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 10px',
  fontSize: '12px',
  color: mobileTheme.colors.textSecondary,
};

export function FileTransferSheet({
  open,
  remoteCwd,
  onClose,
  sendJson,
  onFileTransferMessage,
}: FileTransferSheetProps) {
  const sendJsonRef = useRef(sendJson);
  useEffect(() => {
    sendJsonRef.current = sendJson;
  }, [sendJson]);

  // Remote state
  const [remotePath, setRemotePath] = useState('');
  const [remoteEntries, setRemoteEntries] = useState<RemoteFileEntry[]>([]);
  const [remoteParentPath, setRemoteParentPath] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [showHiddenRemote, setShowHiddenRemote] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());

  // Local state
  const [localPath, setLocalPath] = useState('/storage/emulated/0/Download/zterm');
  const [localEntries, setLocalEntries] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());

  // Direction
  const [direction, setDirection] = useState<'upload' | 'download'>('download');

  // Transfers
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);

  // Request tracking
  const activeListRequestRef = useRef<string | null>(null);
  const activeDownloadRequestRef = useRef<string | null>(null);
  const downloadChunksRef = useRef<Map<number, string>>(new Map());
  const transferDoneCallbacksRef = useRef<Map<string, () => void>>(new Map());

  // Request remote file list
  const requestRemoteList = useCallback((path: string, showHidden: boolean) => {
    const requestId = `flist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    activeListRequestRef.current = requestId;
    setRemoteLoading(true);
    const payload: FileListRequestPayload = { requestId, path, showHidden };
    sendJsonRef.current({ type: 'file-list-request', payload });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const initialRemotePath = remoteCwd.trim();
    setRemotePath(initialRemotePath);
    setRemoteParentPath(null);
    setRemoteEntries([]);
    setSelectedRemote(new Set());
    setSelectedLocal(new Set());
    setTransfers([]);
    requestRemoteList(initialRemotePath, showHiddenRemote);
  }, [open, remoteCwd, requestRemoteList, showHiddenRemote]);

  // Load local directory
  const loadLocalDir = useCallback(async (path: string, showHidden: boolean) => {
    setLocalLoading(true);
    try {
      const result = await Filesystem.readdir({ path, directory: Directory.ExternalStorage });
      const entries: LocalFileEntry[] = [];
      for (const entry of result.files) {
        if (!showHidden && entry.name.startsWith('.')) continue;
        const type = entry.type === 'directory' ? 'directory' : 'file';
        let size = 0;
        if (type === 'file') {
          try {
            const stat = await Filesystem.stat({ path: `${path}/${entry.name}`, directory: Directory.ExternalStorage });
            size = stat.size;
          } catch { /* skip */ }
        }
        entries.push({ name: entry.name, type, size, modified: 0, uri: entry.uri });
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setLocalEntries(entries);
    } catch (err) {
      console.warn('[FileTransferSheet] local readdir failed:', err);
      setLocalEntries([]);
    }
    setLocalLoading(false);
  }, []);

  useEffect(() => {
    if (open && localPath) {
      loadLocalDir(localPath, showHiddenLocal);
    }
  }, [open, localPath, showHiddenLocal, loadLocalDir]);

  // Listen for daemon file-transfer messages
  useEffect(() => {
    if (!open || !onFileTransferMessage) return;
    return onFileTransferMessage((msg: any) => {
      if (msg.type === 'file-list-response') {
        const payload = msg.payload as FileListResponsePayload;
        if (activeListRequestRef.current !== payload.requestId) return;
        activeListRequestRef.current = null;
        setRemotePath(payload.path);
        setRemoteParentPath(payload.parentPath);
        setRemoteEntries(payload.entries);
        setRemoteLoading(false);
      } else if (msg.type === 'file-list-error') {
        activeListRequestRef.current = null;
        setRemoteLoading(false);
      } else if (msg.type === 'file-download-chunk') {
        const payload = msg.payload as FileDownloadChunkPayload;
        if (activeDownloadRequestRef.current !== payload.requestId) return;
        downloadChunksRef.current.set(payload.chunkIndex, payload.dataBase64);
        setTransfers(prev => prev.map(t =>
          t.id === payload.requestId
            ? { ...t, transferredBytes: t.transferredBytes + 1, status: 'transferring' as const }
            : t
        ));
      } else if (msg.type === 'file-download-complete') {
        const payload = msg.payload as FileDownloadCompletePayload;
        if (activeDownloadRequestRef.current !== payload.requestId) return;
        activeDownloadRequestRef.current = null;
        transferDoneCallbacksRef.current.get(payload.requestId)?.();
        transferDoneCallbacksRef.current.delete(payload.requestId);
        // Reassemble and write to local
        void reassembleDownload(payload);
      } else if (msg.type === 'file-download-error') {
        activeDownloadRequestRef.current = null;
        transferDoneCallbacksRef.current.get(msg.payload.requestId)?.();
        transferDoneCallbacksRef.current.delete(msg.payload.requestId);
        setTransfers(prev => prev.map(t =>
          t.id === msg.payload.requestId ? { ...t, status: 'error' as const, error: msg.payload.error } : t
        ));
      } else if (msg.type === 'file-upload-progress') {
        const payload = msg.payload as any;
        setTransfers(prev => prev.map(t =>
          t.id === payload.requestId
            ? { ...t, transferredBytes: payload.chunkIndex, status: 'transferring' as const }
            : t
        ));
      } else if (msg.type === 'file-upload-complete') {
        const payload = msg.payload as any;
        setTransfers(prev => prev.map(t =>
          t.id === payload.requestId ? { ...t, status: 'done' as const, transferredBytes: t.totalBytes } : t
        ));
        transferDoneCallbacksRef.current.get(payload.requestId)?.();
        transferDoneCallbacksRef.current.delete(payload.requestId);
      } else if (msg.type === 'file-upload-error') {
        setTransfers(prev => prev.map(t =>
          t.id === msg.payload.requestId ? { ...t, status: 'error' as const, error: msg.payload.error } : t
        ));
        transferDoneCallbacksRef.current.get(msg.payload.requestId)?.();
        transferDoneCallbacksRef.current.delete(msg.payload.requestId);
      }
    });
  }, [open, onFileTransferMessage]);

  // Reassemble downloaded chunks and write to local
  const reassembleDownload = useCallback(async (payload: FileDownloadCompletePayload) => {
    try {
      const chunks = downloadChunksRef.current;
      downloadChunksRef.current = new Map();
      const sortedBase64: string[] = [];
      for (let i = 0; i < (chunks.size || 0); i++) {
        const chunk = chunks.get(i);
        if (chunk) sortedBase64.push(chunk);
      }
      const combined = sortedBase64.join('');
      const downloadDir = localPath || '/storage/emulated/0/Download/zterm';

      // Ensure directory exists
      try {
        await Filesystem.mkdir({ path: downloadDir, directory: Directory.ExternalStorage, recursive: true });
      } catch { /* may already exist */ }

      await Filesystem.writeFile({
        path: `${downloadDir}/${payload.fileName}`,
        data: combined,
        directory: Directory.ExternalStorage,
      });

      setTransfers(prev => prev.map(t =>
        t.id === payload.requestId ? { ...t, status: 'done' as const, transferredBytes: t.totalBytes } : t
      ));
      loadLocalDir(downloadDir, showHiddenLocal);
    } catch (err) {
      setTransfers(prev => prev.map(t =>
        t.id === payload.requestId ? { ...t, status: 'error' as const, error: String(err) } : t
      ));
    }
  }, [localPath, showHiddenLocal, loadLocalDir]);

  // Toggle selection
  const toggleRemote = useCallback((name: string) => {
    setSelectedRemote(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleLocal = useCallback((name: string) => {
    setSelectedLocal(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const navigateRemotePath = useCallback((path: string) => {
    setRemotePath(path);
    setSelectedRemote(new Set());
    requestRemoteList(path, showHiddenRemote);
  }, [requestRemoteList, showHiddenRemote]);

  // Start transfer
  const startTransfer = useCallback(async () => {
    if (direction === 'download') {
      // Download selected remote files
      for (const name of selectedRemote) {
        const entry = remoteEntries.find(e => e.name === name);
        if (!entry || entry.type !== 'file') continue;
        const requestId = `fdl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const remoteFilePath = remotePath === '/' ? `/${name}` : `${remotePath}/${name}`;
        activeDownloadRequestRef.current = requestId;
        downloadChunksRef.current = new Map();
        setTransfers(prev => [...prev, {
          id: requestId,
          fileName: name,
          direction: 'download',
          totalBytes: entry.size,
          transferredBytes: 0,
          status: 'transferring',
        }]);
        const payload: FileDownloadRequestPayload = {
          requestId,
          remotePath: remoteFilePath,
          fileName: name,
          totalBytes: entry.size,
        };
        sendJson({ type: 'file-download-request', payload });
        // Wait for this download to finish before starting next
        await new Promise<void>((resolve) => {
          transferDoneCallbacksRef.current.set(requestId, resolve);
          setTimeout(() => {
            transferDoneCallbacksRef.current.delete(requestId);
            resolve();
          }, 60000);
        });
      }
      setSelectedRemote(new Set());
    } else {
      // Upload selected local files
      for (const name of selectedLocal) {
        const entry = localEntries.find(e => e.name === name);
        if (!entry || entry.type !== 'file') continue;
        const requestId = `ful-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          const readResult = await Filesystem.readFile({
            path: `${localPath}/${name}`,
            directory: Directory.ExternalStorage,
          });
          const base64 = typeof readResult.data === 'string' ? readResult.data : '';
          const chunkCount = Math.ceil(base64.length / (FILE_CHUNK_SIZE * 4 / 3)); // base64 overhead
          const targetDir = remotePath.trim();
          if (!targetDir) {
            throw new Error('remote path unavailable');
          }

          setTransfers(prev => [...prev, {
            id: requestId,
            fileName: name,
            direction: 'upload',
            totalBytes: entry.size,
            transferredBytes: 0,
            status: 'transferring',
          }]);

          const startPayload: FileUploadStartPayload = {
            requestId,
            targetDir,
            fileName: name,
            fileSize: entry.size,
            chunkCount,
          };
          sendJson({ type: 'file-upload-start', payload: startPayload });

          // Split base64 into chunks and send
          for (let i = 0; i < chunkCount; i++) {
            const start = i * FILE_CHUNK_SIZE;
            const end = Math.min(start + FILE_CHUNK_SIZE, base64.length);
            const chunk = base64.slice(start, end);
            const chunkPayload: FileUploadChunkPayload = { requestId, chunkIndex: i, dataBase64: chunk };
            sendJson({ type: 'file-upload-chunk', payload: chunkPayload });
          }

          const endPayload: FileUploadEndPayload = { requestId };
          sendJson({ type: 'file-upload-end', payload: endPayload });
        } catch (err) {
          setTransfers(prev => [...prev, {
            id: requestId,
            fileName: name,
            direction: 'upload',
            totalBytes: entry.size,
            transferredBytes: 0,
            status: 'error',
            error: String(err),
          }]);
        }
      }
      setSelectedLocal(new Set());
      // Refresh remote list
      requestRemoteList(remotePath, showHiddenRemote);
    }
  }, [direction, selectedRemote, selectedLocal, remoteEntries, localEntries, remotePath, localPath, sendJson, transfers, requestRemoteList, showHiddenRemote]);

  if (!open) return null;

  return (
    <div style={sheetOverlayStyle} onClick={onClose}>
      <div style={sheetContainerStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ fontSize: '17px', fontWeight: 800, color: mobileTheme.colors.textPrimary }}>文件传输</div>
          <button type="button" onClick={onClose} style={actionButtonStyle(mobileTheme.colors.shellMuted, '#fff')}>✕</button>
        </div>

        {/* Remote panel */}
        <div style={sectionLabelStyle}>
          <span>🖥 远程: {truncateName(remotePath, 40)}</span>
          <button
            type="button"
            onClick={() => setShowHiddenRemote(v => !v)}
            style={{ ...actionButtonStyle('transparent', mobileTheme.colors.textSecondary), minHeight: '24px', padding: '0 8px', fontSize: '11px' }}
          >
            {showHiddenRemote ? '隐藏' : '显示'} .文件
          </button>
        </div>
        <div style={pathBreadcrumbStyle}>
          <button type="button" onClick={() => remoteParentPath && navigateRemotePath(remoteParentPath)}
            style={{ ...actionButtonStyle('transparent', mobileTheme.colors.accent), minHeight: '24px', padding: '0 6px', fontSize: '12px' }}>
            ← 上级
          </button>
          <span style={{ color: mobileTheme.colors.textMuted }}>{remotePath}</span>
        </div>
        <div style={{ ...fileListContainerStyle, maxHeight: '28vh', flex: 'none' }}>
          {remoteLoading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: mobileTheme.colors.textMuted }}>加载中…</div>
          ) : remoteEntries.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: mobileTheme.colors.textMuted }}>空目录</div>
          ) : remoteEntries.map(entry => (
            <div key={entry.name} style={fileRowStyle} onClick={() => {
              if (entry.type === 'directory') {
                navigateRemotePath(remotePath === '/' ? `/${entry.name}` : `${remotePath}/${entry.name}`);
              } else {
                toggleRemote(entry.name);
              }
            }}>
              <div style={fileCheckboxStyle(selectedRemote.has(entry.name))}>
                {selectedRemote.has(entry.name) ? '✓' : ''}
              </div>
              <span style={{ fontSize: '16px', flexShrink: 0 }}>{entry.type === 'directory' ? '📁' : '📄'}</span>
              <span style={{ flex: 1, fontSize: '13px', color: mobileTheme.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
              </span>
              {entry.type === 'file' && (
                <span style={{ fontSize: '11px', color: mobileTheme.colors.textMuted, flexShrink: 0 }}>{formatBytes(entry.size)}</span>
              )}
            </div>
          ))}
        </div>

        {/* Direction controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '8px 10px', flexShrink: 0 }}>
          <button type="button" onClick={() => setDirection('download')} style={actionButtonStyle(
            direction === 'download' ? 'rgba(31,214,122,0.22)' : mobileTheme.colors.shellMuted,
            direction === 'download' ? mobileTheme.colors.accent : '#fff'
          )}>⬇ 下载到本地</button>
          <button type="button" onClick={startTransfer} style={actionButtonStyle(
            'linear-gradient(180deg, rgba(96, 149, 255, 0.92), rgba(72, 122, 230, 0.92))',
            '#fff'
          )}>
            {direction === 'download' ? `传输 ${selectedRemote.size} 项` : `传输 ${selectedLocal.size} 项`}
          </button>
          <button type="button" onClick={() => setDirection('upload')} style={actionButtonStyle(
            direction === 'upload' ? 'rgba(31,214,122,0.22)' : mobileTheme.colors.shellMuted,
            direction === 'upload' ? mobileTheme.colors.accent : '#fff'
          )}>⬆ 上传到远程</button>
        </div>

        {/* Local panel */}
        <div style={sectionLabelStyle}>
          <span>📱 本地: {truncateName(localPath, 40)}</span>
          <button
            type="button"
            onClick={() => setShowHiddenLocal(v => !v)}
            style={{ ...actionButtonStyle('transparent', mobileTheme.colors.textSecondary), minHeight: '24px', padding: '0 8px', fontSize: '11px' }}
          >
            {showHiddenLocal ? '隐藏' : '显示'} .文件
          </button>
        </div>
        <div style={pathBreadcrumbStyle}>
          <button type="button" onClick={() => {
            const parts = localPath.split('/');
            parts.pop();
            setLocalPath(parts.join('/') || '/');
            setSelectedLocal(new Set());
          }} style={{ ...actionButtonStyle('transparent', mobileTheme.colors.accent), minHeight: '24px', padding: '0 6px', fontSize: '12px' }}>
            ← 上级
          </button>
          <span style={{ color: mobileTheme.colors.textMuted }}>{localPath}</span>
        </div>
        <div style={{ ...fileListContainerStyle, maxHeight: '22vh', flex: 'none' }}>
          {localLoading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: mobileTheme.colors.textMuted }}>加载中…</div>
          ) : localEntries.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: mobileTheme.colors.textMuted }}>空目录</div>
          ) : localEntries.map(entry => (
            <div key={entry.name} style={fileRowStyle} onClick={() => {
              if (entry.type === 'directory') {
                setLocalPath(localPath === '/' ? `/${entry.name}` : `${localPath}/${entry.name}`);
                setSelectedLocal(new Set());
              } else {
                toggleLocal(entry.name);
              }
            }}>
              <div style={fileCheckboxStyle(selectedLocal.has(entry.name))}>
                {selectedLocal.has(entry.name) ? '✓' : ''}
              </div>
              <span style={{ fontSize: '16px', flexShrink: 0 }}>{entry.type === 'directory' ? '📁' : '📄'}</span>
              <span style={{ flex: 1, fontSize: '13px', color: mobileTheme.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
              </span>
              {entry.type === 'file' && (
                <span style={{ fontSize: '11px', color: mobileTheme.colors.textMuted, flexShrink: 0 }}>{formatBytes(entry.size)}</span>
              )}
            </div>
          ))}
        </div>

        {/* Transfer progress */}
        {transfers.length > 0 && (
          <div style={{ flexShrink: 0, padding: '6px 0', borderTop: `1px solid ${mobileTheme.colors.cardBorder}` }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.textSecondary, padding: '2px 10px 4px' }}>传输进度</div>
            {transfers.map(t => (
              <div key={t.id} style={progressRowStyle}>
                <span style={{ fontSize: '14px', flexShrink: 0 }}>{t.direction === 'download' ? '⬇' : '⬆'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.fileName}</span>
                <span style={{ flexShrink: 0, color: t.status === 'done' ? mobileTheme.colors.accent : t.status === 'error' ? mobileTheme.colors.danger : mobileTheme.colors.textMuted }}>
                  {t.status === 'done' ? '✓ 完成' : t.status === 'error' ? `✗ ${t.error || '错误'}` : `${formatBytes(t.transferredBytes * FILE_CHUNK_SIZE)} / ${formatBytes(t.totalBytes)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

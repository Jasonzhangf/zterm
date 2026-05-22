import { useCallback, useEffect, useRef, useState } from 'react';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { mobileTheme } from '../../lib/mobile-ui';
import { createFileTransferSessionRuntime } from '../../lib/file-transfer-session-runtime';
import { StoragePermissionPlugin } from '../../plugins/StoragePermissionPlugin';
import type {
  FileEntry,
  FileListRequestPayload,
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
  const fileTransferRuntimeRef = useRef(createFileTransferSessionRuntime({
    onDownloadComplete: async (payload, orderedChunksBase64) => {
      try {
        const combined = orderedChunksBase64.join('');
        const downloadDir = localPath || '/storage/emulated/0/Download/zterm';
        try {
          await Filesystem.mkdir({ path: downloadDir, directory: Directory.ExternalStorage, recursive: true });
        } catch (mkdirError) { console.warn('[FileTransferSheet] mkdir failed (may already exist):', mkdirError); }

        await Filesystem.writeFile({
          path: `${downloadDir}/${payload.fileName}`,
          data: combined,
          directory: Directory.ExternalStorage,
        });
        loadLocalDir(downloadDir, showHiddenLocal);
      } catch (error) {
        fileTransferRuntimeRef.current.markDownloadWriteError(
          payload.requestId,
          error instanceof Error ? error.message : String(error),
        );
        forceRuntimeTick((value) => value + 1);
      }
    },
  }));
  const [, forceRuntimeTick] = useState(0);
  const runtimeState = fileTransferRuntimeRef.current.getState();
  const remotePath = runtimeState.remotePath;
  const remoteEntries = runtimeState.remoteEntries as RemoteFileEntry[];
  const remoteParentPath = runtimeState.remoteParentPath;
  const remoteLoading = runtimeState.remoteLoading;
  const [showHiddenRemote, setShowHiddenRemote] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());

  // Local state
  const [localPath, setLocalPath] = useState('/storage/emulated/0/Download/zterm');
  const [localEntries, setLocalEntries] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localPermissionGranted, setLocalPermissionGranted] = useState<boolean | null>(null);
  const [localPermissionError, setLocalPermissionError] = useState<string | null>(null);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());

  // Direction
  const [direction, setDirection] = useState<'upload' | 'download'>('download');

  // Transfers
  const transfers = runtimeState.transfers as TransferProgress[];

  // Request remote file list
  const requestRemoteList = useCallback((path: string, showHidden: boolean) => {
    const request = fileTransferRuntimeRef.current.requestRemoteList(path, showHidden);
    const payload: FileListRequestPayload = request.message.payload;
    sendJsonRef.current({ type: 'file-list-request', payload });
    forceRuntimeTick((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const initialRemotePath = remoteCwd.trim();
    fileTransferRuntimeRef.current.open(initialRemotePath);
    setSelectedRemote(new Set());
    setSelectedLocal(new Set());
    forceRuntimeTick((value) => value + 1);
    requestRemoteList(initialRemotePath, showHiddenRemote);
  }, [open, remoteCwd, requestRemoteList, showHiddenRemote]);

  const checkLocalStoragePermission = useCallback(async () => {
    try {
      const status = await StoragePermissionPlugin.check();
      setLocalPermissionGranted(status.granted);
      setLocalPermissionError(status.granted ? null : '本地文件同步需要存储权限；请在 daemon/应用安装设置中一次性授权。');
      return status.granted;
    } catch (error) {
      setLocalPermissionGranted(false);
      setLocalPermissionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  // Load local directory
  const loadLocalDir = useCallback(async (path: string, showHidden: boolean) => {
    setLocalLoading(true);
    try {
      const permissionGranted = await checkLocalStoragePermission();
      if (!permissionGranted) {
        setLocalEntries([]);
        return;
      }
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
          } catch (statError) { console.warn('[FileTransferSheet] stat failed for', entry.name, statError); }
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
    } finally {
      setLocalLoading(false);
    }
  }, [checkLocalStoragePermission]);

  useEffect(() => {
    if (open && localPath) {
      loadLocalDir(localPath, showHiddenLocal);
    }
  }, [open, localPath, showHiddenLocal, loadLocalDir]);

  // Listen for daemon file-transfer messages
  useEffect(() => {
    if (!open || !onFileTransferMessage) return;
    return onFileTransferMessage((msg: any) => {
      void fileTransferRuntimeRef.current.applyMessage(msg).then((handled) => {
        if (handled) {
          forceRuntimeTick((value) => value + 1);
        }
      });
    });
  }, [open, onFileTransferMessage]);

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
    setSelectedRemote(new Set());
    requestRemoteList(path, showHiddenRemote);
  }, [requestRemoteList, showHiddenRemote]);

  // Start transfer
  const startTransfer = useCallback(async () => {
    console.log('[FileTransferSheet] startTransfer called', { direction, selectedRemote: [...selectedRemote], selectedLocal: [...selectedLocal], remotePath, localPath });
    if (direction === 'download') {
      // Download selected remote files
      for (const name of selectedRemote) {
        const entry = remoteEntries.find(e => e.name === name);
        if (!entry || entry.type !== 'file') continue;
        const request = fileTransferRuntimeRef.current.startDownload({ name, size: entry.size }, remotePath);
        forceRuntimeTick((value) => value + 1);
        sendJson(request.message);
        await Promise.race([
          request.waitForDone(),
          new Promise<void>((resolve) => setTimeout(resolve, 60000)),
        ]);
      }
      setSelectedRemote(new Set());
    } else {
      // Upload selected local files
      if (!(await checkLocalStoragePermission())) {
        return;
      }
      for (const name of selectedLocal) {
        const entry = localEntries.find(e => e.name === name);
        if (!entry || entry.type !== 'file') continue;
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
          const request = fileTransferRuntimeRef.current.startUpload({ name, size: entry.size }, targetDir, chunkCount);
          forceRuntimeTick((value) => value + 1);
          sendJson(request.startMessage);

          // Split base64 into chunks and send
          for (let i = 0; i < chunkCount; i++) {
            const start = i * FILE_CHUNK_SIZE;
            const end = Math.min(start + FILE_CHUNK_SIZE, base64.length);
            const chunk = base64.slice(start, end);
            sendJson(request.buildChunkMessage(i, chunk));
          }
          sendJson(request.endMessage);
        } catch (err) {
          const requestId = `ful-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          fileTransferRuntimeRef.current.appendTransferError({
            id: requestId,
            fileName: name,
            direction: 'upload',
            totalBytes: entry.size,
            transferredBytes: 0,
            status: 'error',
            error: String(err),
          });
          forceRuntimeTick((value) => value + 1);
        }
      }
      setSelectedLocal(new Set());
      // Refresh remote list
      requestRemoteList(remotePath, showHiddenRemote);
    }
  }, [checkLocalStoragePermission, direction, selectedRemote, selectedLocal, remoteEntries, localEntries, remotePath, localPath, sendJson, requestRemoteList, showHiddenRemote]);

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
          ) : localPermissionGranted === false ? (
            <div style={{ padding: '20px', textAlign: 'center', color: mobileTheme.colors.textMuted, lineHeight: 1.5 }}>
              {localPermissionError || '本地文件同步需要先授权存储权限。'}
            </div>
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

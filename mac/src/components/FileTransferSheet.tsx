import { useCallback, useEffect, useRef, useState } from 'react';
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
} from '@zterm/shared';

const FILE_CHUNK_SIZE = 256 * 1024;

interface FileTransferSheetProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson: (msg: unknown) => void;
  onFileTransferMessage?: (handler: (msg: unknown) => void) => () => void;
}

interface LocalFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 2) + '\u2026';
}

function getMacFs() {
  return (window as unknown as { ztermMac?: { fileSystem?: {
    readdir: (dirPath: string) => Promise<{ ok: boolean; entries: LocalFileEntry[]; error?: string }>;
    saveFile: (dirPath: string, fileName: string, dataBase64: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    readFile: (filePath: string) => Promise<{ ok: boolean; dataBase64: string; size: number; error?: string }>;
    mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
    getDownloadDir: () => Promise<string>;
  } } }).ztermMac?.fileSystem;
}

export function FileTransferSheet({
  open,
  remoteCwd,
  onClose,
  sendJson,
  onFileTransferMessage,
}: FileTransferSheetProps) {
  const sendJsonRef = useRef(sendJson);
  useEffect(() => { sendJsonRef.current = sendJson; }, [sendJson]);

  const [remotePath, setRemotePath] = useState('');
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteParentPath, setRemoteParentPath] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [showHiddenRemote, setShowHiddenRemote] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());

  const [localPath, setLocalPath] = useState('');
  const [localEntries, setLocalEntries] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());

  const [direction, setDirection] = useState<'upload' | 'download'>('download');
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);

  const activeListRequestRef = useRef<string | null>(null);
  const activeDownloadRequestRef = useRef<string | null>(null);
  const downloadChunksRef = useRef<Map<number, string>>(new Map());
  const transferDoneCallbacksRef = useRef<Map<string, () => void>>(new Map());

  const requestRemoteList = useCallback((path: string, showHidden: boolean) => {
    const requestId = 'flist-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    activeListRequestRef.current = requestId;
    setRemoteLoading(true);
    const payload: FileListRequestPayload = { requestId, path, showHidden };
    sendJsonRef.current({ type: 'file-list-request', payload });
  }, []);

  useEffect(() => {
    if (!open) return;
    const macFs = getMacFs();
    const initialRemotePath = remoteCwd.trim();
    setRemotePath(initialRemotePath);
    setRemoteParentPath(null);
    setRemoteEntries([]);
    setSelectedRemote(new Set());
    setSelectedLocal(new Set());
    setTransfers([]);
    requestRemoteList(initialRemotePath, showHiddenRemote);
    if (macFs) {
      macFs.getDownloadDir().then((dir) => {
        setLocalPath(dir);
      }).catch(() => {
        setLocalPath('');
      });
    }
  }, [open, remoteCwd, requestRemoteList, showHiddenRemote]);

  const loadLocalDir = useCallback(async (dirPath: string, showHidden: boolean) => {
    const macFs = getMacFs();
    if (!macFs) { setLocalEntries([]); return; }
    setLocalLoading(true);
    try {
      const result = await macFs.readdir(dirPath);
      if (!result.ok) {
        setLocalEntries([]);
      } else {
        let entries = result.entries;
        if (!showHidden) entries = entries.filter((e) => !e.name.startsWith('.'));
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setLocalEntries(entries);
      }
    } catch {
      setLocalEntries([]);
    }
    setLocalLoading(false);
  }, []);

  useEffect(() => {
    if (open && localPath) loadLocalDir(localPath, showHiddenLocal);
  }, [open, localPath, showHiddenLocal, loadLocalDir]);

  useEffect(() => {
    if (!open || !onFileTransferMessage) return;
    return onFileTransferMessage((msg: unknown) => {
      const m = msg as { type: string; payload: unknown };
      const payload = m.payload as Record<string, unknown>;
      if (m.type === 'file-list-response') {
        const p = payload as unknown as FileListResponsePayload;
        if (activeListRequestRef.current !== p.requestId) return;
        activeListRequestRef.current = null;
        setRemotePath(p.path);
        setRemoteParentPath(p.parentPath);
        setRemoteEntries(p.entries);
        setRemoteLoading(false);
      } else if (m.type === 'file-list-error') {
        activeListRequestRef.current = null;
        setRemoteLoading(false);
      } else if (m.type === 'file-download-chunk') {
        const p = payload as unknown as FileDownloadChunkPayload;
        if (activeDownloadRequestRef.current !== p.requestId) return;
        downloadChunksRef.current.set(p.chunkIndex, p.dataBase64);
        setTransfers((prev) => prev.map((t) =>
          t.id === p.requestId
            ? { ...t, transferredBytes: t.transferredBytes + 1, status: 'transferring' as const }
            : t
        ));
      } else if (m.type === 'file-download-complete') {
        const p = payload as unknown as FileDownloadCompletePayload;
        if (activeDownloadRequestRef.current !== p.requestId) return;
        activeDownloadRequestRef.current = null;
        transferDoneCallbacksRef.current.get(p.requestId)?.();
        transferDoneCallbacksRef.current.delete(p.requestId);
        void reassembleDownload(p);
      } else if (m.type === 'file-download-error') {
        const p = payload as { requestId: string; error: string };
        activeDownloadRequestRef.current = null;
        transferDoneCallbacksRef.current.get(p.requestId)?.();
        transferDoneCallbacksRef.current.delete(p.requestId);
        setTransfers((prev) => prev.map((t) =>
          t.id === p.requestId ? { ...t, status: 'error' as const, error: p.error } : t
        ));
      } else if (m.type === 'file-upload-progress') {
        const p = payload as { requestId: string; chunkIndex: number };
        setTransfers((prev) => prev.map((t) =>
          t.id === p.requestId
            ? { ...t, transferredBytes: p.chunkIndex, status: 'transferring' as const }
            : t
        ));
      } else if (m.type === 'file-upload-complete') {
        const p = payload as { requestId: string };
        setTransfers((prev) => prev.map((t) =>
          t.id === p.requestId ? { ...t, status: 'done' as const, transferredBytes: t.totalBytes } : t
        ));
        transferDoneCallbacksRef.current.get(p.requestId)?.();
        transferDoneCallbacksRef.current.delete(p.requestId);
      } else if (m.type === 'file-upload-error') {
        const p = payload as { requestId: string; error: string };
        setTransfers((prev) => prev.map((t) =>
          t.id === p.requestId ? { ...t, status: 'error' as const, error: p.error } : t
        ));
        transferDoneCallbacksRef.current.get(p.requestId)?.();
        transferDoneCallbacksRef.current.delete(p.requestId);
      }
    });
  }, [open, onFileTransferMessage]);

  const reassembleDownload = useCallback(async (payload: FileDownloadCompletePayload) => {
    const macFs = getMacFs();
    if (!macFs) return;
    try {
      const chunks = downloadChunksRef.current;
      downloadChunksRef.current = new Map();
      const sortedBase64: string[] = [];
      for (let i = 0; i < chunks.size; i++) {
        const chunk = chunks.get(i);
        if (chunk) sortedBase64.push(chunk);
      }
      const combined = sortedBase64.join('');
      const downloadDir = localPath || '';
      if (!downloadDir) throw new Error('Local download directory not available');
      const result = await macFs.saveFile(downloadDir, payload.fileName, combined);
      if (!result.ok) throw new Error(result.error || 'Save failed');
      setTransfers((prev) => prev.map((t) =>
        t.id === payload.requestId ? { ...t, status: 'done' as const, transferredBytes: t.totalBytes } : t
      ));
      loadLocalDir(downloadDir, showHiddenLocal);
    } catch (err) {
      setTransfers((prev) => prev.map((t) =>
        t.id === payload.requestId ? { ...t, status: 'error' as const, error: String(err) } : t
      ));
    }
  }, [localPath, showHiddenLocal, loadLocalDir]);

  const toggleRemote = useCallback((name: string) => {
    setSelectedRemote((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const toggleLocal = useCallback((name: string) => {
    setSelectedLocal((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const navigateRemotePath = useCallback((path: string) => {
    setRemotePath(path);
    setSelectedRemote(new Set());
    requestRemoteList(path, showHiddenRemote);
  }, [requestRemoteList, showHiddenRemote]);

  const startTransfer = useCallback(async () => {
    if (direction === 'download') {
      for (const name of selectedRemote) {
        const entry = remoteEntries.find((e) => e.name === name);
        if (!entry || entry.type !== 'file') continue;
        const requestId = 'fdl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const remoteFilePath = remotePath === '/' ? '/' + name : remotePath + '/' + name;
        activeDownloadRequestRef.current = requestId;
        downloadChunksRef.current = new Map();
        setTransfers((prev) => [...prev, {
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
        await new Promise<void>((resolve) => {
          transferDoneCallbacksRef.current.set(requestId, resolve);
          setTimeout(() => { transferDoneCallbacksRef.current.delete(requestId); resolve(); }, 60000);
        });
      }
      setSelectedRemote(new Set());
    } else {
      const macFs = getMacFs();
      if (!macFs) return;
      for (const name of selectedLocal) {
        const entry = localEntries.find((e) => e.name === name);
        if (!entry || entry.type !== 'file') continue;
        const requestId = 'ful-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        try {
          const readResult = await macFs.readFile(localPath + '/' + name);
          if (!readResult.ok) throw new Error(readResult.error || 'Read failed');
          const base64 = readResult.dataBase64;
          const chunkCount = Math.ceil(base64.length / (FILE_CHUNK_SIZE * 4 / 3));
          const targetDir = remotePath.trim();
          if (!targetDir) throw new Error('Remote path unavailable');
          setTransfers((prev) => [...prev, {
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
          for (let i = 0; i < chunkCount; i++) {
            const start = i * FILE_CHUNK_SIZE;
            const end = Math.min(start + FILE_CHUNK_SIZE, base64.length);
            const chunk = base64.slice(start, end);
            sendJson({ type: 'file-upload-chunk', payload: { requestId, chunkIndex: i, dataBase64: chunk } as FileUploadChunkPayload });
          }
          sendJson({ type: 'file-upload-end', payload: { requestId } as FileUploadEndPayload });
        } catch (err) {
          setTransfers((prev) => [...prev, {
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
      requestRemoteList(remotePath, showHiddenRemote);
    }
  }, [direction, selectedRemote, selectedLocal, remoteEntries, localEntries, remotePath, localPath, sendJson, requestRemoteList, showHiddenRemote]);

  if (!open) return null;

  return (
    <div className="file-transfer-backdrop" onClick={onClose}>
      <div className="file-transfer-card" onClick={(e) => e.stopPropagation()}>
        <div className="file-transfer-header">
          <div className="file-transfer-title">File Transfer</div>
          <button type="button" className="file-transfer-close" onClick={onClose}>&times;</button>
        </div>

        <div className="file-transfer-section-label">
          <span>Remote: {truncateName(remotePath, 50)}</span>
          <button type="button" className="file-transfer-ghost-btn" onClick={() => setShowHiddenRemote((v) => !v)}>
            {showHiddenRemote ? 'Hide' : 'Show'} hidden
          </button>
        </div>
        <div className="file-transfer-breadcrumb">
          <button type="button" className="file-transfer-ghost-btn" onClick={() => remoteParentPath && navigateRemotePath(remoteParentPath)}>
            &larr; Parent
          </button>
          <span className="file-transfer-path">{remotePath}</span>
        </div>
        <div className="file-transfer-list">
          {remoteLoading ? (
            <div className="file-transfer-empty">Loading...</div>
          ) : remoteEntries.length === 0 ? (
            <div className="file-transfer-empty">Empty directory</div>
          ) : remoteEntries.map((entry) => (
            <div key={entry.name} className="file-transfer-row" onClick={() => {
              if (entry.type === 'directory') {
                navigateRemotePath(remotePath === '/' ? '/' + entry.name : remotePath + '/' + entry.name);
              } else {
                toggleRemote(entry.name);
              }
            }}>
              <div className={'file-transfer-checkbox' + (selectedRemote.has(entry.name) ? ' checked' : '')}>
                {selectedRemote.has(entry.name) ? '\u2713' : ''}
              </div>
              <span className="file-transfer-icon">{entry.type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</span>
              <span className="file-transfer-name">{entry.name}</span>
              {entry.type === 'file' && <span className="file-transfer-size">{formatBytes(entry.size)}</span>}
            </div>
          ))}
        </div>

        <div className="file-transfer-controls">
          <button type="button" className={'file-transfer-dir-btn' + (direction === 'download' ? ' active' : '')} onClick={() => setDirection('download')}>
            Download to local
          </button>
          <button type="button" className="file-transfer-action-btn" onClick={() => void startTransfer()}>
            {direction === 'download' ? 'Transfer ' + selectedRemote.size + ' items' : 'Transfer ' + selectedLocal.size + ' items'}
          </button>
          <button type="button" className={'file-transfer-dir-btn' + (direction === 'upload' ? ' active' : '')} onClick={() => setDirection('upload')}>
            Upload to remote
          </button>
        </div>

        <div className="file-transfer-section-label">
          <span>Local: {truncateName(localPath, 50)}</span>
          <button type="button" className="file-transfer-ghost-btn" onClick={() => setShowHiddenLocal((v) => !v)}>
            {showHiddenLocal ? 'Hide' : 'Show'} hidden
          </button>
        </div>
        <div className="file-transfer-breadcrumb">
          <button type="button" className="file-transfer-ghost-btn" onClick={() => {
            const parts = localPath.split('/');
            parts.pop();
            setLocalPath(parts.join('/') || '/');
            setSelectedLocal(new Set());
          }}>
            &larr; Parent
          </button>
          <span className="file-transfer-path">{localPath}</span>
        </div>
        <div className="file-transfer-list">
          {localLoading ? (
            <div className="file-transfer-empty">Loading...</div>
          ) : localEntries.length === 0 ? (
            <div className="file-transfer-empty">Empty directory</div>
          ) : localEntries.map((entry) => (
            <div key={entry.name} className="file-transfer-row" onClick={() => {
              if (entry.type === 'directory') {
                setLocalPath(localPath === '/' ? '/' + entry.name : localPath + '/' + entry.name);
                setSelectedLocal(new Set());
              } else {
                toggleLocal(entry.name);
              }
            }}>
              <div className={'file-transfer-checkbox' + (selectedLocal.has(entry.name) ? ' checked' : '')}>
                {selectedLocal.has(entry.name) ? '\u2713' : ''}
              </div>
              <span className="file-transfer-icon">{entry.type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</span>
              <span className="file-transfer-name">{entry.name}</span>
              {entry.type === 'file' && <span className="file-transfer-size">{formatBytes(entry.size)}</span>}
            </div>
          ))}
        </div>

        {transfers.length > 0 && (
          <div className="file-transfer-progress">
            <div className="file-transfer-progress-label">Transfer Progress</div>
            {transfers.map((t) => (
              <div key={t.id} className="file-transfer-progress-row">
                <span className="file-transfer-progress-icon">{t.direction === 'download' ? '\u2B07' : '\u2B06'}</span>
                <span className="file-transfer-progress-name">{t.fileName}</span>
                <span className={'file-transfer-progress-status ' + t.status}>
                  {t.status === 'done' ? '\u2713 Done' : t.status === 'error' ? '\u2717 ' + (t.error || 'Error') : formatBytes(t.transferredBytes * FILE_CHUNK_SIZE) + ' / ' + formatBytes(t.totalBytes)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

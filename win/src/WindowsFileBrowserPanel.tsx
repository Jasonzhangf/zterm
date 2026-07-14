import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  decideFileBrowserPreview,
  joinFileBrowserPath,
  normalizeFileBrowserPath,
  projectFileBrowserDirectoryResult,
  resolveFileBrowserParentPath,
  type FileBrowserEntry,
} from '@zterm/shared';

export type WindowsFileSystemApi = NonNullable<NonNullable<Window['ztermWindows']>['fileSystem']>;

type PreviewState =
  | { kind: 'empty'; message: string }
  | { kind: 'loading'; fileName: string }
  | { kind: 'text'; fileName: string; text: string }
  | { kind: 'confirm-large-text'; entry: FileBrowserEntry; message: string }
  | { kind: 'binary-disabled'; fileName: string; message: string }
  | { kind: 'error'; fileName?: string; message: string };

function decodeBase64Text(dataBase64: string) {
  const binary = atob(dataBase64);
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WindowsFileBrowserPanel({
  open,
  onClose,
  initialPath = '',
  fileSystem,
}: {
  open: boolean;
  onClose: () => void;
  initialPath?: string;
  fileSystem?: WindowsFileSystemApi;
}) {
  const fsApi = useMemo(() => fileSystem ?? window.ztermWindows?.fileSystem ?? null, [fileSystem]);
  const [pathInput, setPathInput] = useState(initialPath);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileBrowserEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ kind: 'empty', message: 'No file selected' });

  const openDirectory = useCallback(async (requestedPath: string) => {
    const targetPath = normalizeFileBrowserPath(requestedPath);
    if (!fsApi) {
      setDirectoryError('Windows file system bridge is unavailable');
      return;
    }
    if (!targetPath) {
      setDirectoryError('Directory path is required');
      return;
    }
    setLoading(true);
    setDirectoryError('');
    setSelectedPath('');
    setPreview({ kind: 'empty', message: 'No file selected' });
    try {
      const result = await fsApi.readdir(targetPath);
      const projection = projectFileBrowserDirectoryResult(result.ok
        ? {
            ok: true,
            path: result.path || targetPath,
            entries: result.entries.map((entry) => ({
              name: entry.name,
              type: entry.type === 'directory' ? 'directory' : 'file',
              sizeBytes: entry.size,
              modifiedMs: entry.modifiedMs ?? entry.modified * 1000,
              path: entry.path ?? joinFileBrowserPath(result.path || targetPath, entry.name),
            })),
          }
        : { ok: false, path: result.path || targetPath, error: result.error || 'Unable to read directory' });
      if (projection.kind === 'error') {
        setEntries([]);
        setDirectoryError(projection.error);
        return;
      }
      setCurrentPath(projection.path);
      setPathInput(projection.path);
      setEntries(projection.entries);
    } catch (error) {
      setEntries([]);
      setDirectoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [fsApi]);

  useEffect(() => {
    if (!open) return;
    setPathInput(initialPath);
    if (initialPath) void openDirectory(initialPath);
  }, [initialPath, open, openDirectory]);

  const readPreview = useCallback(async (entry: FileBrowserEntry, confirmedLargeText = false) => {
    if (!fsApi) {
      setPreview({ kind: 'error', fileName: entry.name, message: 'Windows file system bridge is unavailable' });
      return;
    }
    const decision = decideFileBrowserPreview(entry, { confirmedLargeText });
    if (decision.kind === 'confirm-large-text') {
      setPreview({ kind: 'confirm-large-text', entry, message: `${formatBytes(decision.sizeBytes)} requires confirmation` });
      return;
    }
    if (decision.kind === 'binary-disabled') {
      setPreview({ kind: 'binary-disabled', fileName: entry.name, message: decision.reason });
      return;
    }
    if (decision.kind !== 'text') return;
    const filePath = entry.path ?? joinFileBrowserPath(currentPath, entry.name);
    setPreview({ kind: 'loading', fileName: entry.name });
    const result = await fsApi.readFile(filePath);
    if (!result.ok) {
      setPreview({ kind: 'error', fileName: entry.name, message: result.error || 'Unable to read file' });
      return;
    }
    setPreview({ kind: 'text', fileName: entry.name, text: decodeBase64Text(result.dataBase64) });
  }, [currentPath, fsApi]);

  if (!open) return null;
  const parentPath = currentPath ? resolveFileBrowserParentPath(currentPath) : null;
  const chooseDirectory = async () => {
    if (!fsApi) {
      setDirectoryError('Windows file system bridge is unavailable');
      return;
    }
    const result = await fsApi.selectDirectory();
    if (result.ok && result.path) void openDirectory(result.path);
    else if (!result.canceled) setDirectoryError(result.error || 'Directory selection failed');
  };

  return (
    <section className="windows-file-browser" role="dialog" aria-label="Local file browser">
      <header className="file-browser-toolbar">
        <input aria-label="Local path" value={pathInput} onChange={(event) => setPathInput(event.target.value)} />
        <button onClick={() => void openDirectory(pathInput)}>Open</button>
        <button onClick={() => void chooseDirectory()}>Choose</button>
        <button disabled={!parentPath} onClick={() => parentPath && void openDirectory(parentPath)}>Parent</button>
        <button className="file-browser-close" aria-label="Close file browser" onClick={onClose}>×</button>
      </header>
      <div className="file-browser-current" title={currentPath}>{currentPath}</div>
      <div className="file-browser-body">
        <div className="file-browser-list">
          {loading ? <div className="file-browser-empty">Loading</div> : null}
          {!loading && directoryError ? <div className="file-browser-error" data-testid="windows-file-browser-error">{directoryError}</div> : null}
          {!loading && !directoryError && entries.length === 0 ? <div className="file-browser-empty">No entries</div> : null}
          {!loading && !directoryError ? entries.map((entry) => (
            <button
              key={`${entry.type}:${entry.name}`}
              className="file-browser-entry"
              data-entry-type={entry.type}
              data-selected={selectedPath === entry.path ? 'true' : 'false'}
              onClick={() => {
                const entryPath = entry.path ?? joinFileBrowserPath(currentPath, entry.name);
                setSelectedPath(entryPath);
                if (entry.type === 'directory') void openDirectory(entryPath);
                else void readPreview(entry);
              }}
            >
              <span className="file-browser-kind">{entry.type === 'directory' ? 'DIR' : 'FILE'}</span>
              <span className="file-browser-name">{entry.name}</span>
              {entry.type === 'file' ? <span className="file-browser-size">{formatBytes(entry.sizeBytes)}</span> : null}
            </button>
          )) : null}
        </div>
        <div className="file-browser-preview">
          {preview.kind === 'empty' ? <span className="file-browser-empty">{preview.message}</span> : null}
          {preview.kind === 'loading' ? <span className="file-browser-empty">Loading {preview.fileName}</span> : null}
          {preview.kind === 'text' ? <><h2>{preview.fileName}</h2><pre data-testid="windows-file-preview-text">{preview.text}</pre></> : null}
          {preview.kind === 'confirm-large-text' ? <div className="file-browser-confirm"><span>{preview.message}</span><button data-testid="windows-file-preview-confirm" onClick={() => void readPreview(preview.entry, true)}>Preview</button></div> : null}
          {preview.kind === 'binary-disabled' ? <button disabled data-testid="windows-file-preview-disabled">{preview.message}</button> : null}
          {preview.kind === 'error' ? <div className="file-browser-error" data-testid="windows-file-preview-error">{preview.message}</div> : null}
        </div>
      </div>
    </section>
  );
}

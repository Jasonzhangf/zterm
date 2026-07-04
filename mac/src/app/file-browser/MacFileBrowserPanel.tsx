import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  decideFileBrowserPreview,
  joinFileBrowserPath,
  normalizeFileBrowserPath,
  projectFileBrowserDirectoryResult,
  resolveFileBrowserParentPath,
  type FileBrowserEntry,
} from '@zterm/shared';

type MacFileSystemApi = NonNullable<Window['ztermMac']['fileSystem']>;

interface MacFileBrowserPanelProps {
  open: boolean;
  onClose: () => void;
  initialPath?: string;
  fileSystem?: MacFileSystemApi;
}

type PreviewState =
  | { kind: 'empty'; message: string }
  | { kind: 'loading'; fileName: string }
  | { kind: 'text'; fileName: string; text: string }
  | { kind: 'confirm-large-text'; entry: FileBrowserEntry; message: string }
  | { kind: 'binary-disabled'; fileName: string; message: string }
  | { kind: 'error'; fileName?: string; message: string };

function resolveMacFileSystemApi(fileSystem?: MacFileSystemApi): MacFileSystemApi | null {
  if (fileSystem) {
    return fileSystem;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  return window.ztermMac?.fileSystem ?? null;
}

function mapProviderEntry(rawEntry: {
  name: string;
  type: 'file' | 'directory' | string;
  size: number;
  modified: number;
  modifiedMs?: number;
  path?: string;
}, currentPath: string): FileBrowserEntry {
  return {
    name: rawEntry.name,
    type: rawEntry.type === 'directory' ? 'directory' : 'file',
    sizeBytes: rawEntry.size,
    modifiedMs: rawEntry.modifiedMs ?? rawEntry.modified * 1000,
    path: rawEntry.path ?? joinFileBrowserPath(currentPath, rawEntry.name),
  };
}

function decodeBase64Text(dataBase64: string): string {
  if (!globalThis.atob) {
    throw new Error('Base64 decoder is unavailable');
  }
  const binary = globalThis.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MacFileBrowserPanel({
  open,
  onClose,
  initialPath,
  fileSystem,
}: MacFileBrowserPanelProps) {
  const fsApi = useMemo(() => resolveMacFileSystemApi(fileSystem), [fileSystem]);
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileBrowserEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [preview, setPreview] = useState<PreviewState>({
    kind: 'empty',
    message: 'No file selected',
  });

  const openDirectory = useCallback(async (targetPath: string) => {
    const normalizedPath = normalizeFileBrowserPath(targetPath);
    if (!fsApi) {
      setDirectoryError('Local file system bridge is unavailable');
      return;
    }
    if (!normalizedPath) {
      setDirectoryError('Directory path is required');
      return;
    }

    setLoading(true);
    setDirectoryError('');
    setPreview({ kind: 'empty', message: 'No file selected' });
    setSelectedPath('');
    try {
      const result = await fsApi.readdir(normalizedPath);
      const projection = projectFileBrowserDirectoryResult(result.ok
        ? {
            ok: true,
            path: result.path || normalizedPath,
            entries: result.entries.map((entry) => mapProviderEntry(entry, result.path || normalizedPath)),
          }
        : {
            ok: false,
            path: result.path || normalizedPath,
            error: result.error || 'Unable to read directory',
          });
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
    if (!open) {
      return;
    }
    setPathInput(initialPath ?? '');
    if (initialPath) {
      void openDirectory(initialPath);
      return;
    }
    setEntries([]);
    setCurrentPath('');
    setSelectedPath('');
    setDirectoryError('');
    setPreview({ kind: 'empty', message: 'No file selected' });
  }, [initialPath, open, openDirectory]);

  const readTextPreview = useCallback(async (entry: FileBrowserEntry, confirmedLargeText = false) => {
    if (!fsApi) {
      setPreview({ kind: 'error', fileName: entry.name, message: 'Local file system bridge is unavailable' });
      return;
    }
    const decision = decideFileBrowserPreview(entry, { confirmedLargeText });
    if (decision.kind === 'confirm-large-text') {
      setPreview({
        kind: 'confirm-large-text',
        entry,
        message: `${formatBytes(decision.sizeBytes)} requires confirmation`,
      });
      return;
    }
    if (decision.kind === 'binary-disabled') {
      setPreview({ kind: 'binary-disabled', fileName: entry.name, message: decision.reason });
      return;
    }
    if (decision.kind !== 'text') {
      setPreview({ kind: 'empty', message: decision.reason });
      return;
    }

    const filePath = entry.path ?? joinFileBrowserPath(currentPath, entry.name);
    setPreview({ kind: 'loading', fileName: entry.name });
    const result = await fsApi.readFile(filePath);
    if (!result.ok) {
      setPreview({
        kind: 'error',
        fileName: entry.name,
        message: result.error || 'Unable to read file',
      });
      return;
    }
    setPreview({
      kind: 'text',
      fileName: entry.name,
      text: decodeBase64Text(result.dataBase64),
    });
  }, [currentPath, fsApi]);

  const handleEntryClick = (entry: FileBrowserEntry) => {
    const entryPath = entry.path ?? joinFileBrowserPath(currentPath, entry.name);
    setSelectedPath(entryPath);
    if (entry.type === 'directory') {
      void openDirectory(entryPath);
      return;
    }
    void readTextPreview(entry);
  };

  const handleChooseDirectory = async () => {
    if (!fsApi) {
      setDirectoryError('Local file system bridge is unavailable');
      return;
    }
    const result = await fsApi.selectDirectory();
    if (!result.ok || !result.path) {
      if (!result.canceled) {
        setDirectoryError(result.error || 'Directory selection failed');
      }
      return;
    }
    void openDirectory(result.path);
  };

  const parentPath = currentPath ? resolveFileBrowserParentPath(currentPath) : null;

  if (!open) {
    return null;
  }

  return (
    <section className="mac-file-browser-panel" role="dialog" aria-label="Local file browser" data-testid="mac-file-browser-panel">
      <div className="mac-file-browser-toolbar">
        <div className="mac-file-browser-path-row">
          <input
            aria-label="Local path"
            className="mac-file-browser-path-input"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
          />
          <button className="mac-secondary-button" type="button" onClick={() => void openDirectory(pathInput)}>
            Open
          </button>
          <button className="mac-secondary-button" type="button" onClick={handleChooseDirectory}>
            Choose
          </button>
          <button className="mac-secondary-button" type="button" disabled={!parentPath} onClick={() => parentPath && void openDirectory(parentPath)}>
            Parent
          </button>
          <button className="mac-chip-button" type="button" onClick={onClose} aria-label="Close file browser">
            x
          </button>
        </div>
        {currentPath ? <span className="mac-file-browser-current">{currentPath}</span> : null}
      </div>

      <div className="mac-file-browser-body">
        <div className="mac-file-browser-list" data-testid="mac-file-browser-list">
          {loading ? <div className="mac-file-browser-empty">Loading</div> : null}
          {!loading && directoryError ? <div className="mac-file-browser-error" data-testid="mac-file-browser-error">{directoryError}</div> : null}
          {!loading && !directoryError && entries.length === 0 ? <div className="mac-file-browser-empty">No entries</div> : null}
          {!loading && !directoryError ? entries.map((entry) => (
            <button
              key={`${entry.type}:${entry.name}`}
              type="button"
              className="mac-file-browser-entry"
              data-entry-type={entry.type}
              data-selected={selectedPath === (entry.path ?? '') ? 'true' : 'false'}
              onClick={() => handleEntryClick(entry)}
            >
              <span className="mac-file-browser-entry-kind">{entry.type === 'directory' ? 'dir' : 'file'}</span>
              <span className="mac-file-browser-entry-name">{entry.name}</span>
              {entry.type === 'file' ? <span className="mac-file-browser-entry-size">{formatBytes(entry.sizeBytes)}</span> : null}
            </button>
          )) : null}
        </div>

        <div className="mac-file-browser-preview" data-testid="mac-file-browser-preview">
          {preview.kind === 'empty' ? <span className="mac-file-browser-empty">{preview.message}</span> : null}
          {preview.kind === 'loading' ? <span className="mac-file-browser-empty">Loading {preview.fileName}</span> : null}
          {preview.kind === 'text' ? (
            <>
              <div className="mac-file-browser-preview-title">{preview.fileName}</div>
              <pre data-testid="mac-file-preview-text">{preview.text}</pre>
            </>
          ) : null}
          {preview.kind === 'confirm-large-text' ? (
            <div className="mac-file-browser-confirm">
              <span>{preview.message}</span>
              <button
                className="mac-primary-button"
                type="button"
                data-testid="mac-file-preview-confirm"
                onClick={() => void readTextPreview(preview.entry, true)}
              >
                Preview
              </button>
            </div>
          ) : null}
          {preview.kind === 'binary-disabled' ? (
            <button className="mac-secondary-button" type="button" disabled data-testid="mac-file-preview-disabled">
              {preview.message}
            </button>
          ) : null}
          {preview.kind === 'error' ? <div className="mac-file-browser-error" data-testid="mac-file-preview-error">{preview.message}</div> : null}
        </div>
      </div>
    </section>
  );
}

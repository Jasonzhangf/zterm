import { useCallback, useEffect, useRef, useState } from "react";
import { createFileTransferSessionRuntime } from "../../lib/file-transfer-session-runtime";

import {
  DEFAULT_LOCAL_DOWNLOAD_DIR,
  LOCAL_MARKDOWN_PREVIEW_MAX_BYTES,
  REMOTE_TEXT_EDIT_MAX_BYTES,
} from "../../lib/file-transfer-sheet-constants";

import {
  formatBytes,
  shortenDisplayPath,
  isMarkdownFileName,
  isTextPreviewFileName,
  encodeBytesToBase64,
  resolveTextMimeType,
  joinRemoteCopyIdentity,
  buildRemoteLocalEditCopyPath,
  buildLocalPreviewEditCopyPath,
  buildLocalEditSnapshotPath,
  decodeBase64Bytes,
  normalizeLocalDisplayPath,
  joinLocalDisplayPath,
  fileUriMatchesPath,
  getParentLocalDisplayPath,
  compareFileEntries,
  isNativePathNotFound,
} from "../../lib/file-transfer-sheet-helpers";

import {
  readLocalEditCopyState,
  writeLocalEditCopyState,
} from "../../lib/file-transfer-local-edit-copy-storage";
import {
  sendBoundedFileUploadChunks,
  writeFileTransferChunkBatches,
} from "../../lib/file-transfer-throughput-runtime";
import { StoragePermissionPlugin } from "../../plugins/StoragePermissionPlugin";
import { FILE_TRANSFER_WIRE_CHUNK_BYTES, FILE_TRANSFER_WIRE_FRAME_MAX_CHARS } from "@zterm/shared/protocol";
import {
  buildTransferSheetContainerStyle,
  buildTransferSheetOverlayStyle,
} from "./transfer-sheet-layout";
import type {
  FileEntry,
  FileListRequestPayload,
  TransferProgress,
} from "../../lib/types";
import type { FileTransferSheetProps } from "../../lib/plugin-file-browser/file-browser-contract";
export type { FileTransferSheetProps } from "../../lib/plugin-file-browser/file-browser-contract";

const FILE_CHUNK_SIZE = FILE_TRANSFER_WIRE_CHUNK_BYTES; // must match daemon wire chunk
const SHEET_TEXT = "var(--zterm-panel-text)";
const SHEET_MUTED = "var(--zterm-panel-muted)";
const SHEET_BORDER = "var(--zterm-panel-border)";
const SHEET_SURFACE = "var(--zterm-panel-surface)";
const SHEET_ACCENT = "var(--zterm-panel-accent)";
const SHEET_DANGER = "var(--zterm-panel-danger)";

interface RemoteFileEntry extends FileEntry {}
interface LocalFileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: number;
  mimeType?: string;
  uri?: string;
}

type PreviewSource =
  | { kind: "remote"; sourceIdentity: string; truncated: false }
  | { kind: "local"; sourcePath: string; sourceIdentity: string; truncated: boolean };


type FileSortField = "name" | "modified";
type FileSortDirection = "asc" | "desc";
function renderMarkdownPreview(text: string) {
  return text.split("\n").map((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length || 1;
      return (
        <div
          key={index}
          style={{
            fontWeight: 800,
            fontSize: `${Math.max(13, 22 - level * 2)}px`,
            margin: "10px 0 4px",
            color: SHEET_TEXT,
          }}
        >
          {heading[2]}
        </div>
      );
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      return (
        <div key={index} style={{ paddingLeft: "14px" }}>
          • {line.replace(/^\s*[-*+]\s+/, "")}
        </div>
      );
    }
    if (!line.trim()) {
      return <div key={index} style={{ height: "8px" }} />;
    }
    return <div key={index}>{line}</div>;
  });
}

function resolvePrimaryTransferLabel(
  direction: "upload" | "download",
  selectedCount: number,
) {
  return direction === "download"
    ? `下载 ${selectedCount} 项`
    : `上传 ${selectedCount} 项`;
}

const headerStyle = {
  padding: "12px 14px 8px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexShrink: 0,
};

const fileListContainerStyle = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto" as const,
  WebkitOverflowScrolling: "touch" as const,
  padding: "4px 10px",
};

const fileRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  borderRadius: "10px",
  cursor: "pointer",
};

const fileCheckboxStyle = (checked: boolean) => ({
  width: "18px",
  height: "18px",
  borderRadius: "4px",
  border: checked
    ? `2px solid ${SHEET_ACCENT}`
    : `2px solid ${SHEET_BORDER}`,
  background: checked ? SHEET_ACCENT : "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  flexShrink: 0,
  color: "var(--zterm-panel-active-text)",
  fontSize: "12px",
  fontWeight: 800,
  cursor: "pointer",
});

const pathBreadcrumbStyle = {
  fontSize: "12px",
  color: SHEET_MUTED,
  padding: "2px 10px 6px",
  display: "flex",
  alignItems: "center",
  gap: "4px",
  flexShrink: 0,
  overflowX: "auto" as const,
  whiteSpace: "nowrap" as const,
};

const actionButtonStyle = (bg: string, color: string) => ({
  minHeight: "36px",
  padding: "0 14px",
  borderRadius: "12px",
  border: "none",
  background: bg,
  color,
  fontWeight: 700,
  fontSize: "14px",
  cursor: "pointer",
  flexShrink: 0,
});

const sectionLabelStyle = {
  fontSize: "13px",
  fontWeight: 700,
  color: SHEET_TEXT,
  padding: "6px 10px 2px",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const progressRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "4px 10px",
  fontSize: "12px",
  color: SHEET_MUTED,
};

const sortControlStyle = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexShrink: 0,
};



async function resolveExistingLocalEditCopy(targetPath: string) {
  try {
    const stat = await StoragePermissionPlugin.stat({ path: targetPath });
    if (!fileUriMatchesPath(stat.uri, targetPath)) {
      return { exists: false as const };
    }
    if (stat.type !== "file") {
      throw new Error("local edit copy path exists but is not the expected file");
    }
    return { exists: true as const, stat };
  } catch (error) {
    if (isNativePathNotFound(error)) {
      return { exists: false as const };
    }
    throw error;
  }
}


export function FileTransferSheet({
  open,
  remoteCwd,
  onClose,
  sendJson,
  onFileTransferMessage,
  avoidSide = null,
  mode = "sync",
  daemonFileScopeId = "",
  terminalShellSkin = "light",
}: FileTransferSheetProps) {
  const browserMode = mode === "browser";
  const sendJsonRef = useRef(sendJson);
  const previewEditorRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    sendJsonRef.current = sendJson;
  }, [sendJson]);
  const localPathRef = useRef(DEFAULT_LOCAL_DOWNLOAD_DIR);

  // Remote state
  const fileTransferRuntimeRef = useRef(
    createFileTransferSessionRuntime({
      onDownloadComplete: async (payload, orderedChunksBase64) => {
        try {
          const downloadDir = normalizeLocalDisplayPath(
            localPathRef.current || DEFAULT_LOCAL_DOWNLOAD_DIR,
          );
          const targetPath = joinLocalDisplayPath(downloadDir, payload.fileName);
          try {
            await StoragePermissionPlugin.mkdir({
              path: downloadDir,
              recursive: true,
            });
          } catch (mkdirError) {
            console.warn(
              "[FileTransferSheet] mkdir failed (may already exist):",
              mkdirError,
            );
          }

          if (payload.totalBytes > 0 && orderedChunksBase64.length === 0) {
            throw new Error("download completed without file chunks");
          }

          if (orderedChunksBase64.length === 0) {
            await StoragePermissionPlugin.writeFile({
              path: targetPath,
              data: "",
            });
          } else {
            const writeDownloadChunkBatch = async (
              chunks: string[],
              append: boolean,
            ) => {
              await StoragePermissionPlugin.writeFileChunks({
                path: targetPath,
                chunks,
                append,
              });
            };
            await writeFileTransferChunkBatches({
              chunksBase64: orderedChunksBase64,
              writeBatch: writeDownloadChunkBatch,
            });
          }

          const written = await StoragePermissionPlugin.stat({ path: targetPath });
          if (written.size !== payload.totalBytes) {
            throw new Error(
              `download size mismatch: wrote ${written.size} bytes, expected ${payload.totalBytes}`,
            );
          }

          loadLocalDir(downloadDir, {
            requestPermission: false,
          });
        } catch (error) {
          forceRuntimeTick((value) => value + 1);
          throw error;
        }
      },
    }),
  );
  const [, forceRuntimeTick] = useState(0);
  const runtimeState = fileTransferRuntimeRef.current.getState();
  const remotePath = runtimeState.remotePath;
  const remoteEntries = runtimeState.remoteEntries as RemoteFileEntry[];
  const remoteParentPath = runtimeState.remoteParentPath;
  const remoteLoading = runtimeState.remoteLoading;
  const remoteError = runtimeState.remoteError;
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [remoteSortField, setRemoteSortField] =
    useState<FileSortField>("name");
  const [remoteSortDirection, setRemoteSortDirection] =
    useState<FileSortDirection>("asc");

  // Local state
  const [localPath, setLocalPath] = useState(DEFAULT_LOCAL_DOWNLOAD_DIR);
  const [localEntries, setLocalEntries] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localPermissionGranted, setLocalPermissionGranted] = useState<
    boolean | null
  >(null);
  const [localPermissionError, setLocalPermissionError] = useState<
    string | null
  >(null);
  const [localListError, setLocalListError] = useState<string | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [localSortField, setLocalSortField] = useState<FileSortField>("name");
  const [localSortDirection, setLocalSortDirection] =
    useState<FileSortDirection>("asc");
  const [previewEditorText, setPreviewEditorText] = useState("");
  const [previewEditorDirty, setPreviewEditorDirty] = useState(false);
  const [previewSaveStatus, setPreviewSaveStatus] = useState<string | null>(
    null,
  );
  const [previewSaving, setPreviewSaving] = useState(false);
  const [externalEditCopy, setExternalEditCopy] = useState<{
    fileName: string;
    path: string;
  } | null>(null);
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const resetScopeKey = `${open ? "open" : "closed"}\u0000${remoteCwd}\u0000${daemonFileScopeId}`;

  useEffect(() => {
    localPathRef.current = localPath;
  }, [localPath]);

  // Direction
  const [direction, setDirection] = useState<"upload" | "download">("download");

  // Transfers
  const transfers = runtimeState.transfers as TransferProgress[];
  const preview = runtimeState.preview;
  const previewOpen = Boolean(preview.fileName);
  const previewActionUnavailable = Boolean(preview.loading || preview.error);
  const saveDisabledForPreview = Boolean(
    previewActionUnavailable ||
    previewSaving ||
    (previewSource?.kind === "local" && previewSource.truncated),
  );
  const localOpenDisabledForPreview = previewActionUnavailable || previewSaving;
  const syncCopyDisabledForPreview = previewActionUnavailable || previewSaving;
  const visibleRemoteEntries = [...remoteEntries].sort((a, b) =>
    compareFileEntries(a, b, remoteSortField, remoteSortDirection),
  );
  const visibleLocalEntries = [...localEntries].sort((a, b) =>
    compareFileEntries(a, b, localSortField, localSortDirection),
  );

  const renderSortControls = (
    sortField: FileSortField,
    setSortField: (field: FileSortField) => void,
    sortDirection: FileSortDirection,
    setSortDirection: (direction: FileSortDirection) => void,
  ) => (
    <div style={sortControlStyle}>
      <button
        type="button"
        onClick={() =>
          setSortField(sortField === "name" ? "modified" : "name")
        }
        style={{
          ...actionButtonStyle("transparent", SHEET_MUTED),
          minHeight: "24px",
          padding: "0 8px",
          fontSize: "11px",
        }}
      >
        {sortField === "name" ? "按名称" : "按时间"}
      </button>
      <button
        type="button"
        onClick={() =>
          setSortDirection(sortDirection === "asc" ? "desc" : "asc")
        }
        style={{
          ...actionButtonStyle("transparent", SHEET_MUTED),
          minHeight: "24px",
          padding: "0 8px",
          fontSize: "11px",
        }}
      >
        {sortDirection === "asc" ? "正序" : "倒序"}
      </button>
    </div>
  );

  // Request remote file list
  const requestRemoteList = useCallback((path: string) => {
    const request = fileTransferRuntimeRef.current.requestRemoteList(
      path,
      true,
    );
    const payload: FileListRequestPayload = request.message.payload;
    sendJsonRef.current?.({ type: "file-list-request", payload });
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
    setPreviewEditorText("");
    setPreviewEditorDirty(false);
    setPreviewSaveStatus(null);
    setPreviewSaving(false);
    setExternalEditCopy(null);
    setPreviewSource(null);
    setDirection("download");
    forceRuntimeTick((value) => value + 1);
    requestRemoteList(initialRemotePath);
  }, [open, remoteCwd, resetScopeKey, requestRemoteList]);

  const checkLocalStoragePermission = useCallback(async () => {
    try {
      const status = await StoragePermissionPlugin.check();
      setLocalPermissionGranted(status.granted);
      setLocalPermissionError(
        status.granted
          ? null
          : "本地文件同步需要存储权限；已尝试拉起授权页，请完成授权后返回此页面。",
      );
      return status.granted;
    } catch (error) {
      setLocalPermissionGranted(false);
      setLocalPermissionError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }, []);

  const ensureLocalStoragePermission = useCallback(
    async (requestIfMissing: boolean) => {
      const granted = await checkLocalStoragePermission();
      if (granted || !requestIfMissing) {
        return granted;
      }
      try {
        const requestedStatus = await StoragePermissionPlugin.request();
        setLocalPermissionGranted(requestedStatus.granted);
        setLocalPermissionError(
          requestedStatus.granted
            ? null
            : "本地文件同步需要存储权限；已尝试拉起授权页，请完成授权后返回此页面。",
        );
        return requestedStatus.granted;
      } catch (error) {
        setLocalPermissionGranted(false);
        setLocalPermissionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    [checkLocalStoragePermission],
  );

  // Load local directory
  const loadLocalDir = useCallback(
    async (path: string, options?: { requestPermission?: boolean }) => {
      const normalizedPath = normalizeLocalDisplayPath(path);
      setLocalLoading(true);
      setLocalListError(null);
      try {
        const permissionGranted = await ensureLocalStoragePermission(
          options?.requestPermission ?? false,
        );
        if (!permissionGranted) {
          setLocalEntries([]);
          return;
        }
        const result = await StoragePermissionPlugin.readdir({
          path: normalizedPath,
        });
        const entries: LocalFileEntry[] = [];
        for (const entry of result.files) {
          const type = entry.type === "directory" ? "directory" : "file";
          entries.push({
            name: entry.name,
            type,
            size: entry.size,
            modified: entry.modified,
            uri: entry.uri,
          });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setLocalEntries(entries);
        setLocalPath(normalizedPath);
      } catch (err) {
        console.warn("[FileTransferSheet] local readdir failed:", err);
        setLocalEntries([]);
        setLocalListError(
          `本地目录读取失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setLocalLoading(false);
      }
    },
    [ensureLocalStoragePermission],
  );

  useEffect(() => {
    if (open && !browserMode && localPath) {
      loadLocalDir(localPath, { requestPermission: true });
    }
  }, [browserMode, open, localPath, loadLocalDir]);

  useEffect(() => {
    if (!open || browserMode) {
      return;
    }
    const refreshLocalAccess = () => {
      void loadLocalDir(localPath, { requestPermission: false });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshLocalAccess();
      }
    };
    window.addEventListener("focus", refreshLocalAccess);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshLocalAccess);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [browserMode, open, localPath, loadLocalDir]);

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

  useEffect(() => {
    if (!preview.fileName || preview.loading || preview.error) {
      return;
    }
    setPreviewEditorText(preview.text || "");
    setPreviewEditorDirty(false);
    setPreviewSaveStatus(null);
    setPreviewSaving(false);
  }, [preview.error, preview.fileName, preview.loading, preview.text]);

  // Toggle selection
  const toggleRemote = useCallback((name: string) => {
    setSelectedRemote((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleLocal = useCallback((name: string) => {
    setSelectedLocal((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const navigateRemotePath = useCallback(
    (path: string) => {
      setSelectedRemote(new Set());
      requestRemoteList(path);
    },
    [requestRemoteList],
  );

  const previewRemoteTextFile = useCallback(
    (entry: RemoteFileEntry) => {
      if (
        entry.type !== "file" ||
        !isTextPreviewFileName(entry.name) ||
        entry.size > REMOTE_TEXT_EDIT_MAX_BYTES
      ) {
        return false;
      }
      const request = fileTransferRuntimeRef.current.startPreview(
        { name: entry.name, size: entry.size },
        remotePath,
      );
      setPreviewSource({
        kind: "remote",
        sourceIdentity: joinRemoteCopyIdentity(
          daemonFileScopeId,
          remotePath,
          entry.name,
        ),
        truncated: false,
      });
      setPreviewSaveStatus(null);
      setExternalEditCopy(null);
      forceRuntimeTick((value) => value + 1);
      sendJsonRef.current?.(request.message);
      return true;
    },
    [daemonFileScopeId, remotePath],
  );

  const closePreview = useCallback(() => {
    if (previewSaving) {
      return;
    }
    fileTransferRuntimeRef.current.clearPreview();
    setPreviewEditorText("");
    setPreviewEditorDirty(false);
    setPreviewSaveStatus(null);
    setExternalEditCopy(null);
    setPreviewSource(null);
    forceRuntimeTick((value) => value + 1);
  }, [previewSaving]);

  const openInlinePreviewEditor = useCallback(() => {
    window.requestAnimationFrame(() => {
      previewEditorRef.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      previewEditorRef.current?.focus();
    });
  }, []);

  const previewLocalTextFile = useCallback(
    async (entry: LocalFileEntry) => {
      if (entry.type !== "file" || !isTextPreviewFileName(entry.name)) {
        return false;
      }
      try {
        const permissionGranted = await checkLocalStoragePermission();
        if (!permissionGranted) {
          return true;
        }
        const sourcePath = joinLocalDisplayPath(localPath, entry.name);
        const sourceStat = await StoragePermissionPlugin.stat({ path: sourcePath });
        if (sourceStat.type !== "file") {
          throw new Error("local preview source is not a file");
        }
        const sourceSize = Math.max(0, sourceStat.size);
        const maxPreviewBytes = Math.min(
          sourceSize,
          LOCAL_MARKDOWN_PREVIEW_MAX_BYTES,
        );
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        let offset = 0;
        let observedBytes = 0;
        let reachedEof = sourceSize === 0;
        let text = "";
        while (offset < maxPreviewBytes) {
          const length = Math.min(FILE_CHUNK_SIZE, maxPreviewBytes - offset);
          const readResult = await StoragePermissionPlugin.readFileChunk({
            path: sourcePath,
            offset,
            length,
          });
          const bytesRead =
            typeof readResult.bytesRead === "number"
              ? readResult.bytesRead
              : 0;
          const data = typeof readResult.data === "string" ? readResult.data : "";
          if (bytesRead <= 0) {
            reachedEof = Boolean(readResult.eof);
            break;
          }
          text += decoder.decode(decodeBase64Bytes(data), {
            stream: !readResult.eof,
          });
          observedBytes += bytesRead;
          offset += bytesRead;
          if (readResult.eof) {
            reachedEof = true;
            break;
          }
        }
        if (reachedEof) {
          text += decoder.decode();
        }
        const truncated =
          sourceSize > LOCAL_MARKDOWN_PREVIEW_MAX_BYTES ||
          observedBytes < maxPreviewBytes ||
          (!reachedEof && sourceSize <= LOCAL_MARKDOWN_PREVIEW_MAX_BYTES);
        fileTransferRuntimeRef.current.setPreviewText(entry.name, text);
        setPreviewSource({
          kind: "local",
          sourcePath,
          sourceIdentity: sourcePath,
          truncated,
        });
        setPreviewSaveStatus(null);
        setExternalEditCopy(null);
        forceRuntimeTick((value) => value + 1);
      } catch (error) {
        fileTransferRuntimeRef.current.setPreviewError(
          entry.name,
          error instanceof Error ? error.message : String(error),
        );
        setPreviewSource({
          kind: "local",
          sourcePath: joinLocalDisplayPath(localPath, entry.name),
          sourceIdentity: joinLocalDisplayPath(localPath, entry.name),
          truncated: false,
        });
        forceRuntimeTick((value) => value + 1);
      }
      return true;
    },
    [checkLocalStoragePermission, localPath],
  );

  const uploadChunksToRemote = useCallback(async (options: {
    fileName: string;
    totalBytes: number;
    totalChunks: number;
    readChunk: (chunkIndex: number) => Promise<string>;
    savingStatus: string;
    successStatus: string;
  }) => {
    if (!sendJsonRef.current) {
      setPreviewSaveStatus("保存失败：文件传输通道未就绪，请等待连接恢复后重试。");
      return false;
    }
    let uploadRequest: ReturnType<
      ReturnType<typeof createFileTransferSessionRuntime>["startUpload"]
    > | null = null;
    let endSent = false;
    const sendUploadMessage = (message: unknown) => {
      const sender = sendJsonRef.current;
      if (!sender) {
        throw new Error("文件传输通道已断开，请等待连接恢复后重试。");
      }
      sender(message);
    };
    try {
      const targetDir = remotePath.trim();
      if (!targetDir) {
        throw new Error("remote path unavailable");
      }
      setPreviewSaveStatus(options.savingStatus);
      uploadRequest = fileTransferRuntimeRef.current.startUpload(
        { name: options.fileName, size: options.totalBytes },
        targetDir,
        options.totalChunks,
      );
      const currentUploadRequest = uploadRequest;
      forceRuntimeTick((value) => value + 1);
      sendUploadMessage(currentUploadRequest.startMessage);
      await sendBoundedFileUploadChunks({
        totalChunks: options.totalChunks,
        waitForProgress: currentUploadRequest.waitForProgress,
        resume: currentUploadRequest.resumePolicy,
        readChunk: options.readChunk,
        sendChunk: (chunkIndex, dataBase64) => {
          const chunkMessage = currentUploadRequest.buildChunkMessage(
            chunkIndex,
            dataBase64,
          );
          const encodedFrameChars = JSON.stringify(chunkMessage).length;
          if (encodedFrameChars > FILE_TRANSFER_WIRE_FRAME_MAX_CHARS) {
            throw new Error(
              `edited text chunk ${chunkIndex} wire frame too large: ${encodedFrameChars} chars`,
            );
          }
          sendUploadMessage(chunkMessage);
        },
      });
      sendUploadMessage(currentUploadRequest.endMessage);
      endSent = true;
      await currentUploadRequest.waitForDone();
      setPreviewSaveStatus(options.successStatus);
      requestRemoteList(remotePath);
      return true;
    } catch (error) {
      if (uploadRequest) {
        if (!endSent) {
          sendJsonRef.current?.(uploadRequest.endMessage);
        }
        fileTransferRuntimeRef.current.markTransferError(
          uploadRequest.requestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      setPreviewSaveStatus(
        `保存失败：${error instanceof Error ? error.message : String(error)}`,
      );
      forceRuntimeTick((value) => value + 1);
      return false;
    }
  }, [remotePath, requestRemoteList]);

  const savePreviewToRemote = useCallback(async () => {
    const fileName = preview.fileName;
    if (!fileName || previewSaving) {
      return;
    }
    if (previewSource?.kind === "local" && previewSource.truncated) {
      setPreviewSaveStatus(
        "保存失败：本地预览已截断，请先本地打开完整副本后再同步。",
      );
      return;
    }
    const textToSave = previewEditorDirty
      ? previewEditorText
      : preview.text ?? previewEditorText;
    const encoded = new TextEncoder().encode(textToSave);
    const chunkCount = Math.max(1, Math.ceil(encoded.length / FILE_CHUNK_SIZE));
    setPreviewSaving(true);
    try {
      await uploadChunksToRemote({
        fileName,
        totalBytes: encoded.length,
        totalChunks: chunkCount,
        savingStatus: "保存到远端中…",
        successStatus: "已保存到远端",
        readChunk: async (chunkIndex) => {
          const start = chunkIndex * FILE_CHUNK_SIZE;
          const end = Math.min(start + FILE_CHUNK_SIZE, encoded.length);
          return encodeBytesToBase64(encoded.subarray(start, end));
        },
      });
    } finally {
      setPreviewSaving(false);
    }
  }, [
    preview.fileName,
    preview.text,
    previewSource,
    previewEditorDirty,
    previewEditorText,
    previewSaving,
    uploadChunksToRemote,
  ]);

  const openPreviewInLocalEditor = useCallback(async () => {
    const fileName = preview.fileName;
    if (!fileName) {
      return;
    }
    try {
      const permissionGranted = await ensureLocalStoragePermission(true);
      if (!permissionGranted) {
        setPreviewSaveStatus("本地打开失败：未获得本地存储权限。");
        return;
      }
      const existingEditCopy =
        externalEditCopy?.fileName === fileName ? externalEditCopy : null;
      const sourceKind = previewSource?.kind || "remote";
      const sourceIdentity =
        previewSource?.sourceIdentity ||
        joinRemoteCopyIdentity(daemonFileScopeId, remotePath || localPath, fileName);
      const targetPath = existingEditCopy
        ? existingEditCopy.path
        : sourceKind === "local" && previewSource?.kind === "local"
        ? buildLocalPreviewEditCopyPath(previewSource.sourcePath, fileName)
        : buildRemoteLocalEditCopyPath(sourceIdentity, fileName);
      const existingCopy = existingEditCopy
        ? null
        : await resolveExistingLocalEditCopy(targetPath);
      const copyState = existingCopy?.exists
        ? readLocalEditCopyState(sourceKind, sourceIdentity, targetPath)
        : null;
      const shouldReuseExistingCopy = Boolean(
        existingEditCopy ||
        (existingCopy?.exists &&
          copyState &&
          (copyState.state === "unsynced" ||
            copyState.size !== existingCopy.stat.size ||
            copyState.modified !== existingCopy.stat.modified)),
      );
      if (existingCopy?.exists && !copyState) {
        throw new Error("本地编辑副本状态未知，已停止覆盖；请手动同步或删除该副本后重试。");
      }
      if (shouldReuseExistingCopy) {
        // Preserve unsynced external-editor changes; this path only reopens the existing copy.
      } else if (previewSource?.kind === "local" && previewSource.truncated) {
        await StoragePermissionPlugin.copyFile({
          sourcePath: previewSource.sourcePath,
          targetPath,
        });
      } else {
        const textToOpen = previewEditorDirty
          ? previewEditorText
          : preview.text ?? previewEditorText;
        const encoded = new TextEncoder().encode(textToOpen);
        await StoragePermissionPlugin.writeFile({
          path: targetPath,
          data: encodeBytesToBase64(encoded),
        });
      }
      writeLocalEditCopyState(sourceKind, sourceIdentity, {
        state: "unsynced",
        path: targetPath,
        fileName,
        size: existingCopy?.exists ? existingCopy.stat.size : -1,
        modified: existingCopy?.exists ? existingCopy.stat.modified : -1,
      });
      await StoragePermissionPlugin.openFile({
        path: targetPath,
        mimeType: resolveTextMimeType(fileName),
      });
      setExternalEditCopy({ fileName, path: targetPath });
      setPreviewSaveStatus(
        shouldReuseExistingCopy
          ? "已重新打开本地副本，编辑后点“同步本地副本”"
          : "已写入本地副本，编辑后点“同步本地副本”",
      );
      if (!browserMode) {
        await loadLocalDir(localPath, { requestPermission: false });
      }
    } catch (error) {
      setPreviewSaveStatus(
        `本地打开失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [
    ensureLocalStoragePermission,
    browserMode,
    loadLocalDir,
    localPath,
    preview.fileName,
    preview.text,
    previewSource,
    externalEditCopy,
    previewEditorDirty,
    previewEditorText,
    daemonFileScopeId,
    remotePath,
  ]);

  const syncExternalEditCopyToRemote = useCallback(async () => {
    const fileName = preview.fileName;
    const localCopy = externalEditCopy;
    if (!fileName || !localCopy || localCopy.fileName !== fileName || previewSaving) {
      return;
    }
    setPreviewSaving(true);
    try {
      const permissionGranted = await ensureLocalStoragePermission(true);
      if (!permissionGranted) {
        setPreviewSaveStatus("同步失败：未获得本地存储权限。");
        return;
      }
      const snapshotPath = buildLocalEditSnapshotPath(localCopy.path);
      const snapshot = await StoragePermissionPlugin.createStableFileSnapshot({
        sourcePath: localCopy.path,
        snapshotPath,
      });
      const totalBytes = Math.max(0, snapshot.size);
      const totalChunks = Math.max(1, Math.ceil(totalBytes / FILE_CHUNK_SIZE));
      const uploaded = await uploadChunksToRemote({
        fileName,
        totalBytes,
        totalChunks,
        savingStatus: "同步本地副本到远端中…",
        successStatus: "本地副本已同步到远端",
        readChunk: async (chunkIndex) => {
          const offset = chunkIndex * FILE_CHUNK_SIZE;
          const length =
            totalBytes === 0
              ? 0
              : Math.min(FILE_CHUNK_SIZE, Math.max(0, totalBytes - offset));
          if (length === 0) {
            return "";
          }
          const readResult = await StoragePermissionPlugin.readFileChunk({
            path: snapshot.path,
            offset,
            length,
          });
          if (readResult.bytesRead !== length) {
            throw new Error(
              `local edit snapshot chunk ${chunkIndex} read ${readResult.bytesRead} bytes, expected ${length}`,
            );
          }
          return typeof readResult.data === "string" ? readResult.data : "";
        },
      });
      if (uploaded) {
        const sourceKind = previewSource?.kind || "remote";
        const sourceIdentity =
          previewSource?.sourceIdentity ||
          joinRemoteCopyIdentity(daemonFileScopeId, remotePath || localPath, fileName);
        const sourceStat = await StoragePermissionPlugin.stat({ path: localCopy.path });
        if (sourceStat.type !== "file") {
          throw new Error("local edit copy path is no longer a file after sync");
        }
        writeLocalEditCopyState(sourceKind, sourceIdentity, {
          state: "synced",
          path: localCopy.path,
          fileName,
          size: sourceStat.size,
          modified: sourceStat.modified,
        });
      }
      try {
        await StoragePermissionPlugin.deleteFile({ path: snapshot.path });
      } catch (cleanupError) {
        if (uploaded) {
          setPreviewSaveStatus(
            `本地副本已同步到远端；临时快照清理失败：${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        } else {
          throw cleanupError;
        }
      }
      if (!browserMode) {
        await loadLocalDir(localPath, { requestPermission: false });
      }
    } catch (error) {
      setPreviewSaveStatus(
        `同步失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setPreviewSaving(false);
    }
  }, [
    ensureLocalStoragePermission,
    browserMode,
    externalEditCopy,
    loadLocalDir,
    localPath,
    daemonFileScopeId,
    preview.fileName,
    previewSource,
    previewSaving,
    remotePath,
    uploadChunksToRemote,
  ]);

  // Start transfer
  const startTransfer = useCallback(async () => {
    if (direction === "download") {
      // Download selected remote files
      for (const name of selectedRemote) {
        const entry = remoteEntries.find((e) => e.name === name);
        if (!entry || entry.type !== "file") continue;
        const request = fileTransferRuntimeRef.current.startDownload(
          { name, size: entry.size },
          remotePath,
        );
        forceRuntimeTick((value) => value + 1);
        sendJson?.(request.message);
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
        const entry = localEntries.find((e) => e.name === name);
        if (!entry || entry.type !== "file") continue;
        let uploadRequest: ReturnType<
          ReturnType<typeof createFileTransferSessionRuntime>["startUpload"]
        > | null = null;
        try {
          const targetDir = remotePath.trim();
          if (!targetDir) {
            throw new Error("remote path unavailable");
          }
          const sourcePath = joinLocalDisplayPath(localPath, name);
          const chunkCount = Math.max(1, Math.ceil(entry.size / FILE_CHUNK_SIZE));
          uploadRequest = fileTransferRuntimeRef.current.startUpload(
            { name, size: entry.size },
            targetDir,
            chunkCount,
          );
          const currentUploadRequest = uploadRequest;
          forceRuntimeTick((value) => value + 1);
          sendJson?.(currentUploadRequest.startMessage);

          const dispatchUploadChunk = (
            chunkIndex: number,
            dataBase64: string,
          ) => {
            const chunkMessage = currentUploadRequest.buildChunkMessage(
              chunkIndex,
              dataBase64,
            );
            const encodedFrameChars = JSON.stringify(chunkMessage).length;
            if (encodedFrameChars > FILE_TRANSFER_WIRE_FRAME_MAX_CHARS) {
              throw new Error(
                `upload chunk ${chunkIndex} wire frame too large: ${encodedFrameChars} chars`,
              );
            }
            sendJson?.(chunkMessage);
          };
          await sendBoundedFileUploadChunks({
            totalChunks: chunkCount,
            waitForProgress: currentUploadRequest.waitForProgress,
            resume: currentUploadRequest.resumePolicy,
            readChunk: async (chunkIndex) => {
              const offset = chunkIndex * FILE_CHUNK_SIZE;
              const length =
                entry.size === 0
                  ? 0
                  : Math.min(FILE_CHUNK_SIZE, Math.max(0, entry.size - offset));
              const readResult = await StoragePermissionPlugin.readFileChunk({
                path: sourcePath,
                offset,
                length,
              });
              if (length > 0 && readResult.bytesRead <= 0) {
                throw new Error(`local upload chunk ${chunkIndex} returned no bytes`);
              }
              return typeof readResult.data === "string" ? readResult.data : "";
            },
            sendChunk: dispatchUploadChunk,
          });
          sendJson?.(currentUploadRequest.endMessage);
          await currentUploadRequest.waitForDone();
        } catch (err) {
          if (uploadRequest) {
            sendJson?.(uploadRequest.endMessage);
            fileTransferRuntimeRef.current.markTransferError(
              uploadRequest.requestId,
              err instanceof Error ? err.message : String(err),
            );
          } else {
            const requestId = `ful-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            fileTransferRuntimeRef.current.appendTransferError({
              id: requestId,
              fileName: name,
              direction: "upload",
              totalBytes: entry.size,
              transferredBytes: 0,
              status: "error",
              error: String(err),
            });
          }
          forceRuntimeTick((value) => value + 1);
        }
      }
      setSelectedLocal(new Set());
      // Refresh remote list
      requestRemoteList(remotePath);
    }
  }, [
    checkLocalStoragePermission,
    direction,
    selectedRemote,
    selectedLocal,
    remoteEntries,
    localEntries,
    remotePath,
    localPath,
    sendJson,
    requestRemoteList,
  ]);

  if (!open) return null;

  return (
    <div
      className="zterm-terminal-shell zterm-file-sheet-overlay"
      data-testid="file-transfer-overlay"
      data-avoid-side={avoidSide || undefined}
      data-terminal-shell-skin={terminalShellSkin}
      style={buildTransferSheetOverlayStyle(avoidSide)}
      onClick={onClose}
    >
      <div
        className="zterm-file-sheet"
        data-testid="file-transfer-sheet"
        data-layout={avoidSide ? "side" : "bottom"}
        data-preview-open={previewOpen ? "true" : undefined}
        style={buildTransferSheetContainerStyle(avoidSide, mode)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div
            style={{
              fontSize: "17px",
              fontWeight: 800,
              color: SHEET_TEXT,
            }}
          >
            {browserMode ? "文件浏览" : "文件同步"}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={actionButtonStyle(SHEET_SURFACE, SHEET_TEXT)}
          >
            ✕
          </button>
        </div>

        {/* Remote panel */}
        {!sendJson || !onFileTransferMessage ? (
          <div
            data-testid="file-transfer-unavailable"
            style={{
              margin: "0 10px 8px",
              padding: "10px 12px",
              borderRadius: "12px",
              border: `1px solid ${SHEET_BORDER}`,
              color: SHEET_MUTED,
              background: SHEET_SURFACE,
              fontSize: "13px",
              lineHeight: 1.45,
            }}
          >
            {browserMode
              ? "文件浏览通道未就绪，请先等待当前 session 连接完成。"
              : "文件同步通道未就绪，请先等待当前 session 连接完成。"}
          </div>
        ) : null}

        <>
          <div style={sectionLabelStyle}>
            <span>🖥 远程: {shortenDisplayPath(remotePath)}</span>
            {renderSortControls(
              remoteSortField,
              setRemoteSortField,
              remoteSortDirection,
              setRemoteSortDirection,
            )}
          </div>
          <div style={pathBreadcrumbStyle}>
            <button
              type="button"
              onClick={() =>
                remoteParentPath && navigateRemotePath(remoteParentPath)
              }
              style={{
                ...actionButtonStyle("transparent", SHEET_ACCENT),
                minHeight: "24px",
                padding: "0 6px",
                fontSize: "12px",
              }}
            >
              ← 上级
            </button>
            <span style={{ color: SHEET_MUTED }}>
              {shortenDisplayPath(remotePath)}
            </span>
          </div>
          <div
            style={{
              ...fileListContainerStyle,
              maxHeight: browserMode ? "60vh" : "28vh",
              flex: "none",
            }}
          >
            {remoteLoading ? (
              <div
                style={{
                  padding: "20px",
                  textAlign: "center",
                  color: SHEET_MUTED,
                }}
              >
                加载中…
              </div>
            ) : remoteError ? (
              <div
                data-testid="file-transfer-remote-error"
                style={{
                  padding: "20px",
                  textAlign: "center",
                  color: SHEET_DANGER,
                  lineHeight: 1.5,
                }}
              >
                远程目录读取失败：{remoteError}
              </div>
            ) : visibleRemoteEntries.length === 0 ? (
              <div
                style={{
                  padding: "20px",
                  textAlign: "center",
                  color: SHEET_MUTED,
                }}
              >
                空目录
              </div>
            ) : (
              visibleRemoteEntries.map((entry) => (
                <div
                  key={entry.name}
                  style={fileRowStyle}
                  onClick={() => {
                    if (entry.type === "directory") {
                      navigateRemotePath(
                        remotePath === "/"
                          ? `/${entry.name}`
                          : `${remotePath}/${entry.name}`,
                      );
                    } else if (previewRemoteTextFile(entry)) {
                      return;
                    } else if (browserMode) {
                      fileTransferRuntimeRef.current.setPreviewError(
                        entry.name,
                        entry.size > REMOTE_TEXT_EDIT_MAX_BYTES
                          ? "文件超过 512KB，当前浏览器只支持轻量文本预览/编辑。"
                          : "当前只支持文本和代码文件预览/编辑。",
                      );
                      setPreviewSource({
                        kind: "remote",
                        sourceIdentity: joinRemoteCopyIdentity(daemonFileScopeId, remotePath, entry.name),
                        truncated: false,
                      });
                      setPreviewSaveStatus(null);
                      setExternalEditCopy(null);
                      forceRuntimeTick((value) => value + 1);
                    } else {
                      toggleRemote(entry.name);
                    }
                  }}
                >
                  {!browserMode ? (
                    <button
                      type="button"
                      aria-label={`选择远程 ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleRemote(entry.name);
                      }}
                      style={fileCheckboxStyle(selectedRemote.has(entry.name))}
                    >
                      {selectedRemote.has(entry.name) ? "✓" : ""}
                    </button>
                  ) : null}
                  <span style={{ fontSize: "16px", flexShrink: 0 }}>
                    {entry.type === "directory" ? "📁" : "📄"}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "13px",
                      color: SHEET_TEXT,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.name}
                  </span>
                  {entry.type === "file" && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: SHEET_MUTED,
                        flexShrink: 0,
                      }}
                    >
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </>

        {preview.fileName ? (
          <div
            data-testid="file-transfer-md-preview"
            data-preview-open="fullscreen"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 96,
              display: "flex",
              flexDirection: "column",
              padding:
                "calc(12px + env(safe-area-inset-top, 0px)) 12px calc(12px + env(safe-area-inset-bottom, 0px))",
              background: "var(--zterm-panel-bg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                flexWrap: "wrap",
                padding: "0 0 10px",
                borderBottom: `1px solid ${SHEET_BORDER}`,
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={closePreview}
                disabled={previewSaving}
                style={{
                  ...actionButtonStyle(
                    "rgba(255,255,255,0.06)",
                    SHEET_TEXT,
                  ),
                  minHeight: "34px",
                  padding: "0 10px",
                  fontSize: "13px",
                  opacity: previewSaving ? 0.5 : 1,
                }}
              >
                ← 返回
              </button>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "13px",
                  fontWeight: 800,
                  color: SHEET_TEXT,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {preview.fileName}
              </span>
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                  flex: "1 1 100%",
                  minWidth: 0,
                }}
              >
                <button
                  type="button"
                  onClick={openInlinePreviewEditor}
                  disabled={preview.loading || Boolean(preview.error) || previewSaving}
                  style={{
                    ...actionButtonStyle(
                      "rgba(31,214,122,0.22)",
                      SHEET_ACCENT,
                    ),
                    minHeight: "24px",
                    padding: "0 8px",
                    fontSize: "12px",
                    opacity:
                      preview.loading || preview.error || previewSaving ? 0.5 : 1,
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={openPreviewInLocalEditor}
                  disabled={localOpenDisabledForPreview}
                  style={{
                    ...actionButtonStyle(
                      "transparent",
                      SHEET_MUTED,
                    ),
                    minHeight: "24px",
                    padding: "0 8px",
                    fontSize: "12px",
                    opacity: localOpenDisabledForPreview ? 0.5 : 1,
                  }}
                >
                  本地打开
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void savePreviewToRemote();
                  }}
                  disabled={saveDisabledForPreview}
                  style={{
                    ...actionButtonStyle(
                      "rgba(31,214,122,0.22)",
                      SHEET_ACCENT,
                    ),
                    minHeight: "24px",
                    padding: "0 8px",
                    fontSize: "12px",
                    opacity: saveDisabledForPreview ? 0.5 : 1,
                  }}
                >
                  保存
                </button>
                {externalEditCopy?.fileName === preview.fileName ? (
                  <button
                    type="button"
                    onClick={() => {
                      void syncExternalEditCopyToRemote();
                    }}
                    disabled={syncCopyDisabledForPreview}
                    style={{
                      ...actionButtonStyle(
                        "rgba(96, 149, 255, 0.18)",
                        SHEET_TEXT,
                      ),
                      minHeight: "24px",
                      padding: "0 8px",
                      fontSize: "12px",
                      opacity: syncCopyDisabledForPreview ? 0.5 : 1,
                    }}
                  >
                    同步本地副本
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onClose}
                  disabled={previewSaving}
                  style={{
                    ...actionButtonStyle(
                      "transparent",
                      SHEET_MUTED,
                    ),
                    minHeight: "24px",
                    padding: "0 8px",
                    fontSize: "12px",
                    opacity: previewSaving ? 0.5 : 1,
                  }}
                >
                  关闭
                </button>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "12px 0 0",
                color: SHEET_MUTED,
                fontSize: "13px",
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
              }}
            >
              {preview.loading
                ? "加载预览中…"
                : preview.error
                  ? `预览失败：${preview.error}`
                  : (
                    <>
                      {isMarkdownFileName(preview.fileName) ? (
                        <div
                          style={{
                            padding: "0 0 10px",
                            borderBottom: `1px solid ${SHEET_BORDER}`,
                            marginBottom: "10px",
                          }}
                        >
                          {renderMarkdownPreview(previewEditorText)}
                        </div>
                      ) : null}
                      <textarea
                        aria-label="编辑远程文本"
                        ref={previewEditorRef}
                        value={previewEditorText}
                        disabled={previewSaving}
                        onChange={(event) => {
                          setPreviewEditorText(event.target.value);
                          setPreviewEditorDirty(true);
                          setPreviewSaveStatus(null);
                        }}
                        style={{
                          width: "100%",
                          minHeight: "58vh",
                          resize: "none",
                          borderRadius: "12px",
                          border: `1px solid ${SHEET_BORDER}`,
                          background: "rgba(255,255,255,0.04)",
                          color: SHEET_TEXT,
                          padding: "10px",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: "12px",
                          lineHeight: 1.45,
                          opacity: previewSaving ? 0.72 : 1,
                        }}
                      />
                      {previewSource?.kind === "local" && previewSource.truncated ? (
                        <div
                          style={{
                            marginTop: "6px",
                            color: SHEET_MUTED,
                            fontSize: "12px",
                          }}
                        >
                          预览已截断，请用本地打开编辑完整副本；当前预览不能直接保存到远端。
                        </div>
                      ) : null}
                      {previewSaveStatus ? (
                        <div
                          style={{
                            marginTop: "8px",
                            color: previewSaveStatus.startsWith("保存失败") ||
                              previewSaveStatus.startsWith("本地打开失败") ||
                              previewSaveStatus.startsWith("同步失败")
                              ? SHEET_DANGER
                              : SHEET_MUTED,
                            fontSize: "12px",
                          }}
                        >
                          {previewSaveStatus}
                        </div>
                      ) : null}
                    </>
                  )}
            </div>
          </div>
        ) : null}

        {!browserMode ? (
          <>
            {/* Direction controls */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "12px",
                padding: "8px 10px",
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => setDirection("download")}
                style={actionButtonStyle(
                  direction === "download"
                    ? "rgba(31,214,122,0.22)"
                    : SHEET_SURFACE,
                  direction === "download" ? SHEET_ACCENT : SHEET_TEXT,
                )}
              >
                ⬇ 下载到本地
              </button>
              <button
                type="button"
                onClick={startTransfer}
                style={actionButtonStyle(
                  "linear-gradient(180deg, rgba(96, 149, 255, 0.92), rgba(72, 122, 230, 0.92))",
                  "#fff",
                )}
              >
                {resolvePrimaryTransferLabel(
                  direction,
                  direction === "download"
                    ? selectedRemote.size
                    : selectedLocal.size,
                )}
              </button>
              <button
                type="button"
                onClick={() => setDirection("upload")}
                style={actionButtonStyle(
                  direction === "upload"
                    ? "rgba(31,214,122,0.22)"
                    : SHEET_SURFACE,
                  direction === "upload" ? SHEET_ACCENT : SHEET_TEXT,
                )}
              >
                ⬆ 上传到远程
              </button>
            </div>

            {/* Local panel */}
            <div style={sectionLabelStyle}>
              <span>📱 本地: {shortenDisplayPath(localPath)}</span>
              {renderSortControls(
                localSortField,
                setLocalSortField,
                localSortDirection,
                setLocalSortDirection,
              )}
            </div>
            <div style={pathBreadcrumbStyle}>
              <button
                type="button"
                onClick={() => {
                  setLocalPath(getParentLocalDisplayPath(localPath));
                  setSelectedLocal(new Set());
                }}
                style={{
                  ...actionButtonStyle("transparent", SHEET_ACCENT),
                  minHeight: "24px",
                  padding: "0 6px",
                  fontSize: "12px",
                }}
              >
                ← 上级
              </button>
              <span style={{ color: SHEET_MUTED }}>
                {shortenDisplayPath(localPath)}
              </span>
            </div>
            <div
              style={{ ...fileListContainerStyle, maxHeight: "22vh", flex: "none" }}
            >
              {localLoading ? (
                <div
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    color: SHEET_MUTED,
                  }}
                >
                  加载中…
                </div>
              ) : localPermissionGranted === false ? (
                <div
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    color: SHEET_MUTED,
                    lineHeight: 1.5,
                  }}
                >
                  {localPermissionError || "本地文件同步需要先授权存储权限。"}
                </div>
              ) : localListError ? (
                <div
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    color: SHEET_MUTED,
                    lineHeight: 1.5,
                  }}
                >
                  {localListError}
                </div>
              ) : visibleLocalEntries.length === 0 ? (
                <div
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    color: SHEET_MUTED,
                  }}
                >
                  空目录
                </div>
              ) : (
                visibleLocalEntries.map((entry) => (
              <div
                key={entry.name}
                style={fileRowStyle}
                onClick={() => {
                  if (entry.type === "directory") {
                    setLocalPath(joinLocalDisplayPath(localPath, entry.name));
                    setSelectedLocal(new Set());
                  } else if (isTextPreviewFileName(entry.name)) {
                    void previewLocalTextFile(entry);
                  } else {
                    toggleLocal(entry.name);
                  }
                }}
              >
                <button
                  type="button"
                  aria-label={`选择本地 ${entry.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleLocal(entry.name);
                  }}
                  style={fileCheckboxStyle(selectedLocal.has(entry.name))}
                >
                  {selectedLocal.has(entry.name) ? "✓" : ""}
                </button>
                <span style={{ fontSize: "16px", flexShrink: 0 }}>
                  {entry.type === "directory" ? "📁" : "📄"}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: "13px",
                    color: SHEET_TEXT,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.name}
                </span>
                  {entry.type === "file" && (
                    <span
                    style={{
                      fontSize: "11px",
                      color: SHEET_MUTED,
                      flexShrink: 0,
                    }}
                  >
                    {formatBytes(entry.size)}
                  </span>
                  )}
                </div>
                ))
              )}
            </div>
          </>
        ) : null}

        {/* Transfer progress */}
        {transfers.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              padding: "6px 0",
              borderTop: `1px solid ${SHEET_BORDER}`,
            }}
          >
            <div
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: SHEET_MUTED,
                padding: "2px 10px 4px",
              }}
            >
              传输进度
            </div>
            {transfers.map((t) => (
              <div key={t.id} style={progressRowStyle}>
                <span style={{ fontSize: "14px", flexShrink: 0 }}>
                  {t.direction === "download" ? "⬇" : "⬆"}
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.fileName}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    color:
                      t.status === "done"
                        ? SHEET_ACCENT
                        : t.status === "error"
                          ? SHEET_DANGER
                          : SHEET_MUTED,
                  }}
                >
                  {t.status === "done"
                    ? "✓ 完成"
                    : t.status === "error"
                      ? `✗ ${t.error || "错误"}`
                      : `${formatBytes(t.transferredBytes * FILE_CHUNK_SIZE)} / ${formatBytes(t.totalBytes)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

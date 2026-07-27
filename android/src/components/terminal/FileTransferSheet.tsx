import { useCallback, useEffect, useRef, useState } from "react";
import { mobileTheme } from "../../lib/mobile-ui";
import { createFileTransferSessionRuntime } from "../../lib/file-transfer-session-runtime";
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

const FILE_CHUNK_SIZE = FILE_TRANSFER_WIRE_CHUNK_BYTES; // must match daemon wire chunk
const LOCAL_MARKDOWN_PREVIEW_MAX_BYTES = 512 * 1024;
const EXTERNAL_STORAGE_ROOT = "/storage/emulated/0";
const DEFAULT_LOCAL_DOWNLOAD_DIR = `${EXTERNAL_STORAGE_ROOT}/Download/zterm`;

interface FileTransferSheetProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson?: (msg: unknown) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
  avoidSide?: "left" | "right" | null;
}

interface RemoteFileEntry extends FileEntry {}
interface LocalFileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: number;
  mimeType?: string;
  uri?: string;
}

type FileSortField = "name" | "modified";
type FileSortDirection = "asc" | "desc";
type SortableFileEntry = Pick<
  LocalFileEntry,
  "name" | "type" | "modified"
>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 2) + "…";
}

function isMarkdownFileName(name: string) {
  return /\.(md|markdown|mdown|mkdn)$/i.test(name.trim());
}

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
            color: mobileTheme.colors.textPrimary,
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

function decodeBase64Bytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeLocalDisplayPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed === EXTERNAL_STORAGE_ROOT) {
    return EXTERNAL_STORAGE_ROOT;
  }
  if (trimmed.startsWith(`${EXTERNAL_STORAGE_ROOT}/`)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (trimmed.startsWith("/")) {
    return `${EXTERNAL_STORAGE_ROOT}/${trimmed.replace(/^\/+/, "")}`.replace(
      /\/+$/,
      "",
    );
  }
  return `${EXTERNAL_STORAGE_ROOT}/${trimmed}`.replace(/\/+$/, "");
}

function joinLocalDisplayPath(parentPath: string, childName: string) {
  const normalizedParent = normalizeLocalDisplayPath(parentPath);
  if (normalizedParent === EXTERNAL_STORAGE_ROOT) {
    return `${EXTERNAL_STORAGE_ROOT}/${childName}`;
  }
  return `${normalizedParent}/${childName}`;
}

function getParentLocalDisplayPath(path: string) {
  const normalized = normalizeLocalDisplayPath(path);
  if (normalized === EXTERNAL_STORAGE_ROOT) {
    return EXTERNAL_STORAGE_ROOT;
  }
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent.length >= EXTERNAL_STORAGE_ROOT.length
    ? parent
    : EXTERNAL_STORAGE_ROOT;
}

function compareFileEntries(
  a: SortableFileEntry,
  b: SortableFileEntry,
  sortField: FileSortField,
  sortDirection: FileSortDirection,
) {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  const value =
    sortField === "modified"
      ? a.modified - b.modified || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name);
  return sortDirection === "asc" ? value : -value;
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
    ? `2px solid ${mobileTheme.colors.accent}`
    : "2px solid rgba(255,255,255,0.25)",
  background: checked ? mobileTheme.colors.accent : "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  flexShrink: 0,
  color: "#000",
  fontSize: "12px",
  fontWeight: 800,
  cursor: "pointer",
});

const pathBreadcrumbStyle = {
  fontSize: "12px",
  color: mobileTheme.colors.textSecondary,
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
  color: mobileTheme.colors.textPrimary,
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
  color: mobileTheme.colors.textSecondary,
};

const sortControlStyle = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexShrink: 0,
};

export function FileTransferSheet({
  open,
  remoteCwd,
  onClose,
  sendJson,
  onFileTransferMessage,
  avoidSide = null,
}: FileTransferSheetProps) {
  const sendJsonRef = useRef(sendJson);
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
            for (let index = 0; index < orderedChunksBase64.length; index += 1) {
              await StoragePermissionPlugin.writeFileChunk({
                path: targetPath,
                data: orderedChunksBase64[index] || "",
                append: index > 0,
              });
            }
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

  useEffect(() => {
    localPathRef.current = localPath;
  }, [localPath]);

  // Direction
  const [direction, setDirection] = useState<"upload" | "download">("download");

  // Transfers
  const transfers = runtimeState.transfers as TransferProgress[];
  const preview = runtimeState.preview;
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
          ...actionButtonStyle("transparent", mobileTheme.colors.textSecondary),
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
          ...actionButtonStyle("transparent", mobileTheme.colors.textSecondary),
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
    setDirection("download");
    forceRuntimeTick((value) => value + 1);
    requestRemoteList(initialRemotePath);
  }, [open, remoteCwd, requestRemoteList]);

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
    if (open && localPath) {
      loadLocalDir(localPath, { requestPermission: true });
    }
  }, [open, localPath, loadLocalDir]);

  useEffect(() => {
    if (!open) {
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
  }, [open, localPath, loadLocalDir]);

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

  const previewRemoteMarkdown = useCallback(
    (entry: RemoteFileEntry) => {
      if (entry.type !== "file" || !isMarkdownFileName(entry.name)) {
        return false;
      }
      const request = fileTransferRuntimeRef.current.startPreview(
        { name: entry.name, size: entry.size },
        remotePath,
      );
      forceRuntimeTick((value) => value + 1);
      sendJsonRef.current?.(request.message);
      return true;
    },
    [remotePath],
  );

  const previewLocalMarkdown = useCallback(
    async (entry: LocalFileEntry) => {
      if (entry.type !== "file" || !isMarkdownFileName(entry.name)) {
        return false;
      }
      try {
        const permissionGranted = await checkLocalStoragePermission();
        if (!permissionGranted) {
          return true;
        }
        const sourcePath = joinLocalDisplayPath(localPath, entry.name);
        const maxPreviewBytes = Math.min(
          entry.size,
          LOCAL_MARKDOWN_PREVIEW_MAX_BYTES,
        );
        const decoder = new TextDecoder();
        let offset = 0;
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
          text += decoder.decode(decodeBase64Bytes(data), {
            stream: !readResult.eof && offset + bytesRead < maxPreviewBytes,
          });
          if (bytesRead <= 0 || readResult.eof) {
            break;
          }
          offset += bytesRead;
        }
        text += decoder.decode();
        if (entry.size > LOCAL_MARKDOWN_PREVIEW_MAX_BYTES) {
          text += "\n\n（预览已截断，上传仍会传输完整文件。）";
        }
        fileTransferRuntimeRef.current.setPreviewText(entry.name, text);
        forceRuntimeTick((value) => value + 1);
      } catch (error) {
        fileTransferRuntimeRef.current.setPreviewError(
          entry.name,
          error instanceof Error ? error.message : String(error),
        );
        forceRuntimeTick((value) => value + 1);
      }
      return true;
    },
    [checkLocalStoragePermission, localPath],
  );

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
          forceRuntimeTick((value) => value + 1);
          sendJson?.(uploadRequest.startMessage);

          for (let i = 0; i < chunkCount; i++) {
            const offset = i * FILE_CHUNK_SIZE;
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
              throw new Error(`local upload chunk ${i} returned no bytes`);
            }
            const dataBase64 =
              typeof readResult.data === "string" ? readResult.data : "";
            const chunkMessage = uploadRequest.buildChunkMessage(i, dataBase64);
            const encodedFrameChars = JSON.stringify(chunkMessage).length;
            if (encodedFrameChars > FILE_TRANSFER_WIRE_FRAME_MAX_CHARS) {
              throw new Error(
                `upload chunk ${i} wire frame too large: ${encodedFrameChars} chars`,
              );
            }
            sendJson?.(chunkMessage);
            await uploadRequest.waitForProgress(i + 1);
          }
          sendJson?.(uploadRequest.endMessage);
          await uploadRequest.waitForDone();
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
      data-testid="file-transfer-overlay"
      data-avoid-side={avoidSide || undefined}
      style={buildTransferSheetOverlayStyle(avoidSide)}
      onClick={onClose}
    >
      <div
        data-testid="file-transfer-sheet"
        data-layout={avoidSide ? "side" : "bottom"}
        style={buildTransferSheetContainerStyle(avoidSide)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div
            style={{
              fontSize: "17px",
              fontWeight: 800,
              color: mobileTheme.colors.textPrimary,
            }}
          >
            文件同步
          </div>
          <button
            type="button"
            onClick={onClose}
            style={actionButtonStyle(mobileTheme.colors.shellMuted, "#fff")}
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
              border: `1px solid ${mobileTheme.colors.cardBorder}`,
              color: mobileTheme.colors.textSecondary,
              background: "rgba(255,255,255,0.04)",
              fontSize: "13px",
              lineHeight: 1.45,
            }}
          >
            文件同步通道未就绪，请先等待当前 session 连接完成。
          </div>
        ) : null}

        <>
          <div style={sectionLabelStyle}>
            <span>🖥 远程: {truncateName(remotePath, 40)}</span>
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
                ...actionButtonStyle("transparent", mobileTheme.colors.accent),
                minHeight: "24px",
                padding: "0 6px",
                fontSize: "12px",
              }}
            >
              ← 上级
            </button>
            <span style={{ color: mobileTheme.colors.textMuted }}>
              {remotePath}
            </span>
          </div>
          <div
            style={{
              ...fileListContainerStyle,
              maxHeight: "28vh",
              flex: "none",
            }}
          >
            {remoteLoading ? (
              <div
                style={{
                  padding: "20px",
                  textAlign: "center",
                  color: mobileTheme.colors.textMuted,
                }}
              >
                加载中…
              </div>
            ) : visibleRemoteEntries.length === 0 ? (
              <div
                style={{
                  padding: "20px",
                  textAlign: "center",
                  color: mobileTheme.colors.textMuted,
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
                    } else if (previewRemoteMarkdown(entry)) {
                      return;
                    } else {
                      toggleRemote(entry.name);
                    }
                  }}
                >
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
                  <span style={{ fontSize: "16px", flexShrink: 0 }}>
                    {entry.type === "directory" ? "📁" : "📄"}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "13px",
                      color: mobileTheme.colors.textPrimary,
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
                        color: mobileTheme.colors.textMuted,
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
            style={{
              flexShrink: 0,
              maxHeight: avoidSide ? "32vh" : "24vh",
              margin: "6px 10px",
              borderRadius: "14px",
              border: `1px solid ${mobileTheme.colors.cardBorder}`,
              background: "rgba(10, 16, 26, 0.84)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "8px 10px",
                borderBottom: `1px solid ${mobileTheme.colors.cardBorder}`,
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 800,
                  color: mobileTheme.colors.textPrimary,
                }}
              >
                Markdown 预览：{truncateName(preview.fileName, 28)}
              </span>
              <button
                type="button"
                onClick={() => {
                  fileTransferRuntimeRef.current.clearPreview();
                  forceRuntimeTick((value) => value + 1);
                }}
                style={{
                  ...actionButtonStyle(
                    "transparent",
                    mobileTheme.colors.textSecondary,
                  ),
                  minHeight: "24px",
                  padding: "0 8px",
                  fontSize: "12px",
                }}
              >
                关闭
              </button>
            </div>
            <div
              style={{
                maxHeight: avoidSide ? "26vh" : "18vh",
                overflowY: "auto",
                padding: "10px 12px",
                color: mobileTheme.colors.textSecondary,
                fontSize: "13px",
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
              }}
            >
              {preview.loading
                ? "加载预览中…"
                : preview.error
                  ? `预览失败：${preview.error}`
                  : renderMarkdownPreview(preview.text || "")}
            </div>
          </div>
        ) : null}

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
                : mobileTheme.colors.shellMuted,
              direction === "download" ? mobileTheme.colors.accent : "#fff",
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
                : mobileTheme.colors.shellMuted,
              direction === "upload" ? mobileTheme.colors.accent : "#fff",
            )}
          >
            ⬆ 上传到远程
          </button>
        </div>

        {/* Local panel */}
        <div style={sectionLabelStyle}>
          <span>📱 本地: {truncateName(localPath, 40)}</span>
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
              ...actionButtonStyle("transparent", mobileTheme.colors.accent),
              minHeight: "24px",
              padding: "0 6px",
              fontSize: "12px",
            }}
          >
            ← 上级
          </button>
          <span style={{ color: mobileTheme.colors.textMuted }}>
            {localPath}
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
                color: mobileTheme.colors.textMuted,
              }}
            >
              加载中…
            </div>
          ) : localPermissionGranted === false ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: mobileTheme.colors.textMuted,
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
                color: mobileTheme.colors.textMuted,
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
                color: mobileTheme.colors.textMuted,
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
                  } else if (isMarkdownFileName(entry.name)) {
                    void previewLocalMarkdown(entry);
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
                    color: mobileTheme.colors.textPrimary,
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
                      color: mobileTheme.colors.textMuted,
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

        {/* Transfer progress */}
        {transfers.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              padding: "6px 0",
              borderTop: `1px solid ${mobileTheme.colors.cardBorder}`,
            }}
          >
            <div
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: mobileTheme.colors.textSecondary,
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
                        ? mobileTheme.colors.accent
                        : t.status === "error"
                          ? mobileTheme.colors.danger
                          : mobileTheme.colors.textMuted,
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

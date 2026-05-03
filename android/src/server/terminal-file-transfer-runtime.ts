import { createTerminalFileTransferBinaryRuntime } from './terminal-file-transfer-binary-runtime';
import { createTerminalFileTransferListRuntime } from './terminal-file-transfer-list-runtime';
import type {
  TerminalFileTransferRuntime,
  TerminalFileTransferRuntimeDeps,
} from './terminal-file-transfer-types';

export type { TerminalFileTransferRuntime, TerminalFileTransferRuntimeDeps } from './terminal-file-transfer-types';

export function createTerminalFileTransferRuntime(
  deps: TerminalFileTransferRuntimeDeps,
): TerminalFileTransferRuntime {
  const listRuntime = createTerminalFileTransferListRuntime(deps);
  const binaryRuntime = createTerminalFileTransferBinaryRuntime(deps);

  return {
    handlePasteImage: binaryRuntime.handlePasteImage,
    handleFileListRequest: listRuntime.handleFileListRequest,
    handleFileCreateDirectoryRequest: listRuntime.handleFileCreateDirectoryRequest,
    handleFileDownloadRequest: listRuntime.handleFileDownloadRequest,
    handleRemoteScreenshotRequest: listRuntime.handleRemoteScreenshotRequest,
    handleFileUploadStart: binaryRuntime.handleFileUploadStart,
    handleFileUploadChunk: binaryRuntime.handleFileUploadChunk,
    handleFileUploadEnd: binaryRuntime.handleFileUploadEnd,
    handleBinaryPayload: binaryRuntime.handleBinaryPayload,
  };
}

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
  const binaryRuntime = createTerminalFileTransferBinaryRuntime({
    ...deps,
    onFileUploadPersisted: (targetDir) => {
      deps.onFileUploadPersisted?.(targetDir);
      listRuntime.refreshDirectoryCache(targetDir);
    },
  });

  function rejectUnsupportedHerdrOperation(session: Parameters<typeof binaryRuntime.handlePasteImage>[0], operation: string) {
    if (session.backend !== 'herdr') {
      return false;
    }
    deps.sendMessage(session, {
      type: 'error',
      payload: {
        message: `${operation} is not supported by the Herdr single-session terminal surface`,
        code: 'herdr_file_transfer_unsupported',
      },
    });
    return true;
  }

  return {
    handlePasteImage: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'paste image')) binaryRuntime.handlePasteImage(session, payload);
    },
    handlePasteImageFromUpload: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'paste image')) binaryRuntime.handlePasteImageFromUpload(session, payload);
    },
    handleFileListRequest: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'file listing')) listRuntime.handleFileListRequest(session, payload);
    },
    handleFileCreateDirectoryRequest: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'directory creation')) listRuntime.handleFileCreateDirectoryRequest(session, payload);
    },
    handleFileDownloadRequest: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'file download')) listRuntime.handleFileDownloadRequest(session, payload);
    },
    handleRemoteScreenshotRequest: async (session, payload) => {
      if (rejectUnsupportedHerdrOperation(session, 'remote screenshot')) return;
      await listRuntime.handleRemoteScreenshotRequest(session, payload);
    },
    handleFileUploadStart: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'file upload')) binaryRuntime.handleFileUploadStart(session, payload);
    },
    handleFileUploadChunk: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'file upload')) binaryRuntime.handleFileUploadChunk(session, payload);
    },
    handleFileUploadEnd: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'file upload')) binaryRuntime.handleFileUploadEnd(session, payload);
    },
    handleBinaryPayload: (session, payload) => {
      if (!rejectUnsupportedHerdrOperation(session, 'binary file transfer')) binaryRuntime.handleBinaryPayload(session, payload);
    },
    dispose: listRuntime.dispose,
  };
}

import * as React from "react";
import { Directory, Filesystem } from "@capacitor/filesystem";
import {
  createRemoteScreenshotPreviewRuntime,
  persistRemoteScreenshotCaptureRuntime,
  type RemoteScreenshotPreviewState,
} from "../lib/remote-screenshot-preview-runtime";
import type {
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
} from "../lib/types";

export interface ScheduleComposerSeed {
  nonce: number;
  text: string;
}

export interface UseTerminalPageOverlaysOptions {
  uiSessionId: string | null;
  onRequestRemoteScreenshot?: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => Promise<RemoteScreenshotCapture>;
  onRequestScheduleList?: (sessionId: string) => void;
}

export interface UseTerminalPageOverlaysResult {
  tabManagerOpen: boolean;
  setTabManagerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  tabManagerScopePaneId: string | null;
  setTabManagerScopePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  scheduleOpen: boolean;
  setScheduleOpen: React.Dispatch<React.SetStateAction<boolean>>;
  fileTransferOpen: boolean;
  setFileTransferOpen: React.Dispatch<React.SetStateAction<boolean>>;
  fileTransferMode: "browser" | "sync";
  bumpFileTransferEntryOpenNonce: () => void;
  remoteScreenshotPreview: RemoteScreenshotPreviewState | null;
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: React.Dispatch<React.SetStateAction<boolean>>;
  absoluteLineNumbersVisible: boolean;
  setAbsoluteLineNumbersVisible: React.Dispatch<React.SetStateAction<boolean>>;
  debugOverlayPos: { x: number; y: number };
  setDebugOverlayPos: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  scheduleComposerSeed: ScheduleComposerSeed;
  setScheduleComposerSeed: React.Dispatch<React.SetStateAction<ScheduleComposerSeed>>;
  handleQuickBarOpenScheduleComposer: (text: string) => void;
  handleQuickBarOpenFileTransfer: (mode?: "browser" | "sync") => void;
  handleQuickBarToggleDebugOverlay: () => void;
  handleQuickBarToggleAbsoluteLineNumbers: () => void;
  handleQuickBarRequestRemoteScreenshot: () => void;
  closeRemoteScreenshotPreview: () => void;
  handleSaveRemoteScreenshot: () => Promise<void>;
}

export function useTerminalPageOverlays({
  uiSessionId,
  onRequestRemoteScreenshot,
  onRequestScheduleList,
}: UseTerminalPageOverlaysOptions): UseTerminalPageOverlaysResult {
  const [tabManagerOpen, setTabManagerOpen] = React.useState(false);
  const [tabManagerScopePaneId, setTabManagerScopePaneId] = React.useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [fileTransferOpen, setFileTransferOpen] = React.useState(false);
  const [fileTransferMode, setFileTransferMode] = React.useState<"browser" | "sync">("browser");
  const [, setFileTransferEntryOpenNonce] = React.useState(0);
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] =
    React.useState<RemoteScreenshotPreviewState | null>(null);
  const [scheduleComposerSeed, setScheduleComposerSeed] =
    React.useState<ScheduleComposerSeed>({ nonce: 0, text: "" });
  const [debugOverlayVisible, setDebugOverlayVisible] = React.useState(false);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = React.useState(false);
  const [debugOverlayPos, setDebugOverlayPos] = React.useState({ x: -1, y: -1 });
  const remoteScreenshotPreviewRuntimeRef = React.useRef(
    createRemoteScreenshotPreviewRuntime(),
  );

  const closeRemoteScreenshotPreview = React.useCallback(() => {
    setRemoteScreenshotPreview(
      remoteScreenshotPreviewRuntimeRef.current.closePreview(),
    );
  }, []);

  React.useEffect(
    () => () => {
      remoteScreenshotPreviewRuntimeRef.current.dispose();
    },
    [],
  );

  const handleRequestRemoteScreenshot = React.useCallback(async () => {
    const targetSessionId = uiSessionId;
    if (!targetSessionId || !onRequestRemoteScreenshot) {
      alert("当前没有可用的目标 session");
      return;
    }

    const started = remoteScreenshotPreviewRuntimeRef.current.beginRequest();
    const requestEpoch = started.requestEpoch;
    setRemoteScreenshotPreview(started.state);

    try {
      const capture = await onRequestRemoteScreenshot(targetSessionId, (progress) => {
        setRemoteScreenshotPreview((current) =>
          remoteScreenshotPreviewRuntimeRef.current.applyProgress(
            current,
            requestEpoch,
            progress,
          ),
        );
      });

      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) =>
        remoteScreenshotPreviewRuntimeRef.current.markTransferComplete(
          current,
          requestEpoch,
          capture,
        ),
      );
      setRemoteScreenshotPreview((current) =>
        remoteScreenshotPreviewRuntimeRef.current.completeCapture(
          current,
          requestEpoch,
          capture,
        ),
      );
    } catch (error) {
      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) =>
        remoteScreenshotPreviewRuntimeRef.current.failCapture(
          current,
          requestEpoch,
          error,
        ),
      );
    }
  }, [onRequestRemoteScreenshot, uiSessionId]);

  const handleQuickBarOpenScheduleComposer = React.useCallback(
    (text: string) => {
      const targetSessionId = uiSessionId;
      if (!targetSessionId) {
        return;
      }
      onRequestScheduleList?.(targetSessionId);
      setScheduleComposerSeed({ nonce: Date.now(), text });
      setScheduleOpen(true);
    },
    [onRequestScheduleList, uiSessionId],
  );

  const handleQuickBarOpenFileTransfer = React.useCallback((mode: "browser" | "sync" = "browser") => {
    setFileTransferEntryOpenNonce((value) => value + 1);
    setFileTransferMode(mode);
    setFileTransferOpen((current) => (current && fileTransferMode === mode ? false : true));
  }, [fileTransferMode]);

  const bumpFileTransferEntryOpenNonce = React.useCallback(() => {
    setFileTransferEntryOpenNonce((value) => value + 1);
  }, []);

  const handleQuickBarToggleDebugOverlay = React.useCallback(() => {
    setDebugOverlayVisible((v) => !v);
  }, []);

  const handleQuickBarToggleAbsoluteLineNumbers = React.useCallback(() => {
    setAbsoluteLineNumbersVisible((v) => !v);
  }, []);

  const handleQuickBarRequestRemoteScreenshot = React.useCallback(() => {
    void handleRequestRemoteScreenshot();
  }, [handleRequestRemoteScreenshot]);

  const handleSaveRemoteScreenshot = React.useCallback(async () => {
    if (
      !remoteScreenshotPreview?.previewDataUrl ||
      !remoteScreenshotPreview.rawDataBase64 ||
      remoteScreenshotPreview.phase !== "preview-ready"
    ) {
      return;
    }

    setRemoteScreenshotPreview((current) =>
      remoteScreenshotPreviewRuntimeRef.current.beginSave(current),
    );
    try {
      const savedPath = await persistRemoteScreenshotCaptureRuntime({
        fileName: remoteScreenshotPreview.fileName,
        dataBase64: remoteScreenshotPreview.rawDataBase64,
        directory: Directory.ExternalStorage,
        mkdir: Filesystem.mkdir,
        writeFile: Filesystem.writeFile,
      });
      closeRemoteScreenshotPreview();
      alert(`截图已保存到 ${savedPath}`);
    } catch (error) {
      setRemoteScreenshotPreview((current) =>
        remoteScreenshotPreviewRuntimeRef.current.restorePreviewReady(current),
      );
      alert(error instanceof Error ? error.message : "保存远程截图失败");
    }
  }, [closeRemoteScreenshotPreview, remoteScreenshotPreview]);

  return {
    tabManagerOpen,
    setTabManagerOpen,
    tabManagerScopePaneId,
    setTabManagerScopePaneId,
    scheduleOpen,
    setScheduleOpen,
    fileTransferOpen,
    setFileTransferOpen,
    fileTransferMode,
    bumpFileTransferEntryOpenNonce,
    remoteScreenshotPreview,
    debugOverlayVisible,
    setDebugOverlayVisible,
    absoluteLineNumbersVisible,
    setAbsoluteLineNumbersVisible,
    debugOverlayPos,
    setDebugOverlayPos,
    scheduleComposerSeed,
    setScheduleComposerSeed,
    handleQuickBarOpenScheduleComposer,
    handleQuickBarOpenFileTransfer,
    handleQuickBarToggleDebugOverlay,
    handleQuickBarToggleAbsoluteLineNumbers,
    handleQuickBarRequestRemoteScreenshot,
    closeRemoteScreenshotPreview,
    handleSaveRemoteScreenshot,
  };
}

import { useCallback, useMemo, useState } from 'react';
import type { RemoteWindowScreenshotSaveResult } from './useRemoteWindowThumbnails';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

export type RemoteWindowScreenshotStatus =
  | { phase: 'idle' }
  | { phase: 'capturing' }
  | { phase: 'saved'; fileName: string; savedPath: string }
  | { phase: 'failed'; message: string };

export type RemoteWindowScreenshotFeedbackTone = 'progress' | 'success' | 'error';

export interface RemoteWindowScreenshotFeedback {
  phase: 'capturing' | 'saved' | 'failed';
  title: string;
  detail: string;
  tone: RemoteWindowScreenshotFeedbackTone;
}

export interface UseRemoteWindowScreenshotOptions {
  activeSessionId: string | null | undefined;
  requestScreenshot?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    options?: { persist?: boolean },
  ) => Promise<RemoteWindowScreenshotSaveResult>;
}

export interface UseRemoteWindowScreenshotResult {
  status: RemoteWindowScreenshotStatus;
  busy: boolean;
  feedback: RemoteWindowScreenshotFeedback | null;
  capture: (target: RemoteWindowStreamTargetManifest) => Promise<void>;
  reset: () => void;
}

const SCREENSHOT_TITLE_BY_PHASE: Record<RemoteWindowScreenshotFeedback['phase'], string> = {
  capturing: '远程原始截屏中',
  saved: '原始截图已保存',
  failed: '截屏失败',
};

const SCREENSHOT_DETAIL_PROGRESS = '正在从目标窗口获取 PNG';

export function useRemoteWindowScreenshot({
  activeSessionId,
  requestScreenshot,
}: UseRemoteWindowScreenshotOptions): UseRemoteWindowScreenshotResult {
  const [status, setStatus] = useState<RemoteWindowScreenshotStatus>({ phase: 'idle' });

  const reset = useCallback(() => {
    setStatus({ phase: 'idle' });
  }, []);

  const capture = useCallback(async (target: RemoteWindowStreamTargetManifest) => {
    const sessionId = activeSessionId?.trim() || '';
    if (!sessionId || !requestScreenshot) {
      setStatus({ phase: 'failed', message: '当前没有可用的截图通道' });
      return;
    }
    setStatus({ phase: 'capturing' });
    try {
      const result = await requestScreenshot(sessionId, target, { persist: true });
      setStatus({
        phase: 'saved',
        fileName: result.fileName,
        savedPath: result.savedPath,
      });
    } catch (error) {
      setStatus({
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeSessionId, requestScreenshot]);

  const feedback = useMemo<RemoteWindowScreenshotFeedback | null>(() => {
    switch (status.phase) {
      case 'capturing':
        return {
          phase: 'capturing',
          title: SCREENSHOT_TITLE_BY_PHASE.capturing,
          detail: SCREENSHOT_DETAIL_PROGRESS,
          tone: 'progress',
        };
      case 'saved':
        return {
          phase: 'saved',
          title: SCREENSHOT_TITLE_BY_PHASE.saved,
          detail: status.fileName,
          tone: 'success',
        };
      case 'failed':
        return {
          phase: 'failed',
          title: SCREENSHOT_TITLE_BY_PHASE.failed,
          detail: status.message,
          tone: 'error',
        };
      case 'idle':
      default:
        return null;
    }
  }, [status]);

  return {
    status,
    busy: status.phase === 'capturing',
    feedback,
    capture,
    reset,
  };
}

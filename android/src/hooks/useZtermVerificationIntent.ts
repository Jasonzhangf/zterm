import { useEffect, useRef } from 'react';
import { peekZtermVerificationDownload } from '../lib/zterm-verification-queue';

export interface ZtermVerificationIntentHost {
  onOpenSession(targetKey: string, channelId: string, sessionName: string): void;
}

export function useZtermVerificationIntent(host: ZtermVerificationIntentHost): void {
  const onOpenSessionRef = useRef(host.onOpenSession);
  onOpenSessionRef.current = host.onOpenSession;

  useEffect(() => {
    let pending = false;
    const flush = () => {
      if (!pending) return;
      pending = false;
      const target = peekZtermVerificationDownload();
      if (!target?.fileName) return;
      window.dispatchEvent(new CustomEvent('zterm:open-file-transfer', {
        detail: { mode: 'browser', remoteCwd: target.remotePath || '/tmp' },
      }));
    };
    const handleTerminalPageVisible = () => flush();
    const handleOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        targetKey?: string;
        channelId?: string;
        sessionName?: string;
      }>).detail;
      if (!detail?.targetKey || !detail?.sessionName) return;
      pending = true;
      onOpenSessionRef.current(detail.targetKey, detail.channelId || 'verification', detail.sessionName);
    };
    window.addEventListener('zterm:terminal-page-visible', handleTerminalPageVisible);
    window.addEventListener('zterm:verification-open-request', handleOpenRequest);
    return () => {
      window.removeEventListener('zterm:terminal-page-visible', handleTerminalPageVisible);
      window.removeEventListener('zterm:verification-open-request', handleOpenRequest);
    };
  }, []);
}

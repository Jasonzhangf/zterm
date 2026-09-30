import { useEffect } from 'react';
import { claimZtermVerificationDownload } from '../lib/zterm-verification-queue';

export function useZtermVerificationIntent(): void {
  useEffect(() => {
    const flush = () => {
      const target = claimZtermVerificationDownload();
      if (!target?.fileName) return;
      window.dispatchEvent(new CustomEvent('zterm:open-file-transfer', {
        detail: { mode: 'browser', remoteCwd: target.remotePath || '/tmp' },
      }));
      window.dispatchEvent(new CustomEvent('zterm:file-transfer-download', {
        detail: {
          remotePath: target.remotePath,
          fileName: target.fileName,
          size: target.size,
        },
      }));
    };
    const handleTerminalPageVisible = () => flush();
    window.addEventListener('zterm:terminal-page-visible', handleTerminalPageVisible);
    return () => {
      window.removeEventListener('zterm:terminal-page-visible', handleTerminalPageVisible);
    };
  }, []);
}

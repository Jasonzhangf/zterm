import { useEffect } from 'react';
import {
  onZtermVerificationDownload,
  peekZtermVerificationDownload,
  type ZtermVerificationDownloadTarget,
} from '../lib/zterm-verification-queue';

export function useZtermVerificationIntent(
  onIntent: (target: ZtermVerificationDownloadTarget) => void,
): void {
  useEffect(() => {
    const handleIntent = (target: ZtermVerificationDownloadTarget | null) => {
      if (!target?.fileName) return;
      onIntent(target);
    };

    handleIntent(peekZtermVerificationDownload());
    return onZtermVerificationDownload(handleIntent);
  }, [onIntent]);
}

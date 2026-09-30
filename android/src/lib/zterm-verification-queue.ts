export interface ZtermVerificationDownloadTarget {
  remotePath: string;
  fileName: string;
  size?: number;
}

let pendingDownloadTarget: ZtermVerificationDownloadTarget | null = null;
const downloadListeners = new Set<(target: ZtermVerificationDownloadTarget) => void>();

export function setZtermVerificationDownload(target: ZtermVerificationDownloadTarget | null): void {
  pendingDownloadTarget = target;
  if (target?.fileName) {
    for (const listener of downloadListeners) {
      listener(target);
    }
  }
}

export function onZtermVerificationDownload(listener: (target: ZtermVerificationDownloadTarget) => void): () => void {
  downloadListeners.add(listener);
  return () => {
    downloadListeners.delete(listener);
  };
}

export function claimZtermVerificationDownload(): ZtermVerificationDownloadTarget | null {
  const target = pendingDownloadTarget;
  pendingDownloadTarget = null;
  return target;
}

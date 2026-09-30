export interface ZtermVerificationDownloadTarget {
  remotePath: string;
  fileName: string;
  size?: number;
}

let pendingDownloadTarget: ZtermVerificationDownloadTarget | null = null;

export function setZtermVerificationDownload(target: ZtermVerificationDownloadTarget | null): void {
  pendingDownloadTarget = target;
}

export function claimZtermVerificationDownload(): ZtermVerificationDownloadTarget | null {
  const target = pendingDownloadTarget;
  pendingDownloadTarget = null;
  return target;
}

export interface BrowserStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export function getBrowserStorage(): BrowserStorageLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = window.localStorage as Partial<BrowserStorageLike> | undefined;
  if (
    !candidate
    || typeof candidate.getItem !== 'function'
    || typeof candidate.setItem !== 'function'
    || typeof candidate.removeItem !== 'function'
  ) {
    return null;
  }
  return candidate as BrowserStorageLike;
}

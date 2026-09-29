export interface ZtermVerificationDownloadLink {
  remotePath: string;
  fileName: string;
  size?: number;
}

export function parseZtermVerificationDownloadLink(rawUrl: string): ZtermVerificationDownloadLink {
  const url = new URL(rawUrl);
  const params = url.searchParams;
  const pathParts = parseSlashParts(url);
  const remotePath = decodeURIComponent(params.get('p') || hashParam(url, 'p') || pathParts?.remotePath || '/tmp');
  const fileName = decodeURIComponent(params.get('f') || hashParam(url, 'f') || pathParts?.fileName || '');
  const sizeRaw = params.get('s') || hashParam(url, 's') || pathParts?.size || '';
  const size = /^[0-9]+$/.test(sizeRaw) ? Number.parseInt(sizeRaw, 10) : undefined;

  return {
    remotePath,
    fileName,
    size,
  };
}

function parseSlashParts(url: URL): { remotePath: string; fileName: string; size: string } | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'p' || parts.length < 3) {
    return null;
  }
  return {
    remotePath: `/${parts[1] || ''}`,
    fileName: parts.slice(2, -1).join('/'),
    size: parts.at(-1) || '',
  };
}

function hashParam(url: URL, key: string): string | null {
  const hash = url.hash;
  if (!hash.startsWith('#')) {
    return null;
  }
  return new URLSearchParams(hash.slice(1)).get(key);
}

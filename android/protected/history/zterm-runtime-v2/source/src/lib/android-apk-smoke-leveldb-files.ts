function safeShellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildApkSmokeLevelDbListArgs(appId: string, levelDbDir: string) {
  return [
    'exec-out',
    'run-as',
    appId,
    'sh',
    '-lc',
    `cd ${safeShellSingleQuote(levelDbDir)} && ls -1`,
  ];
}

export function parseApkSmokeLevelDbFileList(rawListing: string) {
  return rawListing
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}


function normalizeListingLine(line: string) {
  return line.trim().replace(/\/+$/, '');
}

export function resolveApkSmokeWebViewLevelDbDirFromRunAsListing(listing: string) {
  const lines = listing
    .split(/\r?\n/g)
    .map(normalizeListingLine)
    .filter(Boolean);

  const exactDefaultProfile = lines.find((line) => line === './app_webview/Default/Local Storage/leveldb');
  if (exactDefaultProfile) {
    return exactDefaultProfile;
  }

  const exactAppWebView = lines.find((line) => line === './app_webview/Local Storage/leveldb');
  if (exactAppWebView) {
    return exactAppWebView;
  }

  const discoveredLevelDb = lines.find((line) => /(?:^|\/)Local Storage\/leveldb$/u.test(line));
  return discoveredLevelDb || null;
}

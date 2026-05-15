import type { ApkSmokeDebugSnapshotRecord, ApkSmokeRuntimeSnapshot } from './android-apk-smoke-runtime-verifier';

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function selectFreshApkSmokeSnapshotRecord(
  snapshot: ApkSmokeRuntimeSnapshot,
  minimumUpdatedAt: string,
): ApkSmokeDebugSnapshotRecord | null {
  const records = Array.isArray(snapshot.clientDebugSnapshots) ? snapshot.clientDebugSnapshots : [];
  return records
    .filter((record) => asString(record.updatedAt) >= minimumUpdatedAt)
    .sort((left, right) => asString(right.updatedAt).localeCompare(asString(left.updatedAt)))[0] || null;
}

export function resolveApkSmokeSnapshotActiveSessionId(record: ApkSmokeDebugSnapshotRecord | null) {
  const snapshotPayload = asRecord(record?.snapshot);
  const sources = asRecord(snapshotPayload?.sources);
  const appShell = asRecord(sources?.['app-shell']);
  const terminalPage = asRecord(sources?.['terminal-page']);
  const candidates = [
    terminalPage?.activeSessionId,
    appShell?.terminalActiveSessionId,
    appShell?.activeRuntimeSessionId,
    record?.sessionId,
  ];
  for (const candidate of candidates) {
    const normalized = asString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function resolveApkSmokeSnapshotDaemonSessionId(record: ApkSmokeDebugSnapshotRecord | null) {
  return asString(record?.sessionId) || null;
}

export function resolveApkSmokeSnapshotTmuxSessionName(record: ApkSmokeDebugSnapshotRecord | null) {
  return asString(record?.tmuxSessionName) || null;
}

export function filterApkSmokeRuntimeSnapshot(
  snapshot: ApkSmokeRuntimeSnapshot,
  minimumUpdatedAt: string,
): ApkSmokeRuntimeSnapshot {
  const records = Array.isArray(snapshot.clientDebugSnapshots) ? snapshot.clientDebugSnapshots : [];
  return {
    ...snapshot,
    clientDebugSnapshots: records.filter((record) => asString(record.updatedAt) >= minimumUpdatedAt),
  };
}

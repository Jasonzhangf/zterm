import type { SessionDebugOverlayMetrics, Session } from "../lib/types";

function formatDebugRate(bytesPerSecond: number): string {
  const safeValue = Math.max(
    0,
    Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0,
  );
  if (safeValue >= 1024 * 1024) {
    return `${(safeValue / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  if (safeValue >= 1024) {
    return `${(safeValue / 1024).toFixed(1)} KB/s`;
  }
  return `${Math.round(safeValue)} B/s`;
}

function formatDebugHz(value: number): string {
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  return `${safeValue.toFixed(1)} Hz`;
}

function resolveDebugStatus(
  session: Session | null,
  metrics?: SessionDebugOverlayMetrics,
): SessionDebugOverlayMetrics["status"] {
  if (metrics?.status) {
    return metrics.status;
  }
  if (!session) {
    return "waiting";
  }
  switch (session.state) {
    case "error":
      return "error";
    case "disconnected":
    case "closed":
      return "closed";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return "connecting";
    default:
      return "waiting";
  }
}

export { formatDebugRate, formatDebugHz, resolveDebugStatus };

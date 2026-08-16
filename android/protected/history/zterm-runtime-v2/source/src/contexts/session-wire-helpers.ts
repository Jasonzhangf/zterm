import type { Host, HostConfigMessage } from '../lib/types';

export function buildHostConfigMessage(
  host: Host,
  sessionName: string,
  openRequestId: string,
  sessionTransportToken?: string | null,
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null,
): HostConfigMessage {
  const adaptiveCols = Number.isFinite(geometry?.cols) ? Math.max(1, Math.floor(geometry?.cols || 0)) : undefined;
  const widthMode = geometry?.widthMode === 'adaptive-phone' && adaptiveCols
    ? 'adaptive-phone'
    : 'mirror-fixed';
  return {
    openRequestId,
    sessionTransportToken: sessionTransportToken?.trim() || undefined,
    sessionName,
    cols: widthMode === 'adaptive-phone' ? adaptiveCols : undefined,
    rows: undefined,
    widthMode,
    autoCommand: host.autoCommand,
  };
}

import type { Host, HostConfigMessage } from '../lib/types';
import { buildHostConfigMessage } from './session-wire-helpers';

export function buildSessionOpenPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  openRequestId: string;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.openRequestId,
    undefined,
    options.geometry,
  );
}

export function buildSessionResizePayload(options: {
  cols?: number | null;
  rows?: number | null;
  widthMode?: 'adaptive-phone' | 'mirror-fixed';
}) {
  const adaptiveCols = Number.isFinite(options.cols) ? Math.max(1, Math.floor(options.cols || 0)) : undefined;
  const widthMode = options.widthMode === 'adaptive-phone' && adaptiveCols
    ? 'adaptive-phone'
    : 'mirror-fixed';
  return {
    cols: widthMode === 'adaptive-phone' ? adaptiveCols : undefined,
    rows: undefined,
    widthMode,
  };
}

export function buildSessionConnectPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  openRequestId: string;
  sessionTransportToken?: string | null;
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.openRequestId,
    options.sessionTransportToken,
    options.geometry,
  );
}

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
  return {
    cols: Number.isFinite(options.cols) ? Math.max(1, Math.floor(options.cols || 0)) : undefined,
    rows: Number.isFinite(options.rows) ? Math.max(1, Math.floor(options.rows || 0)) : undefined,
    widthMode: options.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed',
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

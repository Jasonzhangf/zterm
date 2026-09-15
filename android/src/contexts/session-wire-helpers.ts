import type { Host, HostConfigMessage } from '../lib/types';

export type TerminalGeometryIntent = {
  cols?: number | null;
  rows?: number | null;
  widthMode?: 'adaptive-phone' | 'mirror-fixed';
};

/**
 * Builds the body-subscription message. Foreground subscriptions carry the
 * current requested geometry so a daemon-side false->true reattach can restore
 * the adaptive-phone width lease instead of falling back to mirror-fixed.
 * `mirror-fixed` and unsubscribed messages stay geometry-free.
 */
export function buildBodySubscriptionMessage(options: {
  subscribed: boolean;
  geometry?: TerminalGeometryIntent | null;
}) {
  const geometry = options.geometry || null;
  const adaptiveCols = Number.isFinite(geometry?.cols)
    ? Math.max(1, Math.floor(geometry?.cols || 0))
    : undefined;
  const adaptiveRows = Number.isFinite(geometry?.rows)
    ? Math.max(1, Math.floor(geometry?.rows || 0))
    : undefined;
  const adaptive = options.subscribed
    && geometry?.widthMode === 'adaptive-phone'
    && Boolean(adaptiveCols);
  return {
    type: 'body-subscription' as const,
    payload: {
      version: 1 as const,
      subscribed: options.subscribed,
      ...(adaptive
        ? {
            cols: adaptiveCols,
            ...(adaptiveRows ? { rows: adaptiveRows } : {}),
            widthMode: 'adaptive-phone' as const,
          }
        : {}),
    },
  };
}

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

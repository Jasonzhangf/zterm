import type { Host, HostConfigMessage } from '../lib/types';
import { buildHostConfigMessage } from './session-sync-helpers';

export function buildSessionOpenPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  openRequestId: string;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.openRequestId,
  );
}

export function buildSessionConnectPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  openRequestId: string;
  sessionTransportToken?: string | null;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.openRequestId,
    options.sessionTransportToken,
  );
}

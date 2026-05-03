import type { Host, HostConfigMessage, TerminalWidthMode } from '../lib/types';
import { buildHostConfigMessage } from './session-sync-helpers';

export function buildSessionOpenPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  terminalWidthMode: TerminalWidthMode;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.sessionId,
    options.terminalWidthMode,
  );
}

export function buildSessionConnectPayload(options: {
  host: Host;
  resolvedSessionName: string;
  sessionId: string;
  terminalWidthMode: TerminalWidthMode;
  sessionTransportToken?: string | null;
}): HostConfigMessage {
  return buildHostConfigMessage(
    options.host,
    options.resolvedSessionName,
    options.sessionId,
    options.terminalWidthMode,
    options.sessionTransportToken,
  );
}

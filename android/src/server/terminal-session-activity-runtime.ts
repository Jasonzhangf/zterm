import {
  buildTerminalMuxServerTargetMessage,
  type SessionActivity,
  type TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  SessionMirror,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';

export const SESSION_IDLE_STOPPED_THRESHOLD_MS = 60_000;

export function classifySessionActivities(
  mirrors: ReadonlyMap<string, SessionMirror>,
  now: number,
  thresholdMs = SESSION_IDLE_STOPPED_THRESHOLD_MS,
): SessionActivity[] {
  return Array.from(mirrors.values())
    .filter((mirror) => mirror.lastLiveActivityAt > 0)
    .map((mirror) => ({
      name: mirror.sessionName,
      lastLiveActivityAt: mirror.lastLiveActivityAt,
      stopped: now - mirror.lastLiveActivityAt >= thresholdMs,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function publishSessionActivitiesRuntime(options: {
  connection: TerminalTransportConnection;
  mirrors: ReadonlyMap<string, SessionMirror>;
  now: number;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
}) {
  const message = {
    type: 'session-activity' as const,
    payload: {
      activities: classifySessionActivities(options.mirrors, options.now),
    },
  };
  const transportMessage = typeof options.connection.muxVersion === 'number'
    ? buildTerminalMuxServerTargetMessage(message)
    : message;
  options.sendTransportMessage(options.connection.transport, transportMessage);
}

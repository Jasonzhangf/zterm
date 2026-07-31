import type { SessionActivity } from '@zterm/shared/protocol';
import type { SessionMirror } from './terminal-runtime-types';

export const SESSION_IDLE_STOPPED_THRESHOLD_MS = 10_000;

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

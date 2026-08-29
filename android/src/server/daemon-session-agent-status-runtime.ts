import type {
  TerminalSessionAgentStatus,
  TerminalSessionObservation,
  TerminalSessionObservationStatusReason,
} from '@zterm/shared/protocol';

export interface DaemonProcessGroupObservation { groupId: string; alive: boolean }
export interface DaemonSessionObservationHistoryEntry {
  processName?: string; processId?: string; processGroupId: string;
  firstSeenAt: number; lastFingerprint: string;
  candidateStatus: TerminalSessionAgentStatus; candidateSince: number;
  idleConfirmations: number; lastPublishedAt?: number;
}
export interface DaemonSessionObservationDeps {
  runTmux: (args: string[]) => { ok: true; stdout: string } | { ok: false; error: string };
  readProcessGroup?: (pid: string) => DaemonProcessGroupObservation | undefined;
  history?: Map<string, DaemonSessionObservationHistoryEntry>;
}
interface DaemonSessionAgentManifestEntry {
  process: RegExp; runningMarkers: readonly RegExp[]; idleMarkers: readonly RegExp[];
}

// zterm-owned and reviewable; this is not Herdr runtime data.
const DAEMON_SESSION_AGENT_MANIFEST: readonly DaemonSessionAgentManifestEntry[] = [{
  process: /^(?:codex|claude|opencode)$/iu,
  runningMarkers: [/(?<![\p{L}\p{N}_])(?:thinking|working|generating)(?![\p{L}\p{N}_])/iu, /\x1b\]9;4;1(?:;|\x07|\x1b\\)/u],
  idleMarkers: [/(?<![\p{L}\p{N}_])(?:ready|waiting|idle|completed|done)(?![\p{L}\p{N}_])/iu, /\x1b\]9;4;0(?:;|\x07|\x1b\\)/u],
}];
const STARTUP_GRACE_MS = 3_000;
const IDLE_CONFIRMATION_CAP_MS = 700;
const IDLE_CONFIRMATIONS_REQUIRED = 3;
const STABLE_VISIBLE_SIGNAL_REFRESH_MS = 800;
const MAX_HISTORY_ENTRIES = 128;

function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${value.length}:${hash >>> 0}`;
}
function remember(history: DaemonSessionObservationDeps['history'], key: string, entry: DaemonSessionObservationHistoryEntry) {
  if (!history) return;
  history.set(key, entry);
  while (history.size > MAX_HISTORY_ENTRIES) {
    const oldest = history.keys().next().value;
    if (typeof oldest !== 'string') break;
    history.delete(oldest);
  }
}
function classify(processName: string | undefined, processId: string | undefined, group: DaemonProcessGroupObservation | undefined, output: string, observedAt: number, sessionName: string, history: DaemonSessionObservationDeps['history']): { status: TerminalSessionAgentStatus; statusReason: TerminalSessionObservationStatusReason; stableRefreshDue?: boolean } {
  if (!group || !group.alive) { history?.delete(sessionName); return { status: 'unknown', statusReason: 'insufficient-evidence' }; }
  const manifest = DAEMON_SESSION_AGENT_MANIFEST.find((entry) => entry.process.test(processName ?? ''));
  if (!manifest) { history?.delete(sessionName); return { status: 'unknown', statusReason: 'insufficient-evidence' }; }
  const hasRunning = manifest.runningMarkers.some((marker) => marker.test(output));
  const hasIdle = manifest.idleMarkers.some((marker) => marker.test(output));
  const candidate: TerminalSessionAgentStatus = hasRunning === hasIdle ? 'unknown' : hasRunning ? 'running' : 'idle';
  const prior = history?.get(sessionName);
  const sameProcess = prior?.processName === processName && prior?.processId === processId && prior?.processGroupId === group.groupId;
  const sameCandidate = prior?.candidateStatus === candidate;
  const sameFingerprint = prior?.lastFingerprint === fingerprint(output);
  if (candidate === 'unknown' || !sameProcess || !sameCandidate || (candidate === 'idle' && !sameFingerprint)) {
    remember(history, sessionName, { processName, processId, processGroupId: group.groupId, firstSeenAt: sameProcess ? (prior?.firstSeenAt ?? observedAt) : observedAt, lastFingerprint: fingerprint(output), candidateStatus: candidate, candidateSince: observedAt, idleConfirmations: 0 });
    return { status: 'unknown', statusReason: 'insufficient-evidence' };
  }
  if (candidate === 'idle' && prior && observedAt - prior.candidateSince > IDLE_CONFIRMATION_CAP_MS) {
    remember(history, sessionName, { ...prior, candidateSince: observedAt, idleConfirmations: 0 });
    return { status: 'unknown', statusReason: 'insufficient-evidence' };
  }
  const next = { ...prior!, processName, processId, processGroupId: group.groupId, lastFingerprint: fingerprint(output), idleConfirmations: candidate === 'idle' ? prior!.idleConfirmations + 1 : prior!.idleConfirmations };
  remember(history, sessionName, next);
  if (observedAt - next.firstSeenAt < STARTUP_GRACE_MS || (candidate === 'idle' && (observedAt - next.candidateSince > IDLE_CONFIRMATION_CAP_MS || next.idleConfirmations < IDLE_CONFIRMATIONS_REQUIRED))) return { status: 'unknown', statusReason: 'insufficient-evidence' };
  const stableRefreshDue = next.lastPublishedAt === undefined
    || observedAt - next.lastPublishedAt >= STABLE_VISIBLE_SIGNAL_REFRESH_MS;
  next.lastPublishedAt = observedAt;
  return { status: candidate, statusReason: 'evidence-confirmed', stableRefreshDue };
}

export function readDaemonSessionObservation(deps: DaemonSessionObservationDeps, sessionName: string, observedAt: number): TerminalSessionObservation {
  const paneResult = deps.runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_pid}\t#{pane_current_command}']);
  if (!paneResult.ok) { deps.history?.delete(sessionName); return { observedAt, recentOutput: false, oscTitleSeen: false, oscProgressSeen: false, status: 'error', statusReason: 'observation-error' }; }
  const pane = paneResult.stdout.trim().split('\t');
  const processId = pane[0]?.trim() || undefined;
  const foregroundProcess = pane[1]?.trim() || undefined;
  const processGroup = processId ? deps.readProcessGroup?.(processId) : undefined;
  const outputResult = deps.runTmux(['capture-pane', '-p', '-e', '-t', sessionName, '-S', '-20']);
  if (!outputResult.ok) { deps.history?.delete(sessionName); return { observedAt, ...(foregroundProcess ? { foregroundProcess } : {}), ...(processGroup ? { processGroupAlive: processGroup.alive } : {}), recentOutput: false, oscTitleSeen: false, oscProgressSeen: false, status: 'error', statusReason: 'observation-error' }; }
  const output = outputResult.stdout;
  const status = classify(foregroundProcess?.replace(/\.exe$/iu, '').trim(), processId, processGroup, output, observedAt, sessionName, deps.history);
  return { observedAt, ...(foregroundProcess ? { foregroundProcess } : {}), ...(processGroup ? { processGroupAlive: processGroup.alive } : {}), recentOutput: output.trim().length > 0, oscTitleSeen: /\x1b\]0;|\x1b\]2;/u.test(output), oscProgressSeen: /\x1b\]9;|\x1b\]133;/u.test(output), ...status };
}

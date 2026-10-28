// Drawer visibility truth. Classify only from the daemon-owned Collab
// projection; the client never infers a role from a session name.
import type { TerminalSessionCollabProjection } from '@zterm/shared/protocol';

export const SESSION_DRAWER_FILTER_STORAGE_KEY = 'zterm:session-drawer-filter:v1';

export const SESSION_DRAWER_FILTER_MODES = [
  'all',
  'only-master',
  'hide-worker',
] as const;

export type SessionDrawerFilterMode = (typeof SESSION_DRAWER_FILTER_MODES)[number];
export type SessionDrawerFilterClass = 'master' | 'worker' | 'unclassified';

export interface SessionDrawerFilterConfig {
  version: 2;
  mode: SessionDrawerFilterMode;
  hiddenSessionNames: string[];
}

export const DEFAULT_SESSION_DRAWER_FILTER_CONFIG: SessionDrawerFilterConfig = {
  version: 2,
  mode: 'all',
  hiddenSessionNames: [],
};

export const SESSION_DRAWER_FILTER_LABELS: Record<SessionDrawerFilterMode, string> = {
  all: '全部',
  'only-master': '仅 master',
  'hide-worker': '隐藏 worker',
};

function normalizeMode(value: string | undefined): SessionDrawerFilterMode {
  // Legacy 'hide-subagent' from the manual name-list era now maps to
  // 'hide-worker'; Collab classifies workers, so the old label hides them.
  const candidate = value === 'hide-subagent' ? 'hide-worker' : value;
  return (SESSION_DRAWER_FILTER_MODES as readonly string[]).includes(candidate || '')
    ? (candidate as SessionDrawerFilterMode)
    : DEFAULT_SESSION_DRAWER_FILTER_CONFIG.mode;
}

function normalizeNameList(names: unknown): string[] {
  if (!Array.isArray(names)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') {
      continue;
    }
    const name = raw.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

export function createDefaultSessionDrawerFilterConfig(): SessionDrawerFilterConfig {
  return {
    version: 2,
    mode: DEFAULT_SESSION_DRAWER_FILTER_CONFIG.mode,
    hiddenSessionNames: [],
  };
}

export function normalizeSessionDrawerFilterConfig(value: unknown): SessionDrawerFilterConfig {
  const candidate = value && typeof value === 'object'
    ? value as Partial<SessionDrawerFilterConfig>
    : {};
  // Legacy v1 configs carried manual role name lists. Those lists are no
  // longer authoritative, and only hidden session names survive migration.
  return {
    version: 2,
    mode: normalizeMode(
      typeof candidate.mode === 'string' ? candidate.mode : undefined,
    ),
    hiddenSessionNames: normalizeNameList(candidate.hiddenSessionNames),
  };
}

export function serializeSessionDrawerFilterConfig(config: SessionDrawerFilterConfig): string {
  return JSON.stringify(normalizeSessionDrawerFilterConfig(config));
}

export function parseSessionDrawerFilterConfig(raw: string | null | undefined): SessionDrawerFilterConfig {
  if (!raw) {
    return createDefaultSessionDrawerFilterConfig();
  }
  try {
    return normalizeSessionDrawerFilterConfig(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultSessionDrawerFilterConfig();
  }
}

export function resolveSessionNameForVisibility(input: {
  sessionName?: string | null;
}): string {
  return typeof input.sessionName === 'string' ? input.sessionName.trim() : '';
}

export function classifySessionDrawerVisibility(
  collab: TerminalSessionCollabProjection | null | undefined,
): SessionDrawerFilterClass {
  if (collab?.role === 'ceo' || collab?.role === 'master') {
    return 'master';
  }
  if (collab?.role === 'worker') {
    return 'worker';
  }
  return 'unclassified';
}

export function sessionMatchesDrawerVisibility(
  sessionClass: SessionDrawerFilterClass,
  mode: SessionDrawerFilterMode,
): boolean {
  if (mode === 'only-master') {
    return sessionClass === 'master';
  }
  if (mode === 'hide-worker') {
    return sessionClass !== 'worker';
  }
  return true;
}

export function hideSessionName(
  config: SessionDrawerFilterConfig,
  sessionName: string,
): SessionDrawerFilterConfig {
  const normalized = normalizeSessionDrawerFilterConfig(config);
  const name = sessionName.trim();
  if (!name || normalized.hiddenSessionNames.includes(name)) {
    return normalized;
  }
  return {
    ...normalized,
    hiddenSessionNames: [...normalized.hiddenSessionNames, name],
  };
}

export function restoreHiddenSessionName(
  config: SessionDrawerFilterConfig,
  sessionName: string,
): SessionDrawerFilterConfig {
  const normalized = normalizeSessionDrawerFilterConfig(config);
  const name = sessionName.trim();
  if (!name || !normalized.hiddenSessionNames.includes(name)) {
    return normalized;
  }
  return {
    ...normalized,
    hiddenSessionNames: normalized.hiddenSessionNames.filter((item) => item !== name),
  };
}

export function restoreAllHiddenSessions(config: SessionDrawerFilterConfig): SessionDrawerFilterConfig {
  return {
    ...normalizeSessionDrawerFilterConfig(config),
    hiddenSessionNames: [],
  };
}

export function filterSessionsByDrawerVisibility<T>(
  sessions: readonly T[],
  config: SessionDrawerFilterConfig,
  resolveSessionName: (session: T) => string,
  resolveCollab?: (session: T) => TerminalSessionCollabProjection | null | undefined,
): T[] {
  const normalized = normalizeSessionDrawerFilterConfig(config);
  const hiddenSessionNames = new Set(normalized.hiddenSessionNames);
  return sessions.filter((session) => {
    const sessionName = resolveSessionName(session).trim();
    if (sessionName && hiddenSessionNames.has(sessionName)) {
      return false;
    }
    const sessionClass = classifySessionDrawerVisibility(
      resolveCollab?.(session),
    );
    return sessionMatchesDrawerVisibility(sessionClass, normalized.mode);
  });
}

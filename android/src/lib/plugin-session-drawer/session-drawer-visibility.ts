export const SESSION_DRAWER_FILTER_STORAGE_KEY = 'zterm:session-drawer-filter:v1';

export const SESSION_DRAWER_FILTER_MODES = [
  'all',
  'only-master',
  'hide-subagent',
] as const;

export type SessionDrawerFilterMode = (typeof SESSION_DRAWER_FILTER_MODES)[number];
export type SessionDrawerFilterClass = 'master' | 'subagent' | 'unclassified';

export interface SessionDrawerFilterConfig {
  version: 1;
  mode: SessionDrawerFilterMode;
  masterNames: string[];
  subagentNames: string[];
  hiddenSessionNames: string[];
}

export const DEFAULT_SESSION_DRAWER_FILTER_CONFIG: SessionDrawerFilterConfig = {
  version: 1,
  mode: 'all',
  masterNames: [],
  subagentNames: [],
  hiddenSessionNames: [],
};

export const SESSION_DRAWER_FILTER_LABELS: Record<SessionDrawerFilterMode, string> = {
  all: '全部',
  'only-master': '仅 master',
  'hide-subagent': '隐藏 subagent',
};

function isSessionDrawerFilterMode(value: string): value is SessionDrawerFilterMode {
  return (SESSION_DRAWER_FILTER_MODES as readonly string[]).includes(value);
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
    version: 1,
    mode: DEFAULT_SESSION_DRAWER_FILTER_CONFIG.mode,
    masterNames: [],
    subagentNames: [],
    hiddenSessionNames: [],
  };
}

export function normalizeSessionDrawerFilterConfig(value: unknown): SessionDrawerFilterConfig {
  const candidate = value && typeof value === 'object'
    ? value as Partial<SessionDrawerFilterConfig>
    : {};
  return {
    version: 1,
    mode: typeof candidate.mode === 'string' && isSessionDrawerFilterMode(candidate.mode)
      ? candidate.mode
      : DEFAULT_SESSION_DRAWER_FILTER_CONFIG.mode,
    masterNames: normalizeNameList(candidate.masterNames),
    subagentNames: normalizeNameList(candidate.subagentNames),
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
  sessionName: string,
  config: Pick<SessionDrawerFilterConfig, 'masterNames' | 'subagentNames'>,
): SessionDrawerFilterClass {
  const name = sessionName.trim();
  if (!name) {
    return 'unclassified';
  }
  const masterNames = new Set(normalizeNameList(config.masterNames));
  const subagentNames = new Set(normalizeNameList(config.subagentNames));
  const listedMaster = masterNames.has(name);
  const listedSubagent = subagentNames.has(name);
  if (listedMaster && listedSubagent) {
    return 'unclassified';
  }
  if (listedSubagent) {
    return 'subagent';
  }
  if (listedMaster) {
    return 'master';
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
  if (mode === 'hide-subagent') {
    return sessionClass !== 'subagent';
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
): T[] {
  const normalized = normalizeSessionDrawerFilterConfig(config);
  const hiddenSessionNames = new Set(normalized.hiddenSessionNames);
  return sessions.filter((session) => {
    const sessionName = resolveSessionName(session).trim();
    if (sessionName && hiddenSessionNames.has(sessionName)) {
      return false;
    }
    return sessionMatchesDrawerVisibility(
      classifySessionDrawerVisibility(sessionName, normalized),
      normalized.mode,
    );
  });
}

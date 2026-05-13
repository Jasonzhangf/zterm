import { normalizeBridgeSettings, type BridgeSettings } from './bridge-settings';

export interface ApkSmokeBridgeDebugTarget {
  source: 'active-open-tab' | 'open-tab' | 'bridge-settings-target' | 'bridge-settings-server' | 'host';
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
  sessionId?: string;
  sessionName?: string;
  daemonHostId?: string;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function normalizeFragmentedSessionId(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('session-')) {
    return normalized;
  }
  const clean = normalized
    .replace(/^[A-Za-z]-((?:\d{10,})-[A-Za-z0-9]+)$/u, '$1')
    .replace(/^((?:\d{10,})-[A-Za-z0-9]+)$/u, '$1');
  if (/^(?:\d{10,})-[A-Za-z0-9]+$/u.test(clean)) {
    return `session-${clean}`;
  }
  return '';
}

function normalizeFragmentedWindow(window: string) {
  return window.replace(/\s+/g, '');
}

function extractIpv4Value(window: string, key: string) {
  const match = window.match(new RegExp(`(?:${key})[^0-9]{0,12}(\\d{1,3}(?:\\.\\d{1,3}){3})`, 'iu'));
  return match?.[1]?.trim() || '';
}

function extractPortValue(window: string, key: string) {
  const match = window.match(new RegExp(`(?:${key})[^0-9]{0,12}(\\d{2,5})`, 'iu'));
  if (!match) {
    return Number.NaN;
  }
  return Number.parseInt(match[1] || '', 10);
}

function extractDelimitedFragment(window: string, key: string, stopTokens: string[]) {
  const startMatch = window.match(new RegExp(`(?:${key})[^A-Za-z0-9]{0,12}`, 'iu'));
  if (!startMatch || startMatch.index === undefined) {
    return '';
  }
  const startIndex = startMatch.index + startMatch[0].length;
  const tail = window.slice(startIndex);
  let endIndex = tail.length;
  for (const stopToken of stopTokens) {
    const index = tail.search(new RegExp(stopToken, 'iu'));
    if (index >= 0) {
      endIndex = Math.min(endIndex, index);
    }
  }
  return tail
    .slice(0, endIndex)
    .replace(/^"+/u, '')
    .replace(/"+$/u, '')
    .trim();
}

function extractFragmentedSessionId(window: string) {
  const match = window.match(/sessionId[^A-Za-z0-9]{0,12}([A-Za-z]-)?(\d{10,}-[A-Za-z0-9]+)/iu);
  if (!match) {
    return '';
  }
  const candidate = `${match[1] || ''}${match[2] || ''}`;
  return normalizeFragmentedSessionId(candidate);
}

function sanitizeExtractedToken(token: string | undefined) {
  const normalized = token?.trim() || '';
  if (!normalized) {
    return '';
  }
  const cutoffTokens = ['autoCommand', 'createdAt', 'password', 'tags', 'lastConnect', 'CacheLines', 'servers', 'defaultServerId'];
  let endIndex = normalized.length;
  for (const tokenStop of cutoffTokens) {
    const index = normalized.search(new RegExp(tokenStop, 'iu'));
    if (index >= 0) {
      endIndex = Math.min(endIndex, index);
    }
  }
  return normalized
    .slice(0, endIndex)
    .replace(/".*$/u, '')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .replace(/[^A-Za-z0-9._!@#$:-]+$/u, '')
    .trim();
}

function sanitizeExtractedDaemonHostId(value: string | undefined) {
  const normalized = value?.trim() || '';
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/[A-Za-z0-9._:-]+/u);
  return match?.[0] || '';
}

function parseInlineJsonFromLine(line: string) {
  const firstObject = line.indexOf('{');
  const firstArray = line.indexOf('[');
  const start = [firstObject, firstArray].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? -1;
  if (start < 0) {
    return null;
  }
  const end = Math.max(line.lastIndexOf('}'), line.lastIndexOf(']'));
  if (end <= start) {
    return null;
  }
  const candidate = line.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function collectJsonValues(lines: string[]) {
  return lines
    .map((line) => parseInlineJsonFromLine(line))
    .filter((value) => value !== null);
}

function extractActiveSessionId(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line.includes('zterm:active-session')) {
      continue;
    }
    const sameLineMatch = line.match(/session-[A-Za-z0-9_-]+/);
    if (sameLineMatch) {
      return sameLineMatch[0];
    }
    const next = lines[index + 1]?.trim() || '';
    if (next.startsWith('session-')) {
      return next;
    }
    const fragmentedWindow = lines.slice(index, index + 8).join('');
    const fragmentedMatch = fragmentedWindow.match(/[A-Za-z]-\d{10,}-[A-Za-z0-9]+/u);
    const fragmentedSessionId = normalizeFragmentedSessionId(fragmentedMatch?.[0] || '');
    if (fragmentedSessionId) {
      return fragmentedSessionId;
    }
  }
  return '';
}

function pickFromOpenTabs(values: unknown[], activeSessionId: string): ApkSmokeBridgeDebugTarget | null {
  const arrays = values.filter(Array.isArray) as unknown[][];
  const tabs: Record<string, unknown>[] = [];
  for (const array of arrays) {
    for (const entry of array) {
      const record = asRecord(entry);
      if (!record) {
        continue;
      }
      if (asString(record.bridgeHost) && Number.isFinite(asNumber(record.bridgePort))) {
        tabs.push(record);
      }
    }
  }

  if (tabs.length === 0) {
    return null;
  }

  const preferred = activeSessionId
    ? tabs.find((entry) => asString(entry.sessionId) === activeSessionId) || null
    : null;
  const selected = preferred || tabs[0]!;
  return {
    source: preferred ? 'active-open-tab' : 'open-tab',
    bridgeHost: asString(selected.bridgeHost),
    bridgePort: Math.max(1, Math.floor(asNumber(selected.bridgePort))),
    authToken: asString(selected.authToken) || undefined,
    sessionId: asString(selected.sessionId) || undefined,
    sessionName: asString(selected.sessionName) || undefined,
    daemonHostId: asString(selected.daemonHostId) || undefined,
  };
}

function pickFromBridgeSettings(values: unknown[]): ApkSmokeBridgeDebugTarget | null {
  for (const value of values) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }
    if (!('targetHost' in record || 'servers' in record)) {
      continue;
    }
    const normalized = normalizeBridgeSettings(record as Partial<BridgeSettings>);
    if (normalized.targetHost.trim()) {
      return {
        source: 'bridge-settings-target',
        bridgeHost: normalized.targetHost.trim(),
        bridgePort: Math.max(1, Math.floor(normalized.targetPort || 3333)),
        authToken: normalized.targetAuthToken?.trim() || undefined,
      };
    }
    const defaultServer = normalized.servers.find((server) => server.id === normalized.defaultServerId) || normalized.servers[0] || null;
    if (defaultServer && defaultServer.targetHost.trim()) {
      return {
        source: 'bridge-settings-server',
        bridgeHost: defaultServer.targetHost.trim(),
        bridgePort: Math.max(1, Math.floor(defaultServer.targetPort || 3333)),
        authToken: defaultServer.authToken?.trim() || undefined,
        daemonHostId: defaultServer.relayHostId?.trim() || undefined,
      };
    }
  }
  return null;
}

function pickFromHosts(values: unknown[]): ApkSmokeBridgeDebugTarget | null {
  const arrays = values.filter(Array.isArray) as unknown[][];
  for (const array of arrays) {
    for (const entry of array) {
      const record = asRecord(entry);
      if (!record) {
        continue;
      }
      const bridgeHost = asString(record.bridgeHost);
      const bridgePort = asNumber(record.bridgePort);
      if (!bridgeHost || !Number.isFinite(bridgePort)) {
        continue;
      }
      return {
        source: 'host',
        bridgeHost,
        bridgePort: Math.max(1, Math.floor(bridgePort)),
        authToken: asString(record.authToken) || undefined,
        daemonHostId: asString(record.daemonHostId) || undefined,
        sessionName: asString(record.sessionName) || undefined,
      };
    }
  }
  return null;
}

function collectFragmentedOpenTabTargets(lines: string[]) {
  const candidates: ApkSmokeBridgeDebugTarget[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes('zterm:open-tabs')) {
      continue;
    }
    const window = normalizeFragmentedWindow(lines.slice(index, index + 12).join(''));
    const bridgeHost = extractIpv4Value(window, 'bridgeHost');
    const bridgePort = extractPortValue(window, 'bridgePort|Port');
    if (!bridgeHost || !Number.isFinite(bridgePort)) {
      continue;
    }
    const sessionId = extractFragmentedSessionId(window) || undefined;
    const authToken = sanitizeExtractedToken(
      extractDelimitedFragment(window, 'authToken', ['autoCommand', 'createdAt', 'password', 'tags', 'lastConnect', 'sessionName', 'bridgeHost', 'bridgePort']),
    )
      || undefined;
    const daemonHostId = sanitizeExtractedDaemonHostId(
      extractDelimitedFragment(window, 'daemonHostId', ['authToken', 'autoCommand', 'createdAt', 'bridgeHost', 'bridgePort']),
    )
      || undefined;
    const sessionName = extractDelimitedFragment(window, 'sessionName', ['authToken', 'password', 'tags', 'lastConnect', 'bridgeHost', 'bridgePort'])
      || undefined;
    candidates.push({
      source: 'open-tab',
      bridgeHost,
      bridgePort: Math.max(1, Math.floor(bridgePort)),
      authToken,
      sessionId,
      sessionName,
      daemonHostId,
    });
  }
  return candidates;
}

function pickFromFragmentedOpenTabs(lines: string[], activeSessionId: string) {
  const candidates = collectFragmentedOpenTabTargets(lines);
  if (candidates.length === 0) {
    return null;
  }
  const preferred = activeSessionId
    ? candidates.find((candidate) => candidate.sessionId === activeSessionId) || null
    : null;
  if (preferred) {
    return {
      ...preferred,
      source: 'active-open-tab' as const,
    };
  }
  return candidates[0] || null;
}

function pickFromFragmentedBridgeSettings(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes('bridge-settings')) {
      continue;
    }
    const window = normalizeFragmentedWindow(lines.slice(index, index + 8).join(''));
    const bridgeHost = extractIpv4Value(window, 'targetHost');
    const bridgePort = extractPortValue(window, 'targetPort|Port');
    if (!bridgeHost || !Number.isFinite(bridgePort)) {
      continue;
    }
    const authToken = sanitizeExtractedToken(
      extractDelimitedFragment(window, 'AuthToken|authToken', ['CacheLines', 'servers', 'defaultServerId', 'signalServer', 'turnServer']),
    )
      || undefined;
    return {
      source: 'bridge-settings-target',
      bridgeHost,
      bridgePort: Math.max(1, Math.floor(bridgePort)),
      authToken,
    } satisfies ApkSmokeBridgeDebugTarget;
  }
  return null;
}

function isLikelyCanonicalBridgeAuthToken(token: string | undefined) {
  const normalized = token?.trim() || '';
  if (!normalized) {
    return false;
  }
  if (!/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    return false;
  }
  return /[A-Za-z]{2,}/u.test(normalized);
}

export function extractApkSmokeBridgeDebugTargetFromStorageDump(rawDump: string): {
  activeSessionId: string | null;
  parsedJsonCount: number;
  target: ApkSmokeBridgeDebugTarget | null;
} {
  const lines = rawDump
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const activeSessionId = extractActiveSessionId(lines);
  const jsonValues = collectJsonValues(lines);
  const bridgeSettingsTarget = pickFromBridgeSettings(jsonValues)
    || pickFromFragmentedBridgeSettings(lines)
    || null;
  const openTabTarget = pickFromOpenTabs(jsonValues, activeSessionId)
    || pickFromFragmentedOpenTabs(lines, activeSessionId)
    || null;
  const target = (() => {
    if (openTabTarget && bridgeSettingsTarget) {
      return {
        ...openTabTarget,
        authToken: isLikelyCanonicalBridgeAuthToken(openTabTarget.authToken)
          ? openTabTarget.authToken
          : (bridgeSettingsTarget.authToken || openTabTarget.authToken),
      } satisfies ApkSmokeBridgeDebugTarget;
    }
    return openTabTarget
      || bridgeSettingsTarget
    || pickFromHosts(jsonValues)
      || null;
  })();
  return {
    activeSessionId: activeSessionId || null,
    parsedJsonCount: jsonValues.length,
    target,
  };
}

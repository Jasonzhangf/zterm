export type SessionTerminalChannelState = 'opening' | 'open' | 'closing' | 'closed';

export interface SessionTerminalChannelRuntime {
  channelId: string;
  sessionId: string;
  sessionName: string;
  targetKey: string;
  state: SessionTerminalChannelState;
  bodySubscribed: boolean;
  openedAt: number;
  closedAt: number | null;
}

export interface TerminalChannelTargetRuntime {
  channels: Map<string, SessionTerminalChannelRuntime>;
}

export interface TerminalChannelSessionBinding {
  sessionId: string;
  targetKey: string;
  channelId: string | null;
  sessionName: string;
}

export interface TerminalChannelMuxStore {
  targets: Map<string, TerminalChannelTargetRuntime>;
  sessions: Map<string, TerminalChannelSessionBinding>;
}

function normalizeKeyText(value: string | undefined | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionName(value: string) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createTerminalChannelMuxStore(): TerminalChannelMuxStore {
  return {
    targets: new Map(),
    sessions: new Map(),
  };
}

export function ensureTerminalChannelTarget(
  store: TerminalChannelMuxStore,
  targetKey: string,
) {
  const normalizedTargetKey = normalizeKeyText(targetKey);
  const existing = store.targets.get(normalizedTargetKey) || null;
  if (existing) {
    return existing;
  }
  const created: TerminalChannelTargetRuntime = {
    channels: new Map(),
  };
  store.targets.set(normalizedTargetKey, created);
  return created;
}

export function pruneTerminalChannelTargetIfEmpty(
  store: TerminalChannelMuxStore,
  targetKey: string,
) {
  const normalizedTargetKey = normalizeKeyText(targetKey);
  const target = store.targets.get(normalizedTargetKey) || null;
  if (!target || target.channels.size > 0) {
    return;
  }
  const hasBinding = Array.from(store.sessions.values()).some((binding) => (
    binding.targetKey === normalizedTargetKey
  ));
  if (hasBinding) {
    return;
  }
  store.targets.delete(normalizedTargetKey);
}

export function bindTerminalChannelSession(
  store: TerminalChannelMuxStore,
  sessionId: string,
  targetKey: string,
  sessionName: string,
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const normalizedTargetKey = normalizeKeyText(targetKey);
  const existing = store.sessions.get(normalizedSessionId) || null;
  const previousTargetKey = existing?.targetKey || '';
  if (existing && existing.channelId && previousTargetKey !== normalizedTargetKey) {
    removeSessionTerminalChannel(store, normalizedSessionId);
  }
  const binding = existing || {
    sessionId: normalizedSessionId,
    targetKey: normalizedTargetKey,
    channelId: null,
    sessionName: '',
  };
  binding.targetKey = normalizedTargetKey;
  binding.sessionName = normalizeSessionName(sessionName);
  store.sessions.set(normalizedSessionId, binding);
  ensureTerminalChannelTarget(store, normalizedTargetKey);
  if (previousTargetKey && previousTargetKey !== normalizedTargetKey) {
    pruneTerminalChannelTargetIfEmpty(store, previousTargetKey);
  }
  return binding;
}

export function clearTerminalChannelSession(
  store: TerminalChannelMuxStore,
  sessionId: string,
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const binding = store.sessions.get(normalizedSessionId) || null;
  removeSessionTerminalChannel(store, normalizedSessionId);
  store.sessions.delete(normalizedSessionId);
  if (binding) {
    pruneTerminalChannelTargetIfEmpty(store, binding.targetKey);
  }
}

export function getSessionTerminalChannel(
  store: TerminalChannelMuxStore,
  sessionId: string,
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const binding = store.sessions.get(normalizedSessionId) || null;
  if (!binding?.channelId) {
    return null;
  }
  return store.targets.get(binding.targetKey)?.channels.get(binding.channelId) || null;
}

export function getSessionIdForTerminalChannel(
  store: TerminalChannelMuxStore,
  targetKey: string,
  channelId: string,
) {
  const normalizedTargetKey = normalizeKeyText(targetKey);
  const normalizedChannelId = normalizeKeyText(channelId);
  if (!normalizedChannelId) {
    return null;
  }
  return store.targets.get(normalizedTargetKey)?.channels.get(normalizedChannelId)?.sessionId || null;
}

export function getTerminalChannelsForTarget(
  store: TerminalChannelMuxStore,
  targetKey: string,
) {
  const normalizedTargetKey = normalizeKeyText(targetKey);
  return Array.from(store.targets.get(normalizedTargetKey)?.channels.values() || []);
}

export function getOpeningSessionTerminalChannelsForTarget(
  store: TerminalChannelMuxStore,
  targetKey: string,
  prioritySessionId?: string | null,
) {
  const openingChannels = getTerminalChannelsForTarget(store, targetKey)
    .filter((channel) => channel.state === 'opening');
  const normalizedPrioritySessionId = normalizeKeyText(prioritySessionId);
  if (!normalizedPrioritySessionId) {
    return openingChannels;
  }
  return openingChannels.sort((left, right) => {
    if (left.sessionId === normalizedPrioritySessionId) {
      return -1;
    }
    if (right.sessionId === normalizedPrioritySessionId) {
      return 1;
    }
    return 0;
  });
}

export function ensureSessionTerminalChannel(
  store: TerminalChannelMuxStore,
  sessionId: string,
  options: {
    channelId?: string;
    now?: number;
    bodySubscribed?: boolean;
  } = {},
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const binding = store.sessions.get(normalizedSessionId) || null;
  if (!binding) {
    return null;
  }
  const existing = getSessionTerminalChannel(store, normalizedSessionId);
  if (existing) {
    return existing;
  }
  const target = ensureTerminalChannelTarget(store, binding.targetKey);
  const channelId = normalizeKeyText(options.channelId) || `channel:${normalizedSessionId}`;
  const sameId = target.channels.get(channelId) || null;
  if (sameId && sameId.sessionId !== normalizedSessionId) {
    throw new Error(`terminal channel ${channelId} is already bound to ${sameId.sessionId}`);
  }
  const channel: SessionTerminalChannelRuntime = {
    channelId,
    sessionId: normalizedSessionId,
    sessionName: binding.sessionName,
    targetKey: binding.targetKey,
    state: 'opening',
    bodySubscribed: typeof options.bodySubscribed === 'boolean' ? options.bodySubscribed : true,
    openedAt: Number.isFinite(options.now) ? Math.max(0, Math.floor(options.now || 0)) : Date.now(),
    closedAt: null,
  };
  target.channels.set(channelId, channel);
  binding.channelId = channelId;
  return channel;
}

export function updateSessionTerminalChannelName(
  store: TerminalChannelMuxStore,
  sessionId: string,
  sessionName: string,
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const channel = getSessionTerminalChannel(store, normalizedSessionId);
  const normalizedSessionName = normalizeSessionName(sessionName);
  if (!channel || !normalizedSessionName) {
    return channel;
  }
  channel.sessionName = normalizedSessionName;
  const binding = store.sessions.get(normalizedSessionId) || null;
  if (binding) {
    binding.sessionName = normalizedSessionName;
  }
  return channel;
}

export function updateSessionTerminalChannelState(
  store: TerminalChannelMuxStore,
  sessionId: string,
  state: SessionTerminalChannelState,
  now = Date.now(),
) {
  const channel = getSessionTerminalChannel(store, sessionId);
  if (!channel) {
    return null;
  }
  channel.state = state;
  if (state === 'closed') {
    channel.closedAt = Math.max(0, Math.floor(now || 0));
  }
  return channel;
}

export function setSessionChannelBodySubscribed(
  store: TerminalChannelMuxStore,
  sessionId: string,
  bodySubscribed: boolean,
) {
  const channel = getSessionTerminalChannel(store, sessionId);
  if (!channel) {
    return null;
  }
  channel.bodySubscribed = Boolean(bodySubscribed);
  return channel;
}

export function removeSessionTerminalChannel(
  store: TerminalChannelMuxStore,
  sessionId: string,
) {
  const normalizedSessionId = normalizeKeyText(sessionId);
  const binding = store.sessions.get(normalizedSessionId) || null;
  if (!binding?.channelId) {
    return null;
  }
  const target = store.targets.get(binding.targetKey) || null;
  const removed = target?.channels.get(binding.channelId) || null;
  target?.channels.delete(binding.channelId);
  binding.channelId = null;
  pruneTerminalChannelTargetIfEmpty(store, binding.targetKey);
  return removed;
}

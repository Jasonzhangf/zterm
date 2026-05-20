import type { RuntimeDebugLogEntry } from './types';

const RUNTIME_DEBUG_STORAGE_KEY = 'zterm:runtime-debug-log';
const RUNTIME_DEBUG_CONSOLE_STORAGE_KEY = 'zterm:runtime-debug-console';
const MAX_RUNTIME_DEBUG_QUEUE = 120;
const MAX_RUNTIME_DEBUG_PAYLOAD_CHARS = 900;
const MAX_RUNTIME_DEBUG_BATCH_ENTRIES = 8;
const MAX_RUNTIME_DEBUG_BATCH_CHARS = 4800;
const HIGH_FREQUENCY_RUNTIME_DEBUG_MIN_INTERVAL_MS = 500;
const INSPECT_RUNTIME_DEBUG_MIN_INTERVAL_MS = 1500;

let runtimeDebugSequence = 0;
let droppedRuntimeDebugEntries = 0;
const runtimeDebugQueue: RuntimeDebugLogEntry[] = [];
const runtimeDebugLastSampleAt = new Map<string, number>();
let runtimeDebugEnabledCache: boolean | null = null;
let runtimeDebugConsoleEnabledCache: boolean | null = null;

function safeReadStorageFlag() {
  if (runtimeDebugEnabledCache !== null) {
    return runtimeDebugEnabledCache;
  }
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    runtimeDebugEnabledCache = window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY) === '1';
    return runtimeDebugEnabledCache;
  } catch (error) {
    console.warn('[runtime-debug] Failed to read runtime debug flag:', error);
    return false;
  }
}

export function isRuntimeDebugEnabled() {
  return safeReadStorageFlag();
}

// Always-mirror probe for critical latency path - bypasses localStorage gate
export function runtimeDebugForce(scope: string, payload?: unknown) {
  // Hard stop for production latency: disable force-debug collection by default.
  // Keep test/runtime shape intact without enqueue/flush side effects.
  if (typeof process === 'undefined' || !process.env.VITEST) {
    return;
  }
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  enqueueRuntimeDebugEntry({
    seq: ++runtimeDebugSequence,
    ts: timestamp,
    scope,
    payload: payload === undefined ? undefined : normalizePayload(payload),
  });
  if (typeof process !== 'undefined' && process.env.VITEST) return;
  console.debug(`[runtime:${scope}] ${timestamp}`, payload ?? '');
}
function shouldMirrorRuntimeDebugToConsole() {
  if (runtimeDebugConsoleEnabledCache !== null) {
    return runtimeDebugConsoleEnabledCache;
  }
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    runtimeDebugConsoleEnabledCache = window.localStorage.getItem(RUNTIME_DEBUG_CONSOLE_STORAGE_KEY) === '1';
    return runtimeDebugConsoleEnabledCache;
  } catch (error) {
    console.warn('[runtime-debug] Failed to read runtime debug console flag:', error);
    return false;
  }
}

export function setRuntimeDebugEnabled(enabled: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.setItem(RUNTIME_DEBUG_STORAGE_KEY, '1');
      runtimeDebugEnabledCache = true;
      return;
    }
    window.localStorage.removeItem(RUNTIME_DEBUG_STORAGE_KEY);
    runtimeDebugEnabledCache = false;
  } catch (error) {
    console.warn('[runtime-debug] Failed to update runtime debug flag:', error);
  }
}

function truncateString(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 12))}…[truncated]`;
}

function normalizePayload(payload: unknown): string | undefined {
  if (payload === undefined) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return truncateString(payload, MAX_RUNTIME_DEBUG_PAYLOAD_CHARS);
  }

  try {
    const serialized = JSON.stringify(payload);
    if (!serialized) {
      return undefined;
    }
    return truncateString(serialized, MAX_RUNTIME_DEBUG_PAYLOAD_CHARS);
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : String(error);
    console.warn('[runtime-debug] Failed to serialize payload:', error);
    return truncateString(`[unserializable:${errorSummary}]`, MAX_RUNTIME_DEBUG_PAYLOAD_CHARS);
  }
}

function enqueueRuntimeDebugEntry(entry: RuntimeDebugLogEntry) {
  runtimeDebugQueue.push(entry);
  while (runtimeDebugQueue.length > MAX_RUNTIME_DEBUG_QUEUE) {
    runtimeDebugQueue.shift();
    droppedRuntimeDebugEntries += 1;
  }
}

function shouldSampleRuntimeDebugScope(scope: string) {
  return (
    scope === 'session.buffer.head'
    || scope === 'session.buffer.request'
    || scope === 'session.buffer.apply.inspect'
    || scope === 'session.render-gate.flush.inspect'
    || scope.startsWith('session.transport.active-tick')
  );
}

function resolveRuntimeDebugScopeMinIntervalMs(scope: string) {
  if (
    scope === 'session.buffer.apply.inspect'
    || scope === 'session.render-gate.flush.inspect'
  ) {
    return INSPECT_RUNTIME_DEBUG_MIN_INTERVAL_MS;
  }
  return HIGH_FREQUENCY_RUNTIME_DEBUG_MIN_INTERVAL_MS;
}

export function shouldCollectRuntimeDebugScope(scope: string) {
  if (!safeReadStorageFlag()) {
    return false;
  }

  const now = Date.now();
  if (shouldSampleRuntimeDebugScope(scope)) {
    const previousAt = runtimeDebugLastSampleAt.get(scope) || 0;
    const minIntervalMs = resolveRuntimeDebugScopeMinIntervalMs(scope);
    if (now - previousAt < minIntervalMs) {
      return false;
    }
    runtimeDebugLastSampleAt.set(scope, now);
  }
  return true;
}

export function runtimeDebug(scope: string, payload?: unknown) {
  if (!shouldCollectRuntimeDebugScope(scope)) {
    return;
  }
  runtimeDebugPrechecked(scope, payload);
}

export function runtimeDebugPrechecked(scope: string, payload?: unknown) {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const normalizedPayload = normalizePayload(payload);
  enqueueRuntimeDebugEntry({
    seq: ++runtimeDebugSequence,
    ts: timestamp,
    scope,
    payload: normalizedPayload,
  });

  if (typeof process !== 'undefined' && process.env.VITEST) {
    return;
  }

  if (!shouldMirrorRuntimeDebugToConsole()) {
    return;
  }

  if (payload === undefined) {
    console.debug(`[runtime:${scope}] ${timestamp}`);
    return;
  }

  console.debug(`[runtime:${scope}] ${timestamp}`, payload);
}

export function drainRuntimeDebugEntries() {
  const entries: RuntimeDebugLogEntry[] = [];
  let remainingChars = MAX_RUNTIME_DEBUG_BATCH_CHARS;

  if (droppedRuntimeDebugEntries > 0) {
    const droppedEntry: RuntimeDebugLogEntry = {
      seq: ++runtimeDebugSequence,
      ts: new Date().toISOString(),
      scope: 'runtime.debug.drop-summary',
      payload: `dropped=${droppedRuntimeDebugEntries}`,
    };
    droppedRuntimeDebugEntries = 0;
    runtimeDebugQueue.unshift(droppedEntry);
  }

  while (runtimeDebugQueue.length > 0 && entries.length < MAX_RUNTIME_DEBUG_BATCH_ENTRIES) {
    const next = runtimeDebugQueue[0]!;
    const nextChars = next.scope.length + next.ts.length + (next.payload?.length || 0);
    if (entries.length > 0 && nextChars > remainingChars) {
      break;
    }
    runtimeDebugQueue.shift();
    entries.push(next);
    remainingChars -= nextChars;
  }

  return entries;
}

export function getPendingRuntimeDebugEntryCount() {
  return runtimeDebugQueue.length;
}

export function readRuntimeDebugEntries(options?: {
  limit?: number;
  sinceSeq?: number;
}) {
  const limit = Math.max(1, Math.min(MAX_RUNTIME_DEBUG_QUEUE, Math.floor(options?.limit || MAX_RUNTIME_DEBUG_QUEUE)));
  const sinceSeq = typeof options?.sinceSeq === 'number' && Number.isFinite(options.sinceSeq)
    ? options.sinceSeq
    : null;
  const filtered = sinceSeq === null
    ? runtimeDebugQueue
    : runtimeDebugQueue.filter((entry) => entry.seq > sinceSeq);
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export {
  MAX_RUNTIME_DEBUG_BATCH_ENTRIES,
  MAX_RUNTIME_DEBUG_BATCH_CHARS,
  MAX_RUNTIME_DEBUG_PAYLOAD_CHARS,
  MAX_RUNTIME_DEBUG_QUEUE,
  RUNTIME_DEBUG_CONSOLE_STORAGE_KEY,
  INSPECT_RUNTIME_DEBUG_MIN_INTERVAL_MS,
  RUNTIME_DEBUG_STORAGE_KEY,
};

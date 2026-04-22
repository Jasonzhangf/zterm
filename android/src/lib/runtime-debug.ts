import type { RuntimeDebugLogEntry } from './types';

const RUNTIME_DEBUG_STORAGE_KEY = 'zterm:runtime-debug-log';
const MAX_RUNTIME_DEBUG_QUEUE = 120;
const MAX_RUNTIME_DEBUG_PAYLOAD_CHARS = 900;
const MAX_RUNTIME_DEBUG_BATCH_ENTRIES = 8;
const MAX_RUNTIME_DEBUG_BATCH_CHARS = 4800;

let runtimeDebugSequence = 0;
let droppedRuntimeDebugEntries = 0;
const runtimeDebugQueue: RuntimeDebugLogEntry[] = [];

function safeReadStorageFlag() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isRuntimeDebugEnabled() {
  return safeReadStorageFlag();
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
    const fallback = error instanceof Error ? error.message : String(error);
    return truncateString(`[unserializable:${fallback}]`, MAX_RUNTIME_DEBUG_PAYLOAD_CHARS);
  }
}

function enqueueRuntimeDebugEntry(entry: RuntimeDebugLogEntry) {
  runtimeDebugQueue.push(entry);
  while (runtimeDebugQueue.length > MAX_RUNTIME_DEBUG_QUEUE) {
    runtimeDebugQueue.shift();
    droppedRuntimeDebugEntries += 1;
  }
}

export function runtimeDebug(scope: string, payload?: unknown) {
  if (!safeReadStorageFlag()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const normalizedPayload = normalizePayload(payload);
  enqueueRuntimeDebugEntry({
    seq: ++runtimeDebugSequence,
    ts: timestamp,
    scope,
    payload: normalizedPayload,
  });

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

export {
  MAX_RUNTIME_DEBUG_BATCH_ENTRIES,
  MAX_RUNTIME_DEBUG_BATCH_CHARS,
  MAX_RUNTIME_DEBUG_PAYLOAD_CHARS,
  MAX_RUNTIME_DEBUG_QUEUE,
  RUNTIME_DEBUG_STORAGE_KEY,
};

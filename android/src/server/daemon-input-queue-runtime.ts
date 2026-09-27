import {
  TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES,
  TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS,
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';
import type {
  BridgeServerMessage as ServerMessage,
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  SessionMirror,
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import { createReliableInputAckCache } from './terminal-reliable-input-ack';

export type DaemonInputBackendKind = 'tmux' | 'herdr' | 'wezterm';

export interface DaemonInputQueueDeps {
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  getMirrorKey: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
  ) => void;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
  writeBackendInputGroup: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backendKind?: DaemonInputBackendKind,
  ) => Promise<void> | void;
  resolveBackendInputMaxChunkBytes: () => number;
  daemonRuntimeDebug?: (scope: string, payload?: unknown) => void;
}

export interface DaemonInputQueueRuntime {
  handleInputMessage: (connection: TerminalTransportConnection, payload: unknown) => Promise<void>;
  enqueueBackendInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backendKind?: DaemonInputBackendKind,
  ) => Promise<boolean>;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
    backendKind?: DaemonInputBackendKind,
  ) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (
    sessionName: string,
    reason: string,
    backendKind?: DaemonInputBackendKind,
  ) => number;
}

type LiveMirrorInputItem = {
  sessionName: string;
  payload: string;
  appendEnter: boolean;
  backendKind: DaemonInputBackendKind;
  requiresReadyMirror: boolean;
  shouldWrite?: () => boolean;
  resolve: (value: boolean) => void;
  reject: (reason?: unknown) => void;
};

type LiveMirrorInputGroup = {
  payload: string;
  appendEnter: boolean;
  backendKind: DaemonInputBackendKind;
  items: LiveMirrorInputItem[];
};

export function createDaemonInputQueueRuntime(
  deps: DaemonInputQueueDeps,
): DaemonInputQueueRuntime {
  function debugInput(scope: 'receive' | 'drop' | 'write', payload: Record<string, unknown>) {
    deps.daemonRuntimeDebug?.(`input-${scope}`, payload);
  }

  function resolveCurrentSessionForInput(connection: TerminalTransportConnection): TerminalSession | null {
    if (!connection.boundSubscriberId) {
      return null;
    }
    const current = deps.sessions.get(connection.boundSubscriberId) || null;
    if (!current) {
      return null;
    }
    if (current.transportId !== connection.transportId || current.transport !== connection.transport) {
      return null;
    }
    return current;
  }

  function resolveBoundSession(connection: TerminalTransportConnection): TerminalSession | null {
    return connection.boundSubscriberId ? deps.sessions.get(connection.boundSubscriberId) || null : null;
  }

  const reliableInputAckCache = createReliableInputAckCache();

  function sendInputAck(connection: TerminalTransportConnection, payload: TerminalInputAckPayload) {
    deps.sendTransportMessage(connection.transport, {
      type: 'input-ack',
      payload,
    });
  }

  function normalizeReliableInputPayload(payload: unknown): TerminalReliableInputPayload | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const candidate = payload as Partial<TerminalReliableInputPayload>;
    if (
      candidate.version !== 1
      || typeof candidate.seq !== 'string'
      || candidate.seq.trim().length === 0
      || typeof candidate.data !== 'string'
      || typeof candidate.sentAt !== 'number'
      || !Number.isFinite(candidate.sentAt)
      || typeof candidate.attempt !== 'number'
      || !Number.isFinite(candidate.attempt)
    ) {
      return null;
    }
    return {
      version: 1,
      seq: candidate.seq,
      data: candidate.data,
      sentAt: candidate.sentAt,
      attempt: Math.max(0, Math.floor(candidate.attempt)),
    };
  }

  function readReliableInputSeq(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    const seq = (payload as { seq?: unknown }).seq;
    return typeof seq === 'string' ? seq.trim() : '';
  }

  function reportInputDrop(
    connection: TerminalTransportConnection,
    reason: 'session_required' | 'input_stale_transport',
    bytes: number,
    ackSeq?: string,
  ) {
    debugInput('drop', {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      reason,
      bytes,
      queueDepth: 0,
    });
    if (ackSeq) {
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: false,
        bytes,
        error: reason,
      });
    }
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: reason === 'input_stale_transport'
        ? { message: 'input requires the current attached session transport', code: 'input_stale_transport' }
        : { message: 'input requires an attached session transport', code: 'session_required' },
    });
  }

  async function handleTransportInput(connection: TerminalTransportConnection, data: string, ackSeq?: string) {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES) {
      debugInput('drop', {
        transportId: connection.transportId,
        sessionId: connection.boundSubscriberId,
        reason: 'input_too_large',
        bytes,
        queueDepth: 0,
        max: TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES,
      });
      deps.sendTransportMessage(connection.transport, {
        type: 'error',
        payload: {
          message: `input payload exceeds ${TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES} bytes; client must chunk`,
          code: 'input_too_large',
        },
      });
      if (ackSeq) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: false,
          bytes,
          error: 'input_too_large',
        });
      }
      return;
    }
    debugInput('receive', {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      bytes,
      queueDepth: 0,
    });
    const inputSession = resolveCurrentSessionForInput(connection);
    if (!inputSession) {
      reportInputDrop(
        connection,
        connection.boundSubscriberId && deps.sessions.has(connection.boundSubscriberId)
          ? 'input_stale_transport'
          : 'session_required',
        bytes,
        ackSeq,
      );
      return;
    }
    if (ackSeq) {
      const existingAck = reliableInputAckCache.read(inputSession.id, ackSeq);
      if (existingAck) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: true,
          bytes: existingAck.bytes,
        });
        debugInput('write', {
          transportId: connection.transportId,
          sessionId: inputSession.id,
          sessionName: inputSession.sessionName,
          bytes: existingAck.bytes,
          duplicateSeq: ackSeq,
          queueDepth: 0,
        });
        return;
      }
    }
    const startedAt = Date.now();
    const wrote = await deps.handleInput(inputSession, data, () => {
      const current = resolveCurrentSessionForInput(connection);
      return current?.id === inputSession.id;
    });
    if (!wrote) {
      reportInputDrop(connection, 'input_stale_transport', bytes, ackSeq);
      return;
    }
    if (ackSeq) {
      reliableInputAckCache.remember(inputSession.id, ackSeq, bytes);
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: true,
        bytes,
      });
    }
    debugInput('write', {
      transportId: connection.transportId,
      sessionId: inputSession.id,
      sessionName: inputSession.sessionName,
      bytes,
      durationMs: Date.now() - startedAt,
      queueDepth: 0,
    });
  }

  async function handleInputMessage(connection: TerminalTransportConnection, payload: unknown) {
    if (typeof payload === 'string') {
      await handleTransportInput(connection, payload);
      return;
    }
    const reliablePayload = normalizeReliableInputPayload(payload);
    if (reliablePayload) {
      await handleTransportInput(connection, reliablePayload.data, reliablePayload.seq);
      return;
    }
    const invalidSeq = readReliableInputSeq(payload);
    if (invalidSeq) {
      sendInputAck(connection, {
        version: 1,
        seq: invalidSeq,
        accepted: false,
        bytes: 0,
        error: 'input_invalid',
      });
    }
    const session = resolveBoundSession(connection);
    if (!session) {
      deps.sendTransportMessage(connection.transport, {
        type: 'error',
        payload: { message: 'input requires an attached session transport', code: 'session_required' },
      });
      return;
    }
    deps.sendMessage(session, {
      type: 'error',
      payload: { message: 'invalid input payload', code: 'input_invalid' },
    });
  }

  const liveMirrorInputBatches = new Map<string, {
    items: LiveMirrorInputItem[];
    scheduled: boolean;
    flushing: boolean;
  }>();

  function sleepTmuxWriteSettleAsync() {
    if (TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      setTimeout(resolve, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS);
    });
  }

  function normalizeBackendKind(backendKind?: DaemonInputBackendKind): DaemonInputBackendKind {
    return backendKind === 'herdr' || backendKind === 'wezterm' ? backendKind : 'tmux';
  }

  function buildLiveMirrorInputGroups(items: LiveMirrorInputItem[]): LiveMirrorInputGroup[] {
    const maxGroupBytes = deps.resolveBackendInputMaxChunkBytes();
    const groups: LiveMirrorInputGroup[] = [];
    let groupPayload = '';
    let groupBytes = 0;
    const groupItems = new Set<LiveMirrorInputItem>();
    const flushGroup = (appendEnter: boolean) => {
      if (!groupPayload && groupItems.size === 0 && !appendEnter) {
        return;
      }
      groups.push({
        payload: groupPayload,
        appendEnter,
        backendKind: Array.from(groupItems)[0]?.backendKind || 'tmux',
        items: Array.from(groupItems),
      });
      groupPayload = '';
      groupBytes = 0;
      groupItems.clear();
    };

    for (const item of items) {
      // Generic backend intents share the same physical ordering queue but must
      // not be coalesced with interactive live input. Coalescing would move a
      // scheduled/file intent across a live payload or lose its write/Enter
      // boundary. They do not require a ready mirror because schedule/file
      // target a backend session that may be detached.
      if (!item.requiresReadyMirror) {
        flushGroup(false);
        const chunks = splitTerminalInputUtf8Chunks(item.payload, maxGroupBytes);
        if (chunks.length === 0) {
          groupItems.add(item);
          flushGroup(item.appendEnter);
          continue;
        }
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]!;
          groupPayload = chunk;
          groupBytes = getTerminalInputUtf8ByteLength(chunk);
          groupItems.add(item);
          flushGroup(item.appendEnter && index === chunks.length - 1);
        }
        continue;
      }

      const chunks = splitTerminalInputUtf8Chunks(item.payload, maxGroupBytes);
      if (chunks.length === 0) {
        groupItems.add(item);
        if (item.appendEnter) {
          flushGroup(true);
        }
        continue;
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const chunkBytes = getTerminalInputUtf8ByteLength(chunk);
        if (groupBytes > 0 && groupBytes + chunkBytes > maxGroupBytes) {
          flushGroup(false);
        }
        groupPayload += chunk;
        groupBytes += chunkBytes;
        groupItems.add(item);
        if (item.appendEnter && index === chunks.length - 1) {
          flushGroup(true);
        }
      }
    }

    flushGroup(false);
    return groups;
  }

  function createLiveMirrorInputGroupSettler(
    writableItems: LiveMirrorInputItem[],
    groups: LiveMirrorInputGroup[],
  ) {
    const unresolved = new Set(writableItems);
    const failedItems = new Set<LiveMirrorInputItem>();
    const pendingGroupCounts = new Map<LiveMirrorInputItem, number>();
    for (const group of groups) {
      for (const item of group.items) {
        pendingGroupCounts.set(item, (pendingGroupCounts.get(item) || 0) + 1);
      }
    }
    const settleGroup = (group: LiveMirrorInputGroup, value: boolean) => {
      for (const item of group.items) {
        if (!unresolved.has(item)) {
          continue;
        }
        if (!value) {
          failedItems.add(item);
        }
        const nextCount = (pendingGroupCounts.get(item) || 1) - 1;
        if (nextCount > 0) {
          pendingGroupCounts.set(item, nextCount);
          continue;
        }
        pendingGroupCounts.delete(item);
        unresolved.delete(item);
        item.resolve(!failedItems.has(item));
      }
    };
    return {
      unresolved,
      settleGroup,
    };
  }

  async function flushPendingLiveMirrorInput(mirrorKey: string) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return;
    }
    if (pending.flushing) {
      return;
    }
    pending.scheduled = false;
    pending.flushing = true;
    const items = pending.items.splice(0);
    const mirror = deps.mirrors.get(mirrorKey);

    const writableItems: typeof items = [];
    for (const item of items) {
      if (item.requiresReadyMirror && (!mirror || mirror.lifecycle !== 'ready')) {
        item.resolve(false);
        continue;
      }
      if (item.shouldWrite && !item.shouldWrite()) {
        item.resolve(false);
        continue;
      }
      writableItems.push(item);
    }

    if (writableItems.length === 0) {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }

    const groups = buildLiveMirrorInputGroups(writableItems);
    const { unresolved, settleGroup } = createLiveMirrorInputGroupSettler(writableItems, groups);
    const isGroupWritable = (group: LiveMirrorInputGroup) =>
      group.items.every((item) => !item.shouldWrite || item.shouldWrite());

    if (groups.length === 0) {
      for (const item of unresolved) {
        item.resolve(true);
      }
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }

    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex]!;
        if (!isGroupWritable(group)) {
          settleGroup(group, false);
          continue;
        }
        await deps.writeBackendInputGroup(
          group.items[0]!.sessionName,
          group.payload,
          group.appendEnter,
          group.backendKind,
        );
        settleGroup(group, true);
        if (groupIndex < groups.length - 1) {
          await sleepTmuxWriteSettleAsync();
        }
      }
    } catch (error) {
      for (const item of unresolved) {
        item.reject(error);
      }
    } finally {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
    }
  }

  function schedulePendingLiveMirrorInput(mirrorKey: string) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending || pending.scheduled || pending.flushing) {
      return;
    }
    pending.scheduled = true;
    queueMicrotask(() => flushPendingLiveMirrorInput(mirrorKey));
  }

  function enqueueLiveMirrorInput(
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
    backendKind?: DaemonInputBackendKind,
  ) {
    const normalizedBackend = normalizeBackendKind(backendKind);
    const mirrorKey = deps.getMirrorKey(sessionName, normalizedBackend === 'herdr' ? 'herdr' : 'tmux');
    return enqueueInputItem(mirrorKey, {
      sessionName,
      payload,
      appendEnter,
      backendKind: normalizedBackend,
      requiresReadyMirror: true,
      shouldWrite,
    });
  }

  function enqueueBackendInput(
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backendKind?: DaemonInputBackendKind,
  ) {
    const normalizedBackend = normalizeBackendKind(backendKind);
    const mirrorKey = deps.getMirrorKey(sessionName, normalizedBackend === 'herdr' ? 'herdr' : 'tmux');
    return enqueueInputItem(mirrorKey, {
      sessionName,
      payload,
      appendEnter,
      backendKind: normalizedBackend,
      requiresReadyMirror: false,
    });
  }

  function enqueueInputItem(
    mirrorKey: string,
    item: Omit<LiveMirrorInputItem, 'resolve' | 'reject'>,
  ) {
    let pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      pending = {
        items: [],
        scheduled: false,
        flushing: false,
      };
      liveMirrorInputBatches.set(mirrorKey, pending);
    }
    const result = new Promise<boolean>((resolve, reject) => {
      pending?.items.push({ ...item, resolve, reject });
    });
    schedulePendingLiveMirrorInput(mirrorKey);
    return result;
  }

  // R3 closeout: callers must evict pending items on transport close, mirror
  // destroy, or session detach. In-flight writes resolve through their own
  // backend promise; queued items must not survive into a future attach.
  function disposeLiveMirrorInputBatch(
    sessionName: string,
    reason: string,
    backendKind?: DaemonInputBackendKind,
  ) {
    const mirrorKey = deps.getMirrorKey(sessionName, backendKind === 'herdr' ? 'herdr' : 'tmux');
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return 0;
    }
    let evicted = 0;
    if (!pending.flushing) {
      const items = pending.items.splice(0);
      for (const item of items) {
        if (item.requiresReadyMirror) {
          item.resolve(false);
          evicted += 1;
        } else {
          pending.items.push(item);
        }
      }
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
    } else {
      const remaining = pending.items.splice(0);
      for (const item of remaining) {
        if (item.requiresReadyMirror) {
          item.resolve(false);
          evicted += 1;
        } else {
          pending.items.push(item);
        }
      }
    }
    deps.daemonRuntimeDebug?.('input-dispose', {
      mirrorKey,
      reason,
      evicted,
    });
    return evicted;
  }

  return {
    handleInputMessage,
    enqueueBackendInput,
    enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch,
  };
}

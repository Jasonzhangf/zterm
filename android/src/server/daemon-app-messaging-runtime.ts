import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  APP_ACKED_RETENTION_MS,
  APP_CAPABILITIES,
  APP_FILE_CHUNK_BYTES,
  APP_MAX_INBOX_BYTES,
  APP_MAX_INBOX_RECORDS,
  APP_PROTOCOL_VERSION,
  AppProtocolError,
  appErrorPayload,
  validateAppFileMetadata,
  validateAppServerFrame,
  validateAppTarget,
  validateMessageBody,
  validateSafeFileName,
  type AppClientFrame,
  type AppErrorCode,
  type AppInboundFilePayload,
  type AppInboundMessagePayload,
  type AppRecordState,
  type AppSendFileChunkPayload,
  type AppSendFileCommitPayload,
  type AppSendFileStartPayload,
  type AppSendMessagePayload,
  type AppServerFrame,
  type AppStatusResultPayload,
  type AppTarget,
} from '@zterm/shared/app-protocol';
import {
  DaemonAppMessagingStore,
  AppStoreError,
  type AppInboxRecord,
  type AppOutboxRecord,
  type AppStagingMetadata,
} from './daemon-app-messaging-store';

export interface AppLink {
  id: string;
  role: 'local' | 'peer';
  deviceId: string;
  daemonHostId: string;
  clientInstanceId?: string;
  send: (frame: AppServerFrame) => boolean;
  close: (reason: string, code?: number) => void;
}

export interface DaemonAppMessagingRuntimeOptions {
  appRootDir: string;
  deviceId: string;
  daemonHostId: string;
  now?: () => number;
  maxInboxRecords?: number;
  maxInboxBytes?: number;
  peerRequestTimeoutMs?: number;
  retentionMs?: number;
  retentionIntervalMs?: number;
  createWebSocket?: (url: string, authToken: string) => WebSocket;
}

export interface DaemonAppMessagingRuntime {
  initialize: () => Promise<void>;
  dispose: () => void;
  getInitializationError: () => Error | null;
  getCapabilities: () => typeof APP_CAPABILITIES;
  getIdentity: () => { deviceId: string; daemonHostId: string };
  handleFrame: (link: AppLink, frame: AppClientFrame) => Promise<{ settled: boolean; messageId?: string; senderDaemonHostId?: string }>;
  subscribeLocal: (link: AppLink) => Promise<void>;
  revokeLink: (linkId: string) => void;
}

type PendingPeerRequest = {
  resolve: (frame: AppServerFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settlement: { code: AppErrorCode; afterSend: boolean };
};

type PeerLink = {
  key: string;
  target: AppTarget;
  ws: WebSocket;
  ready: boolean;
  closed: boolean;
  pending: Map<string, PendingPeerRequest>;
};

class PeerLinkError extends Error {
  readonly code: AppErrorCode;
  readonly afterSend: boolean;

  constructor(code: AppErrorCode, message: string, afterSend: boolean) {
    super(message);
    this.name = 'PeerLinkError';
    this.code = code;
    this.afterSend = afterSend;
  }
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString();
}

function decodeStrictBase64(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppProtocolError({ code: 'invalid_chunk', message: 'chunk data is empty', stage: 'file-chunk' });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AppProtocolError({ code: 'invalid_chunk', message: 'chunk data is not strict base64', stage: 'file-chunk' });
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) {
    throw new AppProtocolError({ code: 'invalid_chunk', message: 'chunk data decoded lossily', stage: 'file-chunk' });
  }
  return buffer;
}

function sameMessageContent(record: AppInboxRecord, payload: AppSendMessagePayload): boolean {
  return record.kind === 'message' && record.subject === payload.subject && record.body === payload.body;
}

function sameFileContent(record: AppInboxRecord, payload: AppSendFileStartPayload): boolean {
  return record.kind === 'file'
    && record.subject === payload.subject
    && record.file?.transferId === payload.file.transferId
    && record.file.fileName === payload.file.fileName
    && record.file.totalBytes === payload.file.totalBytes
    && record.file.chunkCount === payload.file.chunkCount
    && record.file.sha256 === payload.file.sha256;
}

function sameOutboxMessage(record: AppOutboxRecord, payload: AppSendMessagePayload): boolean {
  return record.kind === 'message' && record.subject === payload.subject && record.body === payload.body;
}

function sameOutboxFile(record: AppOutboxRecord, payload: AppSendFileStartPayload): boolean {
  return record.kind === 'file'
    && record.subject === payload.subject
    && record.file?.transferId === payload.file.transferId
    && record.file.fileName === payload.file.fileName
    && record.file.totalBytes === payload.file.totalBytes
    && record.file.chunkCount === payload.file.chunkCount
    && record.file.sha256 === payload.file.sha256;
}

function inboundMessageFrame(record: AppInboxRecord): AppServerFrame {
  const payload: AppInboundMessagePayload = {
    messageId: record.messageId,
    senderDeviceId: record.senderDeviceId,
    senderDaemonHostId: record.senderDaemonHostId,
    receiverDeviceId: record.receiverDeviceId,
    receiverDaemonHostId: record.receiverDaemonHostId,
    subject: record.subject,
    body: record.body ?? '',
    state: record.state,
    receivedAt: record.receivedAt,
  };
  return { type: 'app-inbound-message', payload };
}

function inboundFileFrame(record: AppInboxRecord): AppServerFrame | null {
  if (!record.file) return null;
  const payload: AppInboundFilePayload = {
    messageId: record.messageId,
    transferId: record.file.transferId,
    senderDeviceId: record.senderDeviceId,
    senderDaemonHostId: record.senderDaemonHostId,
    receiverDeviceId: record.receiverDeviceId,
    receiverDaemonHostId: record.receiverDaemonHostId,
    subject: record.subject,
    fileName: record.file.fileName,
    totalBytes: record.file.totalBytes,
    sha256: record.file.sha256,
    absolutePath: record.file.absolutePath,
    state: record.state,
    receivedAt: record.receivedAt,
  };
  return { type: 'app-inbound-file', payload };
}

function recordStatusPayload(record: AppInboxRecord, requestId: string): AppStatusResultPayload {
  return {
    requestId,
    messageId: record.messageId,
    found: true,
    kind: 'inbox',
    senderDaemonHostId: record.senderDaemonHostId,
    state: record.state,
    transferId: record.file?.transferId,
    absolutePath: record.file?.absolutePath,
  };
}

function outboxStatusPayload(record: AppOutboxRecord, requestId: string): AppStatusResultPayload {
  return {
    requestId,
    messageId: record.messageId,
    found: true,
    kind: 'outbox',
    targetDaemonHostId: record.targetDaemonHostId,
    transferId: record.file?.transferId,
    state: record.state === 'received' ? 'received' : 'rejected',
    outboxState: record.state,
  };
}

function frameRequestId(frame: AppClientFrame): string | undefined {
  return 'requestId' in frame.payload && typeof frame.payload.requestId === 'string'
    ? frame.payload.requestId
    : undefined;
}

export function createDaemonAppMessagingRuntime(
  options: DaemonAppMessagingRuntimeOptions,
): DaemonAppMessagingRuntime {
  const now = options.now ?? (() => Date.now());
  const retentionMs = options.retentionMs ?? APP_ACKED_RETENTION_MS;
  const peerRequestTimeoutMs = options.peerRequestTimeoutMs ?? 15_000;
  const store = new DaemonAppMessagingStore({
    appRootDir: options.appRootDir,
    maxInboxRecords: options.maxInboxRecords ?? APP_MAX_INBOX_RECORDS,
    maxInboxBytes: options.maxInboxBytes ?? APP_MAX_INBOX_BYTES,
  });
  const subscribers = new Map<string, AppLink>();
  const peerLinks = new Map<string, PeerLink>();
  const activeFileSends = new Map<string, { target: AppTarget; link?: PeerLink; messageId: string }>();
  let initialized = false;
  let initializationError: Error | null = null;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;

  const createSocket = options.createWebSocket ?? ((url: string, authToken: string) => new WebSocket(url, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  }));

  function sendError(link: AppLink, error: unknown, requestId?: string, messageId?: string, transferId?: string) {
    const code: AppErrorCode = error instanceof AppProtocolError || error instanceof PeerLinkError
      ? error.code
      : error instanceof AppStoreError
        ? (error.code === 'storage_inconsistent' ? 'storage_error' : error.code)
        : 'internal_error';
    const stage = error instanceof AppProtocolError ? error.stage : 'execute';
    const message = error instanceof Error ? error.message : String(error);
    link.send({
      type: 'app-error',
      payload: appErrorPayload({
        code,
        stage,
        message,
        requestId,
        messageId,
        transferId,
      }),
    });
  }

  function notifySubscribers(frame: AppServerFrame) {
    for (const [id, subscriber] of [...subscribers]) {
      if (!subscriber.send(frame)) {
        subscribers.delete(id);
        subscriber.close('slow_consumer', 4008);
      }
    }
  }

  function publishRecord(record: AppInboxRecord) {
    const frame = record.kind === 'file' ? inboundFileFrame(record) : inboundMessageFrame(record);
    if (frame) notifySubscribers(frame);
  }

  function notifyPeerState(state: 'peer-connected' | 'peer-disconnected', daemonHostId: string) {
    notifySubscribers({
      type: 'app-connection-state',
      payload: {
        requestId: `event-${randomUUID()}`,
        state,
        daemonHostId,
      },
    });
  }

  async function closePeerLink(peer: PeerLink, reason: string) {
    if (peer.closed) return;
    peer.closed = true;
    peerLinks.delete(peer.key);
    for (const pending of peer.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PeerLinkError(pending.settlement.code, reason, pending.settlement.afterSend));
    }
    peer.pending.clear();
    try {
      peer.ws.close(1000, reason);
    } catch {
      // The socket may already be closed.
    }
    notifyPeerState('peer-disconnected', peer.target.daemonHostId);
  }

  async function connectPeer(target: AppTarget): Promise<PeerLink> {
    const key = `${target.daemonHostId}\u0000${target.wsUrl}`;
    const existing = peerLinks.get(key);
    if (existing && !existing.closed && existing.ws.readyState === WebSocket.OPEN && existing.ready) {
      if (await probePeerLink(existing)) {
        return existing;
      }
      await closePeerLink(existing, 'peer liveness probe failed');
    }

    const ws = createSocket(target.wsUrl, target.authToken);
    const peer: PeerLink = {
      key,
      target,
      ws,
      ready: false,
      closed: false,
      pending: new Map(),
    };
    peerLinks.set(key, peer);

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
        const frame = validateAppServerFrame(parsed);
        handlePeerFrame(peer, frame);
      } catch (error) {
        const requestId = resolvePeerRequestIdFromRaw(raw);
        for (const [id, pending] of [...peer.pending]) {
          if (requestId === undefined || id === requestId) {
            clearTimeout(pending.timer);
            peer.pending.delete(id);
            pending.reject(new PeerLinkError(
              'invalid_frame',
              `peer returned an invalid frame: ${error instanceof Error ? error.message : String(error)}`,
              false,
            ));
          }
        }
      }
    });
    ws.on('close', () => {
      void closePeerLink(peer, 'peer closed');
    });
    ws.on('error', (error) => {
      void closePeerLink(peer, error.message);
    });

    const helloRequestId = `hello-${randomUUID()}`;
    const ready = await new Promise<AppServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(helloRequestId);
        reject(new PeerLinkError('unreachable', 'peer handshake timed out', false));
      }, peerRequestTimeoutMs);
      peer.pending.set(helloRequestId, {
        resolve,
        reject,
        timer,
        settlement: { code: 'unreachable', afterSend: false },
      });
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'app-hello',
          payload: {
            protocolVersion: APP_PROTOCOL_VERSION,
            requestId: helloRequestId,
            role: 'peer',
            clientInstanceId: `daemon-${randomUUID()}`,
            deviceId: options.deviceId,
            daemonHostId: options.daemonHostId,
            capabilities: {},
          },
        }));
      });
      ws.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        peer.pending.delete(helloRequestId);
        reject(new PeerLinkError(
          response.statusCode === 401 ? 'unauthorized' : 'unreachable',
          `peer upgrade rejected with HTTP ${response.statusCode}`,
          false,
        ));
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        peer.pending.delete(helloRequestId);
        reject(new PeerLinkError('unreachable', error.message, false));
      });
    }).catch(async (error: unknown) => {
      await closePeerLink(peer, error instanceof Error ? error.message : 'peer handshake failed');
      throw error;
    });

    if (
      ready.type !== 'app-ready'
      || ready.payload.protocolVersion !== APP_PROTOCOL_VERSION
      || ready.payload.daemonHostId !== target.daemonHostId
      || ready.payload.deviceId !== target.deviceId
    ) {
      await closePeerLink(peer, 'peer identity or version mismatch');
      throw new PeerLinkError('unreachable', 'peer returned a different daemon identity or protocol version', false);
    }
    notifyPeerState('peer-connected', target.daemonHostId);
    return peer;
  }

  function resolvePeerRequestIdFromRaw(raw: WebSocket.RawData): unknown {
    try {
      const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const payload = (parsed as { payload?: unknown }).payload;
        if (payload && typeof payload === 'object') {
          return (payload as { requestId?: unknown }).requestId;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function handlePeerFrame(peer: PeerLink, frame: AppServerFrame) {
      const requestId = 'payload' in frame && frame.payload && typeof frame.payload === 'object'
        ? (frame.payload as { requestId?: unknown }).requestId
        : undefined;
      if (frame.type === 'app-ready' && typeof requestId === 'string') {
        const pending = peer.pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          peer.pending.delete(requestId);
          peer.ready = true;
          pending.resolve(frame);
        }
        return;
      }
      if (typeof requestId !== 'string') return;
      const pending = peer.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      peer.pending.delete(requestId);
      pending.resolve(frame);
  }

  async function probePeerLink(peer: PeerLink): Promise<boolean> {
    if (peer.closed || peer.ws.readyState !== WebSocket.OPEN || !peer.ready) return false;
    const requestId = `probe-${randomUUID()}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          peer.pending.delete(requestId);
          reject(new PeerLinkError('unreachable', 'peer liveness probe timed out', false));
        }, peerRequestTimeoutMs);
        const pending: PendingPeerRequest = {
          resolve: (frame) => {
            if (frame.type === 'app-pong' && frame.payload.requestId === requestId) {
              resolve();
              return;
            }
            reject(new PeerLinkError('unreachable', 'peer liveness probe returned an unexpected frame', false));
          },
          reject,
          timer,
          settlement: { code: 'unreachable', afterSend: false },
        };
        peer.pending.set(requestId, pending);
        try {
          peer.ws.send(JSON.stringify({
            type: 'app-ping',
            payload: { requestId, sentAt: now() },
          }));
        } catch (error) {
          clearTimeout(timer);
          peer.pending.delete(requestId);
          reject(new PeerLinkError('unreachable', error instanceof Error ? error.message : 'peer liveness probe send failed', false));
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  async function peerRequest(peer: PeerLink, frame: AppClientFrame): Promise<AppServerFrame> {
    if (peer.closed || peer.ws.readyState !== WebSocket.OPEN) {
      throw new PeerLinkError('unreachable', 'peer transport is closed', false);
    }
    const requestId = frameRequestId(frame);
    if (!requestId) {
      throw new AppProtocolError({ code: 'invalid_frame', message: 'requestId is required', stage: 'peer' });
    }
    return new Promise<AppServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(requestId);
        reject(new PeerLinkError('result_unknown', 'peer receipt timed out', true));
      }, peerRequestTimeoutMs);
      peer.pending.set(requestId, {
        resolve,
        reject,
        timer,
        settlement: { code: 'result_unknown', afterSend: true },
      });
      try {
        peer.ws.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        peer.pending.delete(requestId);
        reject(new PeerLinkError('result_unknown', error instanceof Error ? error.message : 'peer send failed', true));
      }
    });
  }

  function peerResultFrame(
    requestId: string,
    messageId: string,
    status: 'received' | 'receiving' | 'resultUnknown' | 'rejected',
    stage: 'prepared' | 'sent' | 'received' | 'result_unknown',
    extra?: { transferId?: string; persistedOffset?: number; absolutePath?: string },
  ): AppServerFrame {
    return {
      type: 'app-send-result',
      payload: {
        requestId,
        messageId,
        ...(extra?.transferId ? { transferId: extra.transferId } : {}),
        status,
        stage,
        ...(extra?.persistedOffset !== undefined ? { persistedOffset: extra.persistedOffset } : {}),
      },
    };
  }

  async function prepareMessageOutbox(payload: AppSendMessagePayload): Promise<AppOutboxRecord> {
    const target = validateAppTarget(payload.target, 'send-message');
    const record: AppOutboxRecord = {
      schemaVersion: 1,
      targetDeviceId: target.deviceId,
      targetDaemonHostId: target.daemonHostId,
      messageId: payload.messageId,
      kind: 'message',
      subject: payload.subject,
      body: payload.body,
      state: 'pending',
      updatedAt: nowIso(now),
    };
    await store.runExclusive(async () => {
      const existing = await store.readOutboxRecord(target.daemonHostId, payload.messageId);
      if (existing && existing.kind !== 'message') {
        throw new AppProtocolError({ code: 'message_id_conflict', message: 'messageId collision', stage: 'outbox', messageId: payload.messageId });
      }
      if (existing && !sameOutboxMessage(existing, payload)) {
        throw new AppProtocolError({ code: 'message_id_conflict', message: 'messageId content conflict', stage: 'outbox', messageId: payload.messageId });
      }
      if (existing?.state === 'received') return;
      await store.writeOutboxRecord(record);
    });
    return store.readOutboxRecord(target.daemonHostId, payload.messageId) as Promise<AppOutboxRecord>;
  }

  async function prepareFileOutbox(payload: AppSendFileStartPayload): Promise<AppOutboxRecord> {
    const target = validateAppTarget(payload.target, 'file-start');
    const record: AppOutboxRecord = {
      schemaVersion: 1,
      targetDeviceId: target.deviceId,
      targetDaemonHostId: target.daemonHostId,
      messageId: payload.messageId,
      kind: 'file',
      subject: payload.subject,
      file: payload.file,
      state: 'pending',
      updatedAt: nowIso(now),
    };
    await store.runExclusive(async () => {
      const existing = await store.readOutboxRecord(target.daemonHostId, payload.messageId);
      if (existing && existing.kind !== 'file') {
        throw new AppProtocolError({ code: 'message_id_conflict', message: 'messageId collision', stage: 'outbox', messageId: payload.messageId });
      }
      if (existing && !sameOutboxFile(existing, payload)) {
        throw new AppProtocolError({ code: 'message_id_conflict', message: 'messageId content conflict', stage: 'outbox', messageId: payload.messageId });
      }
      if (existing?.state === 'received') return;
      await store.writeOutboxRecord(record);
    });
    return store.readOutboxRecord(target.daemonHostId, payload.messageId) as Promise<AppOutboxRecord>;
  }

  async function updateOutbox(
    targetDaemonHostId: string,
    messageId: string,
    state: AppOutboxRecord['state'],
    lastError?: string,
  ) {
    await store.runExclusive(async () => {
      const existing = await store.readOutboxRecord(targetDaemonHostId, messageId);
      if (!existing) return;
      await store.writeOutboxRecord({
        ...existing,
        state,
        ...(lastError ? { lastError } : { lastError: undefined }),
        updatedAt: nowIso(now),
      });
    });
  }

  async function sendMessageFromLocal(link: AppLink, payload: AppSendMessagePayload) {
    const target = validateAppTarget(payload.target, 'send-message');
    const body = validateMessageBody(payload.body);
    await prepareMessageOutbox({ ...payload, target, body });
    const outbox = await store.readOutboxRecord(target.daemonHostId, payload.messageId);
    if (outbox?.state === 'received') {
      link.send(peerResultFrame(payload.requestId, payload.messageId, 'received', 'received'));
      return;
    }

    try {
      if (target.daemonHostId === options.daemonHostId) {
        const result = await receiveMessage(
          { deviceId: options.deviceId, daemonHostId: options.daemonHostId },
          { ...payload, body },
        );
        await updateOutbox(target.daemonHostId, payload.messageId, result === 'received' || result === 'delivered' || result === 'consumed' ? 'received' : 'failed');
        link.send(peerResultFrame(payload.requestId, payload.messageId, result === 'rejected' ? 'rejected' : 'received', 'received'));
        return;
      }
      const peer = await connectPeer(target);
      const response = await peerRequest(peer, {
        type: 'app-send-message',
        payload: {
          requestId: payload.requestId,
          messageId: payload.messageId,
          subject: payload.subject,
          body,
        },
      });
      if (response.type === 'app-error') {
        await updateOutbox(target.daemonHostId, payload.messageId, 'failed', response.payload.code);
        link.send(response);
        return;
      }
      if (response.type !== 'app-send-result') {
        await updateOutbox(target.daemonHostId, payload.messageId, 'result_unknown', 'unexpected peer response');
        link.send(peerResultFrame(payload.requestId, payload.messageId, 'resultUnknown', 'result_unknown'));
        return;
      }
      const state = response.payload.status === 'received' || response.payload.status === 'delivered' || response.payload.status === 'consumed'
        ? 'received'
        : response.payload.status === 'rejected'
          ? 'failed'
          : 'result_unknown';
      await updateOutbox(target.daemonHostId, payload.messageId, state);
      link.send({ ...response, payload: { ...response.payload, requestId: payload.requestId } });
    } catch (error) {
      if (error instanceof PeerLinkError) {
        const state = error.afterSend ? 'result_unknown' : 'failed';
        await updateOutbox(target.daemonHostId, payload.messageId, state, error.code);
        if (error.code === 'result_unknown') {
          link.send(peerResultFrame(payload.requestId, payload.messageId, 'resultUnknown', 'result_unknown'));
        } else {
          sendError(link, error, payload.requestId, payload.messageId);
        }
        return;
      }
      await updateOutbox(target.daemonHostId, payload.messageId, 'failed', error instanceof Error ? error.message : 'send failed');
      sendError(link, error, payload.requestId, payload.messageId);
    }
  }

  async function sendFileStartFromLocal(link: AppLink, payload: AppSendFileStartPayload) {
    const target = validateAppTarget(payload.target, 'file-start');
    const file = validateAppFileMetadata(payload.file, 'file-start');
    await prepareFileOutbox({ ...payload, target, file });
    const outbox = await store.readOutboxRecord(target.daemonHostId, payload.messageId);
    if (outbox?.state === 'received') {
      link.send(peerResultFrame(payload.requestId, payload.messageId, 'received', 'received', { transferId: file.transferId }));
      return;
    }
    try {
      if (target.daemonHostId === options.daemonHostId) {
        const result = await receiveFileStart(
          { deviceId: options.deviceId, daemonHostId: options.daemonHostId },
          { ...payload, file },
        );
        if (result.type === 'app-send-result' && result.payload.status === 'receiving') {
          activeFileSends.set(file.transferId, {
            target,
            messageId: payload.messageId,
          });
        }
        link.send(result);
        return;
      }
      const peer = await connectPeer(target);
      activeFileSends.set(file.transferId, { target, link: peer, messageId: payload.messageId });
      const response = await peerRequest(peer, {
        type: 'app-send-file-start',
        payload: {
          requestId: payload.requestId,
          messageId: payload.messageId,
          subject: payload.subject,
          file,
        },
      });
      if (response.type === 'app-error') {
        activeFileSends.delete(file.transferId);
        await updateOutbox(target.daemonHostId, payload.messageId, 'failed', response.payload.code);
      }
      link.send(response);
    } catch (error) {
      activeFileSends.delete(file.transferId);
      if (error instanceof PeerLinkError) {
        const state = error.afterSend ? 'result_unknown' : 'failed';
        await updateOutbox(target.daemonHostId, payload.messageId, state, error.code);
        if (error.code === 'result_unknown') {
          link.send(peerResultFrame(payload.requestId, payload.messageId, 'resultUnknown', 'result_unknown', { transferId: file.transferId }));
        } else {
          sendError(link, error, payload.requestId, payload.messageId, file.transferId);
        }
        return;
      }
      await updateOutbox(target.daemonHostId, payload.messageId, 'failed', error instanceof Error ? error.message : 'file start failed');
      sendError(link, error, payload.requestId, payload.messageId, file.transferId);
    }
  }

  async function forwardFileChunk(link: AppLink, payload: AppSendFileChunkPayload) {
    const active = activeFileSends.get(payload.transferId);
    if (!active) {
      sendError(
        link,
        new AppProtocolError({ code: 'invalid_state', message: 'file transfer is not active; restart with file-start', stage: 'file-chunk', transferId: payload.transferId }),
        payload.requestId,
        payload.messageId,
        payload.transferId,
      );
      return;
    }
    try {
      if (active.target.daemonHostId === options.daemonHostId) {
        const response = await receiveFileChunk(
          { deviceId: options.deviceId, daemonHostId: options.daemonHostId },
          payload,
        );
        link.send(response);
        return;
      }
      if (!active.link) {
        throw new AppProtocolError({ code: 'invalid_state', message: 'peer transport is not active', stage: 'file-chunk', transferId: payload.transferId });
      }
      const response = await peerRequest(active.link, { type: 'app-send-file-chunk', payload });
      if (response.type === 'app-error') {
        await updateOutbox(active.target.daemonHostId, payload.messageId, 'failed', response.payload.code);
      }
      link.send(response);
    } catch (error) {
      if (error instanceof PeerLinkError) {
        const state = error.afterSend ? 'result_unknown' : 'failed';
        await updateOutbox(active.target.daemonHostId, payload.messageId, state, error.code);
        if (error.code === 'result_unknown') {
          link.send(peerResultFrame(payload.requestId, payload.messageId, 'resultUnknown', 'result_unknown', { transferId: payload.transferId }));
        } else {
          sendError(link, error, payload.requestId, payload.messageId, payload.transferId);
        }
        return;
      }
      await updateOutbox(active.target.daemonHostId, payload.messageId, 'failed', error instanceof Error ? error.message : 'file chunk failed');
      sendError(link, error, payload.requestId, payload.messageId, payload.transferId);
    }
  }

  async function forwardFileCommit(link: AppLink, payload: AppSendFileCommitPayload) {
    const active = activeFileSends.get(payload.transferId);
    if (!active) {
      sendError(
        link,
        new AppProtocolError({ code: 'invalid_state', message: 'file transfer is not active; restart with file-start', stage: 'file-commit', transferId: payload.transferId }),
        payload.requestId,
        payload.messageId,
        payload.transferId,
      );
      return;
    }
    try {
      if (active.target.daemonHostId === options.daemonHostId) {
        const response = await receiveFileCommit(
          { deviceId: options.deviceId, daemonHostId: options.daemonHostId },
          payload,
        );
        if (response.type === 'app-send-result' && (response.payload.status === 'received' || response.payload.status === 'delivered' || response.payload.status === 'consumed')) {
          await updateOutbox(active.target.daemonHostId, payload.messageId, 'received');
          activeFileSends.delete(payload.transferId);
        }
        link.send(response);
        return;
      }
      if (!active.link) {
        throw new AppProtocolError({ code: 'invalid_state', message: 'peer transport is not active', stage: 'file-commit', transferId: payload.transferId });
      }
      const response = await peerRequest(active.link, { type: 'app-send-file-commit', payload });
      if (response.type === 'app-error') {
        await updateOutbox(active.target.daemonHostId, payload.messageId, 'failed', response.payload.code);
        link.send(response);
        return;
      }
      if (response.type === 'app-send-result' && (response.payload.status === 'received' || response.payload.status === 'delivered' || response.payload.status === 'consumed')) {
        await updateOutbox(active.target.daemonHostId, payload.messageId, 'received');
        activeFileSends.delete(payload.transferId);
      }
      link.send(response);
    } catch (error) {
      if (error instanceof PeerLinkError) {
        const state = error.afterSend ? 'result_unknown' : 'failed';
        await updateOutbox(active.target.daemonHostId, payload.messageId, state, error.code);
        if (error.code === 'result_unknown') {
          link.send(peerResultFrame(payload.requestId, payload.messageId, 'resultUnknown', 'result_unknown', { transferId: payload.transferId }));
        } else {
          sendError(link, error, payload.requestId, payload.messageId, payload.transferId);
        }
        return;
      }
      await updateOutbox(active.target.daemonHostId, payload.messageId, 'failed', error instanceof Error ? error.message : 'file commit failed');
      sendError(link, error, payload.requestId, payload.messageId, payload.transferId);
    }
  }

  async function receiveMessage(
    sender: { deviceId: string; daemonHostId: string },
    payload: AppSendMessagePayload,
  ): Promise<AppRecordState> {
    const body = validateMessageBody(payload.body);
    return store.runExclusive(async () => {
      const existing = await store.readInboxRecord(sender.daemonHostId, payload.messageId);
      if (existing) {
        if (!sameMessageContent(existing, { ...payload, body })) {
          throw new AppProtocolError({
            code: 'message_id_conflict',
            message: 'messageId already exists with different content',
            stage: 'inbound',
            messageId: payload.messageId,
          });
        }
        return existing.state;
      }
      if (await store.hasStagingKey(sender.daemonHostId, payload.messageId)) {
        throw new AppProtocolError({
          code: 'message_id_conflict',
          message: 'messageId is already being received as a file transfer',
          stage: 'inbound',
          messageId: payload.messageId,
        });
      }
      const record: AppInboxRecord = {
        schemaVersion: 1,
        senderDeviceId: sender.deviceId,
        senderDaemonHostId: sender.daemonHostId,
        receiverDeviceId: options.deviceId,
        receiverDaemonHostId: options.daemonHostId,
        messageId: payload.messageId,
        kind: 'message',
        subject: payload.subject,
        body,
        state: 'received',
        receivedAt: nowIso(now),
      };
      await store.admitInboxRecord(record, Buffer.byteLength(body, 'utf8'));
      publishRecord(record);
      return record.state;
    });
  }

  async function receiveFileStart(
    sender: { deviceId: string; daemonHostId: string },
    payload: AppSendFileStartPayload,
  ): Promise<AppServerFrame> {
    const file = validateAppFileMetadata(payload.file, 'file-start');
    return store.runExclusive(async () => {
      const existingRecord = await store.readInboxRecord(sender.daemonHostId, payload.messageId);
      if (existingRecord) {
        if (!sameFileContent(existingRecord, { ...payload, file })) {
          throw new AppProtocolError({
            code: 'message_id_conflict',
            message: 'messageId already exists with a different file',
            stage: 'inbound-file',
            messageId: payload.messageId,
          });
        }
        return peerResultFrame(payload.requestId, payload.messageId, existingRecord.state === 'received' ? 'received' : existingRecord.state === 'rejected' ? 'rejected' : 'received', 'received', {
          transferId: file.transferId,
        });
      }
      const sameKeyStaging = await store.findStagingKey(sender.daemonHostId, payload.messageId);
      if (sameKeyStaging && sameKeyStaging.transferId !== file.transferId) {
        throw new AppProtocolError({
          code: 'message_id_conflict',
          message: 'messageId is already being received as a different transfer',
          stage: 'inbound-file',
          messageId: payload.messageId,
        });
      }
      const existingStaging = await store.readStagingMetadata(sender.daemonHostId, file.transferId);
      if (existingStaging) {
        const matches = existingStaging.messageId === payload.messageId
          && existingStaging.fileName === file.fileName
          && existingStaging.totalBytes === file.totalBytes
          && existingStaging.chunkCount === file.chunkCount
          && existingStaging.sha256 === file.sha256;
        if (!matches) {
          throw new AppProtocolError({
            code: 'transfer_conflict',
            message: 'transferId already exists with different metadata',
            stage: 'inbound-file',
            transferId: file.transferId,
          });
        }
        return peerResultFrame(payload.requestId, payload.messageId, 'receiving', 'prepared', {
          transferId: file.transferId,
          persistedOffset: existingStaging.persistedOffset,
        });
      }
      const usage = await store.computeInboxUsage();
      if (
        usage.records + 1 > (options.maxInboxRecords ?? APP_MAX_INBOX_RECORDS)
        || usage.bytes + file.totalBytes > (options.maxInboxBytes ?? APP_MAX_INBOX_BYTES)
      ) {
        throw new AppStoreError('inbox_full', 'durable inbox capacity would be exceeded by this file');
      }
      const metadata: AppStagingMetadata = {
        schemaVersion: 1,
        senderDaemonHostId: sender.daemonHostId,
        senderDeviceId: sender.deviceId,
        receiverDeviceId: options.deviceId,
        receiverDaemonHostId: options.daemonHostId,
        transferId: file.transferId,
        messageId: payload.messageId,
        subject: payload.subject,
        fileName: file.fileName,
        totalBytes: file.totalBytes,
        chunkCount: file.chunkCount,
        sha256: file.sha256,
        reservedBytes: file.totalBytes,
        persistedOffset: 0,
        phase: 'open',
      };
      await store.openStagingPart(metadata);
      return peerResultFrame(payload.requestId, payload.messageId, 'receiving', 'prepared', {
        transferId: file.transferId,
        persistedOffset: 0,
      });
    });
  }

  async function receiveFileChunk(
    sender: { deviceId: string; daemonHostId: string },
    payload: AppSendFileChunkPayload,
  ): Promise<AppServerFrame> {
    const data = decodeStrictBase64(payload.dataBase64);
    return store.runExclusive(async () => {
      const metadata = await store.readStagingMetadata(sender.daemonHostId, payload.transferId);
      if (!metadata) {
        throw new AppProtocolError({
          code: 'not_found',
          message: 'transfer staging record not found',
          stage: 'inbound-file',
          transferId: payload.transferId,
        });
      }
      if (metadata.messageId !== payload.messageId) {
        throw new AppProtocolError({
          code: 'transfer_conflict',
          message: 'transferId belongs to another message',
          stage: 'inbound-file',
          transferId: payload.transferId,
        });
      }
      const expectedOffset = payload.chunkIndex * APP_FILE_CHUNK_BYTES;
      const isLast = payload.chunkIndex === metadata.chunkCount - 1;
      const expectedLength = isLast
        ? metadata.totalBytes - expectedOffset
        : APP_FILE_CHUNK_BYTES;
      if (
        payload.offset !== expectedOffset
        || payload.chunkIndex < 0
        || payload.chunkIndex >= metadata.chunkCount
        || data.length !== expectedLength
      ) {
        throw new AppProtocolError({
          code: 'invalid_chunk',
          message: `chunk ${payload.chunkIndex} offset/length does not match the transfer`,
          stage: 'inbound-file',
          transferId: payload.transferId,
        });
      }
      if (payload.offset < metadata.persistedOffset) {
        if (payload.offset + data.length > metadata.persistedOffset) {
          throw new AppProtocolError({ code: 'chunk_conflict', message: 'chunk overlaps persisted data', stage: 'inbound-file', transferId: payload.transferId });
        }
        const existing = await store.readPartRange(sender.daemonHostId, payload.transferId, payload.offset, data.length);
        if (!existing.equals(data)) {
          throw new AppProtocolError({ code: 'chunk_conflict', message: 'duplicate chunk bytes differ', stage: 'inbound-file', transferId: payload.transferId });
        }
        return peerResultFrame(payload.requestId, payload.messageId, 'receiving', 'prepared', {
          transferId: payload.transferId,
          persistedOffset: metadata.persistedOffset,
        });
      }
      if (payload.offset > metadata.persistedOffset) {
        throw new AppProtocolError({ code: 'invalid_chunk', message: 'chunk offset is ahead of persisted offset', stage: 'inbound-file', transferId: payload.transferId });
      }
      const nextOffset = await store.appendPart(sender.daemonHostId, payload.transferId, metadata.persistedOffset, data);
      const updated: AppStagingMetadata = { ...metadata, persistedOffset: nextOffset };
      await store.writeStagingMetadata(updated);
      return peerResultFrame(payload.requestId, payload.messageId, 'receiving', 'prepared', {
        transferId: payload.transferId,
        persistedOffset: nextOffset,
      });
    });
  }

  async function receiveFileCommit(
    sender: { deviceId: string; daemonHostId: string },
    payload: AppSendFileCommitPayload,
  ): Promise<AppServerFrame> {
    return store.runExclusive(async () => {
      const existing = await store.readInboxRecord(sender.daemonHostId, payload.messageId);
      if (existing?.kind === 'file' && existing.file?.transferId === payload.transferId) {
        return peerResultFrame(payload.requestId, payload.messageId, 'received', 'received', {
          transferId: payload.transferId,
          absolutePath: existing.file.absolutePath,
        });
      }
      if (existing) {
        throw new AppProtocolError({
          code: 'message_id_conflict',
          message: 'messageId already exists for a different transfer',
          stage: 'file-commit',
          messageId: payload.messageId,
          transferId: payload.transferId,
        });
      }
      const metadata = await store.readStagingMetadata(sender.daemonHostId, payload.transferId);
      if (!metadata || metadata.messageId !== payload.messageId) {
        throw new AppProtocolError({ code: 'not_found', message: 'transfer staging record not found', stage: 'file-commit', transferId: payload.transferId });
      }
      const partSize = await store.statPart(sender.daemonHostId, payload.transferId);
      if (partSize !== metadata.totalBytes || metadata.persistedOffset !== metadata.totalBytes) {
        throw new AppProtocolError({
          code: 'transfer_incomplete',
          message: `transfer has ${partSize}/${metadata.totalBytes} persisted bytes`,
          stage: 'file-commit',
          transferId: payload.transferId,
        });
      }
      const actualSha = await store.computeFileSha256(store.stagingPartPath(sender.daemonHostId, payload.transferId));
      if (actualSha !== metadata.sha256) {
        throw new AppProtocolError({
          code: 'integrity_mismatch',
          message: 'transfer SHA-256 does not match the declared digest',
          stage: 'file-commit',
          transferId: payload.transferId,
        });
      }
      const finalPath = store.finalFilePath(sender.daemonHostId, payload.messageId, metadata.fileName);
      const verified: AppStagingMetadata = { ...metadata, phase: 'verified', absolutePath: finalPath };
      await store.writeStagingMetadata(verified);
      await store.renamePartToFinal(sender.daemonHostId, payload.messageId, metadata.fileName, payload.transferId);
      const record: AppInboxRecord = {
        schemaVersion: 1,
        senderDeviceId: sender.deviceId,
        senderDaemonHostId: sender.daemonHostId,
        receiverDeviceId: options.deviceId,
        receiverDaemonHostId: options.daemonHostId,
        messageId: payload.messageId,
        kind: 'file',
        subject: metadata.subject,
        file: {
          transferId: metadata.transferId,
          fileName: metadata.fileName,
          totalBytes: metadata.totalBytes,
          chunkCount: metadata.chunkCount,
          sha256: metadata.sha256,
          absolutePath: finalPath,
        },
        state: 'received',
        receivedAt: nowIso(now),
      };
      await store.admitInboxRecord(record, 0, {
        staging: { senderDaemonHostId: sender.daemonHostId, transferId: payload.transferId },
      });
      await rm(store.stagingMetaPath(sender.daemonHostId, payload.transferId), { force: true });
      publishRecord(record);
      return peerResultFrame(payload.requestId, payload.messageId, 'received', 'received', {
        transferId: payload.transferId,
        absolutePath: finalPath,
      });
    });
  }

  async function resolveInboxRecord(messageId: string, senderDaemonHostId?: string): Promise<AppInboxRecord> {
    if (senderDaemonHostId) {
      const record = await store.readInboxRecord(senderDaemonHostId, messageId);
      if (!record) {
        throw new AppProtocolError({ code: 'not_found', message: 'message not found', stage: 'status', messageId });
      }
      return record;
    }
    const matches = (await store.listInboxRecords()).filter((record) => record.messageId === messageId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new AppProtocolError({ code: 'not_found', message: 'message not found', stage: 'status', messageId });
    }
    throw new AppProtocolError({ code: 'ambiguous_message_id', message: 'messageId matches multiple senders', stage: 'status', messageId });
  }

  async function settleLocalState(
    messageId: string,
    senderDaemonHostId: string | undefined,
    targetState: 'delivered' | 'consumed',
  ): Promise<{ changed: boolean; record: AppInboxRecord }> {
    return store.runExclusive(async () => {
      const record = await resolveInboxRecord(messageId, senderDaemonHostId);
      if (record.state === 'rejected') {
        throw new AppProtocolError({ code: 'invalid_state', message: 'rejected messages cannot advance', stage: 'ack', messageId });
      }
      if (targetState === 'delivered') {
        if (record.state !== 'received') return { changed: false, record };
        const next: AppInboxRecord = { ...record, state: 'delivered', deliveredAt: nowIso(now) };
        await store.writeInboxRecord(next);
        return { changed: true, record: next };
      }
      if (record.state === 'received') {
        throw new AppProtocolError({ code: 'invalid_state', message: 'consume requires delivered state', stage: 'consume', messageId });
      }
      if (record.state === 'consumed') return { changed: false, record };
      const next: AppInboxRecord = { ...record, state: 'consumed', consumedAt: nowIso(now) };
      await store.writeInboxRecord(next);
      return { changed: true, record: next };
    });
  }

  async function localStatus(link: AppLink, requestId: string, messageId: string, senderDaemonHostId?: string) {
    try {
      const record = await resolveInboxRecord(messageId, senderDaemonHostId);
      link.send({ type: 'app-status-result', payload: recordStatusPayload(record, requestId) });
      return;
    } catch (error) {
      if (!(error instanceof AppProtocolError) || error.code !== 'not_found') {
        sendError(link, error, requestId, messageId);
        return;
      }
    }
    const outbox = (await store.listOutboxRecords()).filter((record) => record.messageId === messageId);
    if (outbox.length === 1) {
      link.send({ type: 'app-status-result', payload: outboxStatusPayload(outbox[0]!, requestId) });
      return;
    }
    if (outbox.length > 1) {
      link.send({
        type: 'app-status-result',
        payload: { requestId, messageId, found: false, ambiguous: true },
      });
      return;
    }
    link.send({ type: 'app-status-result', payload: { requestId, messageId, found: false } });
  }

  async function remoteStatus(link: AppLink, requestId: string, messageId: string, target: AppTarget) {
    try {
      const peer = await connectPeer(target);
      const response = await peerRequest(peer, {
        type: 'app-status',
        payload: { requestId, messageId },
      });
      link.send(response);
    } catch (error) {
      if (error instanceof PeerLinkError && error.code === 'result_unknown') {
        sendError(link, error, requestId, messageId);
        return;
      }
      sendError(link, error, requestId, messageId);
    }
  }

  async function peerStatus(link: AppLink, requestId: string, messageId: string, senderDaemonHostId?: string) {
    if (senderDaemonHostId && senderDaemonHostId !== link.daemonHostId) {
      throw new AppProtocolError({ code: 'not_found', message: 'peer may only query its own sender scope', stage: 'status', messageId });
    }
    const record = await store.readInboxRecord(link.daemonHostId, messageId);
    if (!record) {
      link.send({ type: 'app-status-result', payload: { requestId, messageId, found: false } });
      return;
    }
    link.send({ type: 'app-status-result', payload: recordStatusPayload(record, requestId) });
  }

  async function recoverOutbox() {
    await store.runExclusive(async () => {
      for (const record of await store.listOutboxRecords()) {
        if (record.state !== 'pending' && record.state !== 'sent') continue;
        await store.writeOutboxRecord({ ...record, state: 'result_unknown', updatedAt: nowIso(now) });
      }
    });
  }

  return {
    async initialize() {
      if (initialized) return;
      try {
        await store.initialize();
        const recovered = await store.runExclusive(() => store.recoverStaging());
        await recoverOutbox();
        await store.runExclusive(() => store.cleanupRetention(now(), retentionMs));
        for (const record of recovered) publishRecord(record);
        retentionTimer = setInterval(() => {
          void store.runExclusive(() => store.cleanupRetention(now(), retentionMs)).catch(() => undefined);
        }, options.retentionIntervalMs ?? 60 * 60 * 1000);
        retentionTimer.unref?.();
        initialized = true;
        initializationError = null;
      } catch (error) {
        initializationError = error instanceof Error ? error : new Error(String(error));
      }
    },

    dispose() {
      if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = null;
      }
      for (const peer of [...peerLinks.values()]) {
        void closePeerLink(peer, 'daemon dispose');
      }
      for (const [id, subscriber] of subscribers) {
        subscriber.close('daemon dispose', 1001);
        subscribers.delete(id);
      }
      activeFileSends.clear();
      initialized = false;
      initializationError = null;
    },

    getInitializationError() {
      return initializationError;
    },

    getCapabilities() {
      return APP_CAPABILITIES;
    },

    getIdentity() {
      return { deviceId: options.deviceId, daemonHostId: options.daemonHostId };
    },

    async subscribeLocal(link) {
      await store.runExclusive(async () => {
        subscribers.set(link.id, link);
        for (const record of await store.listInboxRecords()) {
          if (record.state !== 'received') continue;
          const frame = record.kind === 'file' ? inboundFileFrame(record) : inboundMessageFrame(record);
          if (frame && !link.send(frame)) {
            subscribers.delete(link.id);
            link.close('slow_consumer', 4008);
            break;
          }
        }
      });
    },

    revokeLink(linkId) {
      subscribers.delete(linkId);
    },

    async handleFrame(link, frame): Promise<{ settled: boolean; messageId?: string; senderDaemonHostId?: string }> {
      const requestId = frameRequestId(frame);
      const messageId = 'messageId' in frame.payload && typeof frame.payload.messageId === 'string'
        ? frame.payload.messageId
        : undefined;
      const transferId = 'transferId' in frame.payload && typeof frame.payload.transferId === 'string'
        ? frame.payload.transferId
        : undefined;
      try {
        if (initializationError) {
          throw new AppProtocolError({
            code: 'storage_error',
            message: `app messaging is unavailable: ${initializationError.message}`,
            stage: 'admission',
            requestId,
          });
        }
        if (frame.type === 'app-ack' || frame.type === 'app-consume') {
          if (link.role !== 'local') {
            throw new AppProtocolError({ code: 'forbidden_role', message: 'peer connections cannot ack or consume', stage: 'admission' });
          }
          const state = frame.type === 'app-ack' ? 'delivered' : 'consumed';
          const settled = await settleLocalState(frame.payload.messageId, frame.payload.senderDaemonHostId, state);
          link.send({ type: 'app-status-result', payload: recordStatusPayload(settled.record, frame.payload.requestId) });
          if (settled.changed) {
            return { settled: true, messageId: settled.record.messageId, senderDaemonHostId: settled.record.senderDaemonHostId };
          }
          return { settled: false };
        }

        switch (frame.type) {
          case 'app-send-message':
            if (link.role === 'local') {
              await sendMessageFromLocal(link, frame.payload);
            } else {
              const state = await receiveMessage(link, frame.payload);
              link.send(peerResultFrame(frame.payload.requestId, frame.payload.messageId, state === 'rejected' ? 'rejected' : 'received', 'received'));
            }
            return { settled: false };
          case 'app-send-file-start':
            if (link.role === 'local') {
              await sendFileStartFromLocal(link, frame.payload);
            } else {
              link.send(await receiveFileStart(link, frame.payload));
            }
            return { settled: false };
          case 'app-send-file-chunk':
            if (link.role === 'local') {
              await forwardFileChunk(link, frame.payload);
            } else {
              link.send(await receiveFileChunk(link, frame.payload));
            }
            return { settled: false };
          case 'app-send-file-commit':
            if (link.role === 'local') {
              await forwardFileCommit(link, frame.payload);
            } else {
              link.send(await receiveFileCommit(link, frame.payload));
            }
            return { settled: false };
          case 'app-status':
            if (link.role === 'peer') {
              await peerStatus(link, frame.payload.requestId, frame.payload.messageId, frame.payload.senderDaemonHostId);
              return { settled: false };
            }
            if (frame.payload.remote) {
              const target = validateAppTarget(frame.payload.target, 'status');
              await remoteStatus(link, frame.payload.requestId, frame.payload.messageId, target);
              return { settled: false };
            }
            await localStatus(link, frame.payload.requestId, frame.payload.messageId, frame.payload.senderDaemonHostId);
            return { settled: false };
          case 'app-ping':
            link.send({
              type: 'app-pong',
              payload: {
                requestId: frame.payload.requestId,
                sentAt: frame.payload.sentAt,
                receivedAt: now(),
              },
            });
            return { settled: false };
          default:
            throw new AppProtocolError({ code: 'invalid_frame', message: `unsupported frame: ${(frame as { type?: string }).type}`, stage: 'dispatch' });
        }
      } catch (error) {
        sendError(link, error, requestId, messageId, transferId);
        return { settled: false };
      }
      return { settled: false };
    },
  };
}

export function resolveAppInboxRoot(appRootDir: string) {
  return join(appRootDir, 'app-inbox');
}

export function validateAppFileName(value: unknown): string {
  return validateSafeFileName(value, 'file-start');
}

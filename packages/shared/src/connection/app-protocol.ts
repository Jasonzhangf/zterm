/**
 * zterm `/app` cross-machine messaging wire contract.
 *
 * This module owns the versioned frames, payload validation, limits, stable
 * identifiers, and typed errors. It is pure TypeScript with no file, network,
 * WebSocket, or account-directory dependency.
 */

export const APP_PROTOCOL_VERSION = 1;
export const APP_MAX_MESSAGE_BYTES = 1_048_576;
export const APP_MAX_FILE_BYTES = 268_435_456;
export const APP_FILE_CHUNK_BYTES = 16_384;
export const APP_MAX_SAFE_FILE_NAME_BYTES = 255;
export const APP_MAX_PATH_IDENTITY_BYTES = 191;
export const APP_MAX_INBOX_RECORDS = 512;
export const APP_MAX_INBOX_BYTES = 2 * 1024 * 1024 * 1024;
export const APP_STREAM_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;
export const APP_ACKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_SERVER_NAME = 'zterm.app';

export type AppRole = 'local' | 'peer';

export type AppErrorCode =
  | 'invalid_version'
  | 'invalid_frame'
  | 'missing_identity'
  | 'unauthorized'
  | 'forbidden_role'
  | 'message_id_conflict'
  | 'message_too_large'
  | 'file_too_large'
  | 'invalid_file_name'
  | 'invalid_chunk'
  | 'chunk_conflict'
  | 'transfer_conflict'
  | 'transfer_incomplete'
  | 'integrity_mismatch'
  | 'inbox_full'
  | 'not_found'
  | 'ambiguous_message_id'
  | 'invalid_state'
  | 'slow_consumer'
  | 'unreachable'
  | 'result_unknown'
  | 'source_changed'
  | 'storage_error'
  | 'cancelled'
  | 'internal_error';

export class AppProtocolError extends Error {
  readonly code: AppErrorCode;
  readonly stage: string;
  readonly requestId?: string;
  readonly messageId?: string;
  readonly transferId?: string;

  constructor(options: {
    code: AppErrorCode;
    message: string;
    stage: string;
    requestId?: string;
    messageId?: string;
    transferId?: string;
  }) {
    super(options.message);
    this.name = 'AppProtocolError';
    this.code = options.code;
    this.stage = options.stage;
    this.requestId = options.requestId;
    this.messageId = options.messageId;
    this.transferId = options.transferId;
  }
}

export interface AppCapabilities {
  serverName: typeof APP_SERVER_NAME;
  protocolVersion: typeof APP_PROTOCOL_VERSION;
  messages: true;
  files: true;
  durableInbox: true;
  push: true;
  ackStates: ['delivered', 'consumed'];
  resumeFileTransfer: true;
  maxMessageBytes: typeof APP_MAX_MESSAGE_BYTES;
  maxFileBytes: typeof APP_MAX_FILE_BYTES;
  fileChunkBytes: typeof APP_FILE_CHUNK_BYTES;
}

export const APP_CAPABILITIES: AppCapabilities = {
  serverName: APP_SERVER_NAME,
  protocolVersion: APP_PROTOCOL_VERSION,
  messages: true,
  files: true,
  durableInbox: true,
  push: true,
  ackStates: ['delivered', 'consumed'],
  resumeFileTransfer: true,
  maxMessageBytes: APP_MAX_MESSAGE_BYTES,
  maxFileBytes: APP_MAX_FILE_BYTES,
  fileChunkBytes: APP_FILE_CHUNK_BYTES,
};

export interface AppHelloPayload {
  protocolVersion: number;
  requestId: string;
  role: AppRole;
  clientInstanceId: string;
  deviceId: string;
  daemonHostId: string;
  capabilities: Record<string, unknown>;
}

export interface AppTarget {
  deviceId: string;
  daemonHostId: string;
  wsUrl: string;
  authToken: string;
}

export interface AppSendMessagePayload {
  requestId: string;
  messageId: string;
  target?: AppTarget;
  subject: string;
  body: string;
}

export interface AppFileMetadata {
  transferId: string;
  fileName: string;
  totalBytes: number;
  chunkCount: number;
  sha256: string;
}

export interface AppSendFileStartPayload {
  requestId: string;
  messageId: string;
  target?: AppTarget;
  subject: string;
  file: AppFileMetadata;
}

export interface AppSendFileChunkPayload {
  requestId: string;
  messageId: string;
  transferId: string;
  offset: number;
  chunkIndex: number;
  dataBase64: string;
}

export interface AppSendFileCommitPayload {
  requestId: string;
  messageId: string;
  transferId: string;
}

export interface AppAckPayload {
  requestId: string;
  messageId: string;
  senderDaemonHostId?: string;
}

export interface AppConsumePayload {
  requestId: string;
  messageId: string;
  senderDaemonHostId?: string;
}

export interface AppStatusPayload {
  requestId: string;
  messageId: string;
  senderDaemonHostId?: string;
  remote?: boolean;
  target?: AppTarget;
}

export interface AppPingPayload {
  requestId: string;
  sentAt: number;
}

export type AppClientFrame =
  | { type: 'app-hello'; payload: AppHelloPayload }
  | { type: 'app-send-message'; payload: AppSendMessagePayload }
  | { type: 'app-send-file-start'; payload: AppSendFileStartPayload }
  | { type: 'app-send-file-chunk'; payload: AppSendFileChunkPayload }
  | { type: 'app-send-file-commit'; payload: AppSendFileCommitPayload }
  | { type: 'app-ack'; payload: AppAckPayload }
  | { type: 'app-consume'; payload: AppConsumePayload }
  | { type: 'app-status'; payload: AppStatusPayload }
  | { type: 'app-ping'; payload: AppPingPayload };

export interface AppReadyPayload {
  requestId: string;
  protocolVersion: typeof APP_PROTOCOL_VERSION;
  deviceId: string;
  daemonHostId: string;
  capabilities: AppCapabilities;
}

export interface AppInboundMessagePayload {
  messageId: string;
  senderDeviceId: string;
  senderDaemonHostId: string;
  receiverDeviceId: string;
  receiverDaemonHostId: string;
  subject: string;
  body: string;
  state: AppRecordState;
  receivedAt: string;
}

export interface AppInboundFilePayload {
  messageId: string;
  transferId: string;
  senderDeviceId: string;
  senderDaemonHostId: string;
  receiverDeviceId: string;
  receiverDaemonHostId: string;
  subject: string;
  fileName: string;
  totalBytes: number;
  sha256: string;
  absolutePath: string;
  state: AppRecordState;
  receivedAt: string;
}

export type AppRecordState = 'received' | 'delivered' | 'consumed' | 'rejected';

export type AppSendResultStatus =
  | 'received'
  | 'delivered'
  | 'consumed'
  | 'rejected'
  | 'resultUnknown'
  | 'unreachable'
  | 'receiving';

export interface AppSendResultPayload {
  requestId: string;
  messageId: string;
  transferId?: string;
  absolutePath?: string;
  status: AppSendResultStatus;
  stage: 'prepared' | 'sent' | 'received' | 'result_unknown';
  persistedOffset?: number;
}

export interface AppStatusResultPayload {
  requestId: string;
  messageId: string;
  found: boolean;
  kind?: 'inbox' | 'outbox';
  senderDaemonHostId?: string;
  targetDaemonHostId?: string;
  state?: AppRecordState;
  transferId?: string;
  absolutePath?: string;
  outboxState?: 'pending' | 'sent' | 'received' | 'result_unknown' | 'failed';
  ambiguous?: boolean;
}

export interface AppConnectionStatePayload {
  requestId: string;
  state: 'connected' | 'disconnected' | 'peer-connected' | 'peer-disconnected';
  daemonHostId?: string;
}

export interface AppErrorPayload {
  requestId?: string;
  messageId?: string;
  transferId?: string;
  code: AppErrorCode;
  stage: string;
  message: string;
}

export interface AppPongPayload {
  requestId: string;
  sentAt: number;
  receivedAt: number;
}

export type AppServerFrame =
  | { type: 'app-ready'; payload: AppReadyPayload }
  | { type: 'app-inbound-message'; payload: AppInboundMessagePayload }
  | { type: 'app-inbound-file'; payload: AppInboundFilePayload }
  | { type: 'app-send-result'; payload: AppSendResultPayload }
  | { type: 'app-status-result'; payload: AppStatusResultPayload }
  | { type: 'app-connection-state'; payload: AppConnectionStatePayload }
  | { type: 'app-error'; payload: AppErrorPayload }
  | { type: 'app-pong'; payload: AppPongPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, stage: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppProtocolError({
      code: 'invalid_frame',
      message: `${field} must be a non-empty string`,
      stage,
    });
  }
  return value;
}

function requiredInteger(value: unknown, field: string, stage: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new AppProtocolError({
      code: 'invalid_frame',
      message: `${field} must be an integer >= ${min}`,
      stage,
    });
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function assertAppProtocolVersion(value: unknown): 1 {
  if (value !== APP_PROTOCOL_VERSION) {
    throw new AppProtocolError({
      code: 'invalid_version',
      message: `unsupported protocol version: ${String(value)}`,
      stage: 'admission',
    });
  }
  return APP_PROTOCOL_VERSION;
}

export function validateAppHello(value: unknown): AppHelloPayload {
  if (!isRecord(value)) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'hello must be an object', stage: 'admission' });
  }
  const requestId = requiredString(value.requestId, 'requestId', 'admission');
  const role = value.role;
  if (role !== 'local' && role !== 'peer') {
    throw new AppProtocolError({
      code: 'invalid_frame',
      message: 'role must be local or peer',
      stage: 'admission',
      requestId,
    });
  }
  assertAppProtocolVersion(value.protocolVersion);
  return {
    protocolVersion: APP_PROTOCOL_VERSION,
    requestId,
    role,
    clientInstanceId: requiredString(value.clientInstanceId, 'clientInstanceId', 'admission'),
    deviceId: requiredString(value.deviceId, 'deviceId', 'admission'),
    daemonHostId: requiredString(value.daemonHostId, 'daemonHostId', 'admission'),
    capabilities: isRecord(value.capabilities) ? value.capabilities : {},
  };
}

export function validateAppTarget(value: unknown, stage: string): AppTarget {
  if (!isRecord(value)) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'target must be an object', stage });
  }
  return {
    deviceId: requiredString(value.deviceId, 'target.deviceId', stage),
    daemonHostId: requiredString(value.daemonHostId, 'target.daemonHostId', stage),
    wsUrl: requiredString(value.wsUrl, 'target.wsUrl', stage),
    authToken: typeof value.authToken === 'string' ? value.authToken : '',
  };
}

function optionalAppTarget(value: unknown, stage: string): AppTarget | undefined {
  return value === undefined ? undefined : validateAppTarget(value, stage);
}

export function validateAppClientFrame(value: unknown): AppClientFrame {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'frame must have a type and payload object', stage: 'frame' });
  }
  const payload = value.payload;
  switch (value.type) {
    case 'app-hello':
      return { type: 'app-hello', payload: validateAppHello(payload) };
    case 'app-send-message': {
      const body = validateMessageBody(payload.body);
      return {
        type: 'app-send-message',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'send-message'),
          messageId: requiredString(payload.messageId, 'messageId', 'send-message'),
          subject: requiredString(payload.subject, 'subject', 'send-message'),
          body,
          target: optionalAppTarget(payload.target, 'send-message'),
        },
      };
    }
    case 'app-send-file-start':
      return {
        type: 'app-send-file-start',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'file-start'),
          messageId: requiredString(payload.messageId, 'messageId', 'file-start'),
          subject: requiredString(payload.subject, 'subject', 'file-start'),
          file: validateAppFileMetadata(payload.file, 'file-start'),
          target: optionalAppTarget(payload.target, 'file-start'),
        },
      };
    case 'app-send-file-chunk':
      return {
        type: 'app-send-file-chunk',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'file-chunk'),
          messageId: requiredString(payload.messageId, 'messageId', 'file-chunk'),
          transferId: requiredString(payload.transferId, 'transferId', 'file-chunk'),
          offset: validateOffset(payload.offset, 'file-chunk'),
          chunkIndex: validateChunkIndex(payload.chunkIndex, 'file-chunk'),
          dataBase64: requiredString(payload.dataBase64, 'dataBase64', 'file-chunk'),
        },
      };
    case 'app-send-file-commit':
      return {
        type: 'app-send-file-commit',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'file-commit'),
          messageId: requiredString(payload.messageId, 'messageId', 'file-commit'),
          transferId: requiredString(payload.transferId, 'transferId', 'file-commit'),
        },
      };
    case 'app-ack':
      return {
        type: 'app-ack',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'ack'),
          messageId: requiredString(payload.messageId, 'messageId', 'ack'),
          senderDaemonHostId: optionalString(payload.senderDaemonHostId),
        },
      };
    case 'app-consume':
      return {
        type: 'app-consume',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'consume'),
          messageId: requiredString(payload.messageId, 'messageId', 'consume'),
          senderDaemonHostId: optionalString(payload.senderDaemonHostId),
        },
      };
    case 'app-status':
      return {
        type: 'app-status',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'status'),
          messageId: requiredString(payload.messageId, 'messageId', 'status'),
          senderDaemonHostId: optionalString(payload.senderDaemonHostId),
          remote: payload.remote === true,
          target: optionalAppTarget(payload.target, 'status'),
        },
      };
    case 'app-ping': {
      const sentAt = payload.sentAt;
      if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) {
        throw new AppProtocolError({ code: 'invalid_frame', message: 'sentAt must be a finite number', stage: 'ping' });
      }
      return {
        type: 'app-ping',
        payload: {
          requestId: requiredString(payload.requestId, 'requestId', 'ping'),
          sentAt,
        },
      };
    }
    default:
      throw new AppProtocolError({ code: 'invalid_frame', message: `unsupported frame: ${value.type}`, stage: 'frame' });
  }
}

export function validateMessageBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'body must be a string', stage: 'validate' });
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > APP_MAX_MESSAGE_BYTES) {
    throw new AppProtocolError({ code: 'message_too_large', message: 'message body exceeds 1 MiB', stage: 'validate' });
  }
  return value;
}

export function validateAppFileMetadata(value: unknown, stage: string): AppFileMetadata {
  if (!isRecord(value)) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'file metadata must be an object', stage });
  }
  const transferId = requiredString(value.transferId, 'transferId', stage);
  const fileName = validateSafeFileName(value.fileName, stage);
  const totalBytes = requiredInteger(value.totalBytes, 'totalBytes', stage, 0);
  const chunkCount = requiredInteger(value.chunkCount, 'chunkCount', stage, 0);
  const sha256 = requiredString(value.sha256, 'sha256', stage);
  if (totalBytes > APP_MAX_FILE_BYTES) {
    throw new AppProtocolError({ code: 'file_too_large', message: 'file exceeds 256 MiB', stage, transferId });
  }
  const expectedChunks = computeAppChunkCount(totalBytes);
  if (chunkCount !== expectedChunks) {
    throw new AppProtocolError({
      code: 'invalid_frame',
      message: `chunkCount ${chunkCount} does not match ${expectedChunks} for ${totalBytes} bytes`,
      stage,
      transferId,
    });
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'sha256 must be a 64 hex digest', stage, transferId });
  }
  return { transferId, fileName, totalBytes, chunkCount, sha256 };
}

export function computeAppChunkCount(totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.ceil(totalBytes / APP_FILE_CHUNK_BYTES);
}

export function validateSafeFileName(value: unknown, stage: string): string {
  if (typeof value !== 'string') {
    throw new AppProtocolError({ code: 'invalid_file_name', message: 'fileName must be a string', stage });
  }
  if (value.length === 0 || value === '.' || value === '..') {
    throw new AppProtocolError({ code: 'invalid_file_name', message: 'fileName is not a valid basename', stage });
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new AppProtocolError({ code: 'invalid_file_name', message: 'fileName must be a single basename', stage });
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > APP_MAX_SAFE_FILE_NAME_BYTES) {
    throw new AppProtocolError({ code: 'invalid_file_name', message: 'fileName exceeds 255 UTF-8 bytes', stage });
  }
  return value;
}

export function validateChunkIndex(value: unknown, stage: string): number {
  return requiredInteger(value, 'chunkIndex', stage, 0);
}

export function validateOffset(value: unknown, stage: string): number {
  return requiredInteger(value, 'offset', stage, 0);
}

export function encodeAppPathSegment(value: string): string {
  if (value.length === 0) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'identity segment is empty', stage: 'storage' });
  }
  if (new TextEncoder().encode(value).length > APP_MAX_PATH_IDENTITY_BYTES) {
    throw new AppProtocolError({ code: 'invalid_frame', message: 'identity segment exceeds 191 UTF-8 bytes', stage: 'storage' });
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = (globalThis as unknown as { btoa?: (input: string) => string }).btoa?.(binary)
    ?? Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeAppPathSegment(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = (globalThis as unknown as { atob?: (input: string) => string }).atob?.(padded)
    ?? Buffer.from(padded, 'base64').toString('binary');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function appErrorPayload(options: {
  code: AppErrorCode;
  stage: string;
  message: string;
  requestId?: string;
  messageId?: string;
  transferId?: string;
}): AppErrorPayload {
  return {
    requestId: options.requestId,
    messageId: options.messageId,
    transferId: options.transferId,
    code: options.code,
    stage: options.stage,
    message: options.message,
  };
}

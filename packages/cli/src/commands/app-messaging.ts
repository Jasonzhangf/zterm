import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SharedConfigStore } from '../../../shared/src/node/shared-config.js';
import type { AccountClient } from '../account-client.js';
import { AppClientConnection } from '../app-connection.js';
import {
  AppCliError,
  resolveAppTarget,
  resolveLocalAppDaemonConfig,
  type LocalAppDaemonConfig,
} from '../app-target-resolution.js';
import { readStoredCliAuth } from './auth.js';
import {
  APP_FILE_CHUNK_BYTES,
  APP_MAX_FILE_BYTES,
  APP_MAX_PATH_IDENTITY_BYTES,
  APP_PROTOCOL_VERSION,
  appErrorPayload,
  computeAppChunkCount,
  type AppClientFrame,
  type AppErrorCode,
  type AppFileMetadata,
  type AppServerFrame,
  type AppTarget,
} from '../../../shared/src/connection/app-protocol.js';

export interface AppCommandContext {
  store: SharedConfigStore;
  accountClient: Pick<AccountClient, 'me' | 'directory'>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  connect?: typeof AppClientConnection.connect;
}

export const APP_HELP = `用法：
  zterm app stream [--json]
  zterm app send --peer <deviceId> [--daemon-host-id <hostId>] [--message-id <id>] --subject <text> --body <text>
  zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] [--message-id <id>] --file <path> [--subject <text>]
  zterm app status --message-id <id> [--sender-daemon-host-id <hostId>] [--remote --peer <deviceId>]
  zterm app ack --message-id <id> [--sender-daemon-host-id <hostId>]
  zterm app consume --message-id <id> [--sender-daemon-host-id <hostId>]
  zterm app --help

stream 默认输出逐行 JSON。send 的成功状态是远端 received；resultUnknown 时退出码为 3。
本地连接断开时 stream 输出 app-connection-state（含 close code/reason）与无关联 app-error。`;

const STREAM_HELP = `用法：
  zterm app stream [--json]

建立一条本地 /app WebSocket，输出逐行 JSON 事件，并从 stdin 读取逐行 JSON 命令：
  {"type":"send","peer":"<deviceId>","subject":"...","body":"..."}
  {"type":"send-file","peer":"<deviceId>","file":"/path","subject":"..."}
  {"type":"status","messageId":"...","senderDaemonHostId":"...","remote":false}
  {"type":"ack","messageId":"...","senderDaemonHostId":"..."}
  {"type":"consume","messageId":"...","senderDaemonHostId":"..."}
stdin 关闭时退出码为 1。`;

const SEND_HELP = `用法：
  zterm app send --peer <deviceId> [--daemon-host-id <hostId>] [--message-id <id>] --subject <text> --body <text>

发送一条消息到精确目标 daemon。未指定 --message-id 时生成稳定 ID 并先输出在结果中。`;

const SEND_FILE_HELP = `用法：
  zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] [--message-id <id>] --file <path> [--subject <text>]

流式发送 256 MiB 以内文件。分片为 16 KiB，支持同 ID/transferId 断点恢复。`;

const STATUS_HELP = `用法：
  zterm app status --message-id <id> [--sender-daemon-host-id <hostId>] [--remote --peer <deviceId>]

查询本地 Inbox 或 Outbox。--remote 时经本地 daemon 查询目标 peer 的发送者作用域。`;

const ACK_HELP = `用法：
  zterm app ack --message-id <id> [--sender-daemon-host-id <hostId>]

把本地 Inbox 记录从 received 推进到 delivered。重复 ack 幂等。`;

const CONSUME_HELP = `用法：
  zterm app consume --message-id <id> [--sender-daemon-host-id <hostId>]

把本地 Inbox 记录从 delivered 推进到 consumed。未 delivered 时明确失败。`;

type FlagValues = Record<string, string | boolean>;

function writeText(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(text)) {
      resolve();
      return;
    }
    stream.once('drain', resolve);
  });
}

async function emitFrame(stream: Writable, frame: AppServerFrame) {
  await writeText(stream, `${JSON.stringify(frame)}\n`);
}

async function emitLocalError(stream: Writable, error: unknown, requestId?: string) {
  const code = error instanceof AppCliError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  const mapped: AppErrorCode = code === 'cancelled'
    ? 'cancelled'
    : code === 'invalid_request' || code === 'file_not_found' || code === 'file_not_regular' || code === 'file_too_large'
      ? 'invalid_frame'
      : code === 'missing_identity'
        ? 'missing_identity'
        : code === 'auth_missing' || code === 'missing_auth_token' || code === 'unauthorized'
          ? 'unauthorized'
          : code === 'peer_ambiguous'
            ? 'ambiguous_message_id'
            : code === 'peer_not_found'
              ? 'not_found'
              : code === 'no_direct_endpoint' || code === 'unreachable'
                ? 'unreachable'
                : code === 'source_changed'
                  ? 'source_changed'
                  : code === 'result_unknown'
                    ? 'result_unknown'
                    : 'internal_error';
  await emitFrame(stream, {
    type: 'app-error',
    payload: appErrorPayload({
      code: mapped,
      stage: 'cli',
      message,
      requestId,
    }),
  });
}

function usage(message: string): AppCliError {
  return new AppCliError('invalid_request', message, 2);
}

function parseFlags(
  args: readonly string[],
  allowed: readonly string[],
  booleanFlags: readonly string[] = [],
): FlagValues {
  const values: FlagValues = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw usage(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.includes(name)) throw usage(`unknown flag: --${name}`);
    if (booleanFlags.includes(name)) {
      values[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw usage(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function requiredFlag(values: FlagValues, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) throw usage(`missing required flag: --${name}`);
  return value;
}

function optionalFlag(values: FlagValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireIdentitySegment(value: string): string {
  if (value.length === 0 || new TextEncoder().encode(value).length > APP_MAX_PATH_IDENTITY_BYTES) {
    throw usage('messageId and daemon identity must be 1..191 UTF-8 bytes');
  }
  return value;
}

function requestId(): string {
  return randomUUID();
}

function localConfig(context: AppCommandContext): LocalAppDaemonConfig {
  return resolveLocalAppDaemonConfig({ homeDir: context.homeDir, env: context.env });
}

async function authForTarget(context: AppCommandContext) {
  const auth = await readStoredCliAuth(context.store, context.signal);
  if (!auth) throw new AppCliError('auth_missing', 'not logged in; run zterm login before sending', 1);
  return auth;
}

async function resolveTarget(
  context: AppCommandContext,
  peer: string,
  daemonHostId?: string,
): Promise<AppTarget> {
  return resolveAppTarget({
    auth: await authForTarget(context),
    accountClient: context.accountClient,
    peerDeviceId: peer,
    daemonHostId,
    signal: context.signal,
  });
}

async function connectLocal(context: AppCommandContext, onEvent?: (frame: AppServerFrame) => void) {
  const connect = context.connect ?? AppClientConnection.connect;
  return connect({
    config: localConfig(context),
    signal: context.signal,
    onEvent,
  });
}

function exitCodeFor(frame: AppServerFrame): number {
  if (frame.type === 'app-error') {
    return frame.payload.code === 'result_unknown' ? 3 : 1;
  }
  if (frame.type === 'app-send-result') {
    if (frame.payload.status === 'resultUnknown') return 3;
    if (frame.payload.status === 'received' || frame.payload.status === 'delivered' || frame.payload.status === 'consumed' || frame.payload.status === 'receiving') {
      return 0;
    }
    return 1;
  }
  return 0;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function describeFile(filePath: string): Promise<{ metadata: Omit<AppFileMetadata, 'transferId'>; signature: string }> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new AppCliError('file_not_found', `cannot read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (!info.isFile()) {
    throw new AppCliError('file_not_regular', `file is not a regular file: ${filePath}`, 2);
  }
  if (info.size > APP_MAX_FILE_BYTES) {
    throw new AppCliError('file_too_large', `file exceeds 256 MiB: ${filePath}`, 2);
  }
  return {
    metadata: {
      fileName: filePath.split(/[\\/]/).pop() || 'file',
      totalBytes: info.size,
      chunkCount: computeAppChunkCount(info.size),
      sha256: await hashFile(filePath),
    },
    signature: `${info.size}:${info.mtimeMs}`,
  };
}

type DescribedFile = Awaited<ReturnType<typeof describeFile>>;

async function fileStillMatches(filePath: string, signature: string, sha256: string) {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) return false;
  if (`${info.size}:${info.mtimeMs}` !== signature) return false;
  return await hashFile(filePath) === sha256;
}

async function runFileTransfer(
  connection: AppClientConnection,
  target: AppTarget,
  messageId: string,
  subject: string,
  filePath: string,
  describedInput?: DescribedFile,
): Promise<AppServerFrame> {
  const described = describedInput ?? await describeFile(filePath);
  const file: AppFileMetadata = { ...described.metadata, transferId: messageId };
  const start = await connection.request({
    type: 'app-send-file-start',
    payload: {
      requestId: requestId(),
      messageId,
      target,
      subject,
      file,
    },
  });
  if (start.type === 'app-error') return start;
  if (start.type !== 'app-send-result') {
    return {
      type: 'app-error',
      payload: appErrorPayload({ code: 'invalid_frame', stage: 'cli', message: 'unexpected file-start response', messageId, transferId: messageId }),
    };
  }
  // Only continue into chunk/commit when the remote is durably receiving this transfer.
  // For any other start outcome (received/delivered/consumed/resultUnknown/rejected/unreachable)
  // return the start frame unchanged so its original transferId survives and no downstream
  // chunk/commit can overwrite an uncertain start with invalid_state.
  if (start.payload.status !== 'receiving') {
    return start;
  }
  let offset = start.payload.persistedOffset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > file.totalBytes) {
    return {
      type: 'app-error',
      payload: appErrorPayload({ code: 'invalid_chunk', stage: 'cli', message: 'remote persisted offset is invalid', messageId, transferId: messageId }),
    };
  }
  const handle = await open(filePath, 'r');
  try {
    while (offset < file.totalBytes) {
      if (offset % APP_FILE_CHUNK_BYTES !== 0 && offset !== file.totalBytes) {
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'invalid_chunk', stage: 'cli', message: 'remote persisted offset is not a chunk boundary', messageId, transferId: messageId }),
        };
      }
      const chunkIndex = Math.floor(offset / APP_FILE_CHUNK_BYTES);
      const length = Math.min(APP_FILE_CHUNK_BYTES, file.totalBytes - offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'source_changed', stage: 'cli', message: 'source file changed while reading', messageId, transferId: messageId }),
        };
      }
      const result = await connection.request({
        type: 'app-send-file-chunk',
        payload: {
          requestId: requestId(),
          messageId,
          transferId: messageId,
          offset,
          chunkIndex,
          dataBase64: buffer.toString('base64'),
        },
      });
      if (result.type === 'app-error') return result;
      if (result.type !== 'app-send-result' || typeof result.payload.persistedOffset !== 'number') {
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'result_unknown', stage: 'cli', message: 'file chunk has no durable offset result', messageId, transferId: messageId }),
        };
      }
      if (result.payload.persistedOffset !== offset + length) {
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'invalid_chunk', stage: 'cli', message: 'remote persisted offset did not advance as expected', messageId, transferId: messageId }),
        };
      }
      offset = result.payload.persistedOffset;
    }
  } finally {
    await handle.close();
  }
  if (!await fileStillMatches(filePath, described.signature, file.sha256)) {
    return {
      type: 'app-error',
      payload: appErrorPayload({ code: 'source_changed', stage: 'cli', message: 'source file changed before commit', messageId, transferId: messageId }),
    };
  }
  return connection.request({
    type: 'app-send-file-commit',
    payload: { requestId: requestId(), messageId, transferId: messageId },
  });
}

async function runSend(args: readonly string[], context: AppCommandContext): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await writeText(context.stdout, `${SEND_HELP}\n`);
    return 0;
  }
  const flags = parseFlags(args, ['peer', 'daemon-host-id', 'message-id', 'subject', 'body']);
  const peer = requiredFlag(flags, 'peer');
  const subject = requiredFlag(flags, 'subject');
  const body = requiredFlag(flags, 'body');
  const messageId = requireIdentitySegment(optionalFlag(flags, 'message-id') ?? randomUUID());
  const target = await resolveTarget(context, peer, optionalFlag(flags, 'daemon-host-id'));
  const connection = await connectLocal(context);
  const request = { type: 'app-send-message' as const, payload: { requestId: requestId(), messageId, target, subject, body } };
  try {
    const result = await connection.request(request);
    await emitFrame(context.stdout, result);
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof AppCliError && error.code === 'result_unknown') {
      await emitFrame(context.stdout, {
        type: 'app-send-result',
        payload: {
          requestId: request.payload.requestId,
          messageId,
          status: 'resultUnknown',
          stage: 'result_unknown',
        },
      });
      return 3;
    }
    throw error;
  } finally {
    connection.close();
  }
}

async function runSendFile(args: readonly string[], context: AppCommandContext): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await writeText(context.stdout, `${SEND_FILE_HELP}\n`);
    return 0;
  }
  const flags = parseFlags(args, ['peer', 'daemon-host-id', 'message-id', 'file', 'subject']);
  const peer = requiredFlag(flags, 'peer');
  const filePath = requiredFlag(flags, 'file');
  const subject = optionalFlag(flags, 'subject') ?? '';
  const messageId = requireIdentitySegment(optionalFlag(flags, 'message-id') ?? randomUUID());
  const described = await describeFile(filePath);
  const target = await resolveTarget(context, peer, optionalFlag(flags, 'daemon-host-id'));
  const connection = await connectLocal(context);
  try {
    const result = await runFileTransfer(connection, target, messageId, subject, filePath, described);
    await emitFrame(context.stdout, result);
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof AppCliError && error.code === 'result_unknown') {
      await emitFrame(context.stdout, {
        type: 'app-send-result',
        payload: {
          requestId: requestId(),
          messageId,
          transferId: messageId,
          status: 'resultUnknown',
          stage: 'result_unknown',
        },
      });
      return 3;
    }
    throw error;
  } finally {
    connection.close();
  }
}

async function runStatus(args: readonly string[], context: AppCommandContext): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await writeText(context.stdout, `${STATUS_HELP}\n`);
    return 0;
  }
  const flags = parseFlags(args, ['message-id', 'sender-daemon-host-id', 'remote', 'peer'], ['remote']);
  const messageId = requireIdentitySegment(requiredFlag(flags, 'message-id'));
  const senderDaemonHostId = optionalFlag(flags, 'sender-daemon-host-id');
  const remote = flags.remote === true;
  const peer = optionalFlag(flags, 'peer');
  if (remote && !peer) throw usage('--remote requires --peer');
  if (!remote && peer) throw usage('--peer requires --remote');
  const target = remote ? await resolveTarget(context, peer!) : undefined;
  const connection = await connectLocal(context);
  try {
    const result = await connection.request({
      type: 'app-status',
      payload: {
        requestId: requestId(),
        messageId,
        ...(senderDaemonHostId ? { senderDaemonHostId } : {}),
        remote,
        ...(target ? { target } : {}),
      },
    });
    await emitFrame(context.stdout, result);
    return exitCodeFor(result);
  } finally {
    connection.close();
  }
}

async function runSettle(
  kind: 'ack' | 'consume',
  args: readonly string[],
  context: AppCommandContext,
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await writeText(context.stdout, `${kind === 'ack' ? ACK_HELP : CONSUME_HELP}\n`);
    return 0;
  }
  const flags = parseFlags(args, ['message-id', 'sender-daemon-host-id']);
  const messageId = requireIdentitySegment(requiredFlag(flags, 'message-id'));
  const senderDaemonHostId = optionalFlag(flags, 'sender-daemon-host-id');
  const connection = await connectLocal(context);
  try {
    const result = await connection.request({
      type: kind === 'ack' ? 'app-ack' : 'app-consume',
      payload: {
        requestId: requestId(),
        messageId,
        ...(senderDaemonHostId ? { senderDaemonHostId } : {}),
      },
    });
    await emitFrame(context.stdout, result);
    return exitCodeFor(result);
  } finally {
    connection.close();
  }
}

async function handleStreamCommand(
  line: string,
  context: AppCommandContext,
  connection: AppClientConnection,
): Promise<number | undefined> {
  let command: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('command must be an object');
    command = parsed as Record<string, unknown>;
  } catch (error) {
    await emitFrame(context.stdout, {
      type: 'app-error',
      payload: appErrorPayload({ code: 'invalid_frame', stage: 'stdin', message: error instanceof Error ? error.message : String(error) }),
    });
    return;
  }
  const kind = command.type;
  try {
    if (kind === 'send') {
      const target = await resolveTarget(
        context,
        String(command.peer ?? ''),
        typeof command.daemonHostId === 'string' ? command.daemonHostId : undefined,
      );
      const messageId = requireIdentitySegment(typeof command.messageId === 'string' ? command.messageId : randomUUID());
      const sendRequestId = requestId();
      try {
        const result = await connection.request({
          type: 'app-send-message',
          payload: {
            requestId: sendRequestId,
            messageId,
            target,
            subject: typeof command.subject === 'string' ? command.subject : '',
            body: typeof command.body === 'string' ? command.body : '',
          },
        });
        await emitFrame(context.stdout, result);
        if (result.type === 'app-send-result' && result.payload.status === 'resultUnknown') {
          return 3;
        }
      } catch (error) {
        if (error instanceof AppCliError && error.code === 'result_unknown') {
          await emitFrame(context.stdout, {
            type: 'app-send-result',
            payload: { requestId: sendRequestId, messageId, status: 'resultUnknown', stage: 'result_unknown' },
          });
          return 3;
        }
        throw error;
      }
      return;
    }
    if (kind === 'send-file') {
      if (typeof command.file !== 'string' || !command.file) throw usage('send-file requires file');
      const described = await describeFile(command.file);
      const target = await resolveTarget(
        context,
        String(command.peer ?? ''),
        typeof command.daemonHostId === 'string' ? command.daemonHostId : undefined,
      );
      const messageId = requireIdentitySegment(typeof command.messageId === 'string' ? command.messageId : randomUUID());
      try {
        const result = await runFileTransfer(
          connection,
          target,
          messageId,
          typeof command.subject === 'string' ? command.subject : '',
          command.file,
          described,
        );
        await emitFrame(context.stdout, result);
        if (result.type === 'app-send-result' && result.payload.status === 'resultUnknown') {
          return 3;
        }
      } catch (error) {
        if (error instanceof AppCliError && error.code === 'result_unknown') {
          await emitFrame(context.stdout, {
            type: 'app-send-result',
            payload: { requestId: requestId(), messageId, transferId: messageId, status: 'resultUnknown', stage: 'result_unknown' },
          });
          return 3;
        }
        throw error;
      }
      return;
    }
    if (kind === 'ack' || kind === 'consume') {
      const messageId = requireIdentitySegment(typeof command.messageId === 'string' ? command.messageId : '');
      const senderDaemonHostId = typeof command.senderDaemonHostId === 'string' && command.senderDaemonHostId
        ? command.senderDaemonHostId
        : undefined;
      const result = await connection.request({
        type: kind === 'ack' ? 'app-ack' : 'app-consume',
        payload: {
          requestId: requestId(),
          messageId,
          ...(senderDaemonHostId ? { senderDaemonHostId } : {}),
        },
      });
      await emitFrame(context.stdout, result);
      return;
    }
    if (kind === 'status') {
      const messageId = requireIdentitySegment(typeof command.messageId === 'string' ? command.messageId : '');
      const senderDaemonHostId = typeof command.senderDaemonHostId === 'string' && command.senderDaemonHostId
        ? command.senderDaemonHostId
        : undefined;
      const remote = command.remote === true;
      const target = remote
        ? await resolveTarget(context, String(command.peer ?? ''), typeof command.daemonHostId === 'string' ? command.daemonHostId : undefined)
        : undefined;
      const result = await connection.request({
        type: 'app-status',
        payload: {
          requestId: requestId(),
          messageId,
          ...(senderDaemonHostId ? { senderDaemonHostId } : {}),
          remote,
          ...(target ? { target } : {}),
        },
      });
      await emitFrame(context.stdout, result);
      return;
    }
    throw usage(`unsupported stream command: ${String(kind)}`);
  } catch (error) {
    await emitLocalError(context.stdout, error);
  }
}

async function runStream(args: readonly string[], context: AppCommandContext): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await writeText(context.stdout, `${STREAM_HELP}\n`);
    return 0;
  }
  const flags = parseFlags(args, ['json'], ['json']);
  void flags;
  const connection = await connectLocal(context, (frame) => {
    void emitFrame(context.stdout, frame);
  });
  await emitFrame(context.stdout, {
    type: 'app-ready',
    payload: {
      requestId: connection.ready.requestId,
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId: connection.ready.deviceId,
      daemonHostId: connection.ready.daemonHostId,
      capabilities: connection.ready.capabilities,
    },
  });
  const lines = createInterface({ input: context.stdin, crlfDelay: Infinity });
  let aborted = false;
  const abort = () => {
    aborted = true;
    connection.close();
    lines.close();
  };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const line of lines) {
      if (aborted || context.signal.aborted) break;
      if (!line.trim()) continue;
      const exitSignal = await handleStreamCommand(line, context, connection);
      if (exitSignal !== undefined) return exitSignal;
    }
    return aborted || context.signal.aborted ? 130 : 1;
  } finally {
    context.signal.removeEventListener('abort', abort);
    lines.close();
    connection.close();
  }
}

export async function runAppCommand(
  args: readonly string[],
  context: AppCommandContext,
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    await writeText(context.stderr, '用法错误：zterm app stream|send|send-file|status|ack|consume\n运行 zterm app --help 查看命令。\n');
    return 2;
  }
  if (subcommand === '--help' || subcommand === '-h') {
    await writeText(context.stdout, `${APP_HELP}\n`);
    return 0;
  }
  try {
    switch (subcommand) {
      case 'stream':
        return await runStream(rest, context);
      case 'send':
        return await runSend(rest, context);
      case 'send-file':
        return await runSendFile(rest, context);
      case 'status':
        return await runStatus(rest, context);
      case 'ack':
        return await runSettle('ack', rest, context);
      case 'consume':
        return await runSettle('consume', rest, context);
      default:
        await writeText(context.stderr, `用法错误：未知 app 命令：${subcommand}\n运行 zterm app --help 查看命令。\n`);
        return 2;
    }
  } catch (error) {
    if (context.signal.aborted) {
      await writeText(context.stderr, '操作已取消。\n');
      return 130;
    }
    await writeText(context.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof AppCliError ? error.exitCode : 1;
  }
}

import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import type {
  TerminalInputAckPayload,
  TerminalReliableInputPayload,
} from '../../shared/src/connection/protocol.js';
import {
  cliNoReplayPolicy,
  createReliableInputQueue,
  type ReliableInputQueue,
  type ReliableInputSettlement,
} from '../../shared/src/terminal/reliable-input/reliable-input-queue.js';
import type {
  SessionChannel,
  SessionConnection,
  SessionConnectionEvent,
} from './connection.js';
import {
  createMirrorConsumer,
  type MirrorBodySnapshot,
  type MirrorCommitEvent,
  type MirrorRequestMessage,
} from './mirror-consumer.js';
import type { CliSlotBinding } from './slot-store.js';

export type ExecShellKind = 'posix' | 'powershell';

export interface RunExecSessionOptions {
  binding: CliSlotBinding;
  connection: SessionConnection;
  command: string;
  shell?: ExecShellKind;
  timeoutMs?: number;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
}

export interface ExecSessionResult {
  exitCode: number;
  message?: string;
}

const DEFAULT_EXEC_COLS = 200;
const DEFAULT_EXEC_ROWS = 50;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export function detectExecShell(displayName: string): ExecShellKind {
  return /\|\s*powershell\s*\|/i.test(displayName) ? 'powershell' : 'posix';
}

export function wrapExecCommand(
  command: string,
  markerId: string,
  shell: ExecShellKind,
): string {
  if (shell === 'powershell') {
    return (
      `Write-Output ("__ZT_" + "${markerId}" + "_S__"); `
      + `${command}; `
      + `$ec = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; `
      + `Write-Output ("__ZT_" + "${markerId}" + "_E:" + $ec + "__")\r`
    );
  }
  return (
    `printf '\\n__ZT_%s_S__\\n' '${markerId}'; `
    + `${command}; `
    + `printf '\\n__ZT_%s_E:%d__\\n' '${markerId}' $?\r`
  );
}

export function extractMarkedOutput(
  lines: readonly string[],
  markerId: string,
): { matched: true; exitCode: number; output: string } | { matched: false; partialOutput?: string } {
  const startMarker = `__ZT_${markerId}_S__`;
  const endRegex = new RegExp(`__ZT_${markerId}_E:(\\d+)__`);

  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.includes(startMarker)) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return { matched: false };

  let endIndex = -1;
  let exitCode = 0;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const match = endRegex.exec(lines[i]!);
    if (match) {
      endIndex = i;
      exitCode = Number.parseInt(match[1]!, 10);
      break;
    }
  }

  const sliceEnd = endIndex >= 0 ? endIndex : lines.length;
  const captured = lines.slice(startIndex + 1, sliceEnd);
  while (captured.length > 0 && captured[0] === '') captured.shift();
  while (captured.length > 0 && captured[captured.length - 1] === '') captured.pop();
  const text = captured.join('\n');

  if (endIndex < 0) {
    return { matched: false, ...(text ? { partialOutput: text } : {}) };
  }
  return { matched: true, exitCode, output: text };
}

function snapshotBodyLines(body: MirrorBodySnapshot): string[] {
  const result: string[] = [];
  for (let index = body.startIndex; index < body.endIndex; index += 1) {
    const cells = body.lines.get(index);
    if (!cells) {
      result.push('');
      continue;
    }
    const text = cells.map((cell) => String.fromCodePoint(cell.char || 0x20)).join('').trimEnd();
    result.push(text);
  }
  return result;
}

export async function runExecSession(
  options: RunExecSessionOptions,
): Promise<ExecSessionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const shell = options.shell ?? detectExecShell(options.binding.server.displayName);
  const markerId = randomBytes(4).toString('hex');

  let channel: SessionChannel | null = null;
  let openedChannelId: string | null = null;
  let channelClosed = false;
  let commandDispatched = false;
  let settled = false;
  let reliableQueue: ReliableInputQueue | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  const openAbort = new AbortController();

  let resolveDone!: (result: ExecSessionResult) => void;
  const donePromise = new Promise<ExecSessionResult>((resolve) => {
    resolveDone = resolve;
  });

  const mirror = createMirrorConsumer({
    cacheLines: 2000,
    visibleCols: DEFAULT_EXEC_COLS,
    visibleRows: DEFAULT_EXEC_ROWS,
    sendRequest(request: MirrorRequestMessage): boolean {
      if (!channel || channelClosed || settled) return false;
      try {
        if (request.type === 'buffer-head-request') {
          channel.send({ type: 'buffer-head-request' });
        } else {
          channel.send({ type: 'buffer-sync-request', payload: request.payload });
        }
        return true;
      } catch {
        return false;
      }
    },
    onCommit(event: MirrorCommitEvent) {
      if (settled || event.sessionId !== openedChannelId) return;
      const snap = mirror.snapshot(event.sessionId);
      if (!snap || snap.body.revision === 0) return;

      if (!commandDispatched) {
        commandDispatched = true;
        const end = Math.max(snap.head?.latestEndIndex ?? DEFAULT_EXEC_ROWS, DEFAULT_EXEC_ROWS);
        mirror.setVisibleDemand(event.sessionId, {
          startIndex: Math.max(0, end - DEFAULT_EXEC_ROWS),
          endIndex: end,
          visibleRows: DEFAULT_EXEC_ROWS,
          mode: 'follow',
        });
        const wrapped = wrapExecCommand(options.command, markerId, shell);
        reliableQueue?.enqueueText(wrapped);
        return;
      }

      const end = snap.head?.latestEndIndex ?? snap.body.endIndex;
      mirror.setVisibleDemand(event.sessionId, {
        startIndex: Math.max(0, end - DEFAULT_EXEC_ROWS),
        endIndex: end,
        visibleRows: DEFAULT_EXEC_ROWS,
        mode: 'follow',
      });

      const textLines = snapshotBodyLines(snap.body);
      const extracted = extractMarkedOutput(textLines, markerId);
      if (extracted.matched) {
        if (extracted.output) {
          options.stdout.write(`${extracted.output}\n`);
        }
        void finish({ exitCode: extracted.exitCode });
      }
    },
  });

  async function finish(result: ExecSessionResult) {
    if (settled) return;
    settled = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    openAbort.abort();
    unsubscribe?.();
    unsubscribe = null;
    options.signal?.removeEventListener('abort', onAbort);
    reliableQueue?.close();
    try {
      options.connection.close('exec-complete');
    } catch {
      // Best-effort close on exec completion.
    }
    resolveDone(result);
  }

  function onAbort() {
    void finish({ exitCode: 130, message: 'zterm exec 已取消。' });
  }

  if (options.signal?.aborted) {
    return { exitCode: 130, message: 'zterm exec 已取消。' };
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });

  timeoutTimer = setTimeout(() => {
    if (settled) return;
    if (openedChannelId) {
      const snap = mirror.snapshot(openedChannelId);
      if (snap && snap.body.endIndex > snap.body.startIndex) {
        const lines = snapshotBodyLines(snap.body);
        const partial = extractMarkedOutput(lines, markerId);
        if (!partial.matched && partial.partialOutput) {
          options.stdout.write(`${partial.partialOutput}\n`);
        }
      }
    }
    void finish({
      exitCode: 124,
      message: `zterm exec 超时（${timeoutMs}ms）。`,
    });
  }, timeoutMs);

  unsubscribe = options.connection.onEvent((event: SessionConnectionEvent) => {
    if (settled) return;
    if (event.type === 'channel-opened') {
      if (
        event.sessionName !== options.binding.session.name
        || event.stableId !== options.binding.session.stableId
        || openedChannelId
      ) {
        return;
      }
      openedChannelId = event.channelId;
      mirror.registerSession(event.channelId, {
        cols: DEFAULT_EXEC_COLS,
        rows: DEFAULT_EXEC_ROWS,
      });
      return;
    }
    if (event.type === 'channel-message') {
      if (event.channelId !== openedChannelId) return;
      if (event.message.type !== 'input-ack') {
        mirror.handleMessage(event.channelId, event.message);
      }
      return;
    }
    if (event.type === 'input-ack') {
      if (event.channelId !== openedChannelId || !reliableQueue) return;
      reliableQueue.handleAck(event.payload as TerminalInputAckPayload, {
        channel: event.channelId,
        generation: `${event.channelId}:exec`,
      });
      return;
    }
    if (event.type === 'channel-closed') {
      if (event.channelId === openedChannelId) {
        channelClosed = true;
        void finish({
          exitCode: 1,
          message: `远端会话通道已关闭（${event.code || 'channel_closed'}）。`,
        });
      }
      return;
    }
    if (event.type === 'closed') {
      channelClosed = true;
      void finish({ exitCode: 1, message: '与远端 daemon 的连接已断开。' });
      return;
    }
    if (event.type === 'error') {
      void finish({ exitCode: 1, message: event.error.message });
    }
  });

  try {
    channel = await options.connection.openExisting(
      {
        backend: options.binding.session.backend,
        stableId: options.binding.session.stableId,
        sessionName: options.binding.session.name,
        cols: DEFAULT_EXEC_COLS,
        rows: DEFAULT_EXEC_ROWS,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
      openAbort.signal,
    );
    openedChannelId = channel.id;
    mirror.registerSession(channel.id, {
      cols: DEFAULT_EXEC_COLS,
      rows: DEFAULT_EXEC_ROWS,
    });
    const generation = `${channel.id}:exec`;
    const activeChannel = channel;
    reliableQueue = createReliableInputQueue({
      policy: cliNoReplayPolicy,
      readTransport: () => ({
        available: !settled && !channelClosed,
        ready: !settled && !channelClosed,
        backpressured: false,
        channel: activeChannel.id,
        generation,
      }),
      send(item) {
        if (settled || channelClosed) {
          throw new Error('input_transport_unavailable');
        }
        const payload: TerminalReliableInputPayload = {
          version: 1,
          seq: item.seq,
          data: item.data,
          sentAt: item.sentAt,
          attempt: item.attempt,
        };
        activeChannel.send({ type: 'input', payload });
      },
      onSettled: (settlement: ReliableInputSettlement) => {
        if (settlement.outcome === 'rejected' && !settled) {
          void finish({
            exitCode: 1,
            message: `远端拒绝了输入（${settlement.error?.code || 'input_rejected'}）。`,
          });
        }
      },
    });
    activeChannel.send({
      type: 'body-subscription',
      payload: {
        version: 1,
        subscribed: true,
      },
    });
  } catch (error) {
    if (!settled) {
      const msg = error instanceof Error ? error.message : String(error);
      await finish({ exitCode: 1, message: `无法打开远端会话：${msg}` });
    }
  }

  return donePromise;
}

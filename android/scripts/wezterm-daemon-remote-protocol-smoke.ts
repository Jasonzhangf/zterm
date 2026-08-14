import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { cellsToLine, normalizeWireLines } from '../../packages/shared/src/connection/terminal-buffer';
import type { TerminalBufferPayload } from '../../packages/shared/src/connection/types';
import type { ClientMessage, ServerMessage } from '../src/lib/types';

const daemonUrl = (process.env.ZTERM_WINDOWS_DAEMON_URL || 'ws://100.75.122.121:3333').replace(/\/$/, '');
const authToken = process.env.ZTERM_WINDOWS_DAEMON_AUTH_TOKEN || '';
const runMarker = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const sessionName = `zterm-live-${runMarker}`;
const inputMarker = `ZTERM_WINDOWS_DAEMON_E2E_${runMarker.replace(/-/g, '_')}`;

function withToken(url: string) {
  if (!authToken) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', authToken);
  return parsed.toString();
}

function healthUrl() {
  const parsed = new URL(daemonUrl);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/health';
  return withToken(parsed.toString());
}

class MessageInbox {
  private readonly messages: ServerMessage[] = [];
  private readonly waiters = new Set<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8')) as ServerMessage;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
      this.messages.push(message);
    });
  }

  waitFor(label: string, predicate: (message: ServerMessage) => boolean, timeoutMs = 12_000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          const bufferedTypes = this.messages
            .map((message) => message.type === 'error' ? `${message.type}:${message.payload.message}` : message.type)
            .join(',') || 'none';
          reject(new Error(`timed out waiting for daemon websocket message: ${label}; buffered=${bufferedTypes}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
}

async function openInbox() {
  const socket = new WebSocket(withToken(daemonUrl));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return new MessageInbox(socket);
}

function send(inbox: MessageInbox, message: ClientMessage) {
  inbox.socket.send(JSON.stringify(message));
}

function payloadText(payload: TerminalBufferPayload) {
  return normalizeWireLines(payload.lines || [], payload.cols)
    .map((line) => cellsToLine(line.cells))
    .join('\n');
}

function assertInitialBuffer(message: ServerMessage) {
  if (message.type !== 'buffer-sync') throw new Error(`expected buffer-sync, got ${message.type}`);
  const payload = message.payload;
  if (payload.revision < 1 || payload.endIndex < payload.startIndex || payload.cols < 1 || payload.rows < 1) {
    throw new Error(`invalid initial buffer-sync: ${JSON.stringify(payload)}`);
  }
}

async function main() {
  const response = await fetch(healthUrl(), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`daemon health failed: HTTP ${response.status}`);
  const health = await response.json();
  const control = await openInbox();
  let session: MessageInbox | null = null;
  let created = false;

  try {
    const missingName = `zterm-missing-${runMarker}`;
    const missingRequestId = `missing-${runMarker}`;
    send(control, { type: 'session-open', payload: { openRequestId: missingRequestId, sessionName: missingName, cols: 80, rows: 24 } } as ClientMessage);
    const missingTicket = await control.waitFor('missing session ticket', (message) => message.type === 'session-ticket' && message.payload.openRequestId === missingRequestId);
    if (missingTicket.type !== 'session-ticket') throw new Error('missing-session ticket absent');
    const missing = await openInbox();
    send(missing, { type: 'connect', payload: { openRequestId: missingRequestId, sessionName: missingName, cols: 80, rows: 24, sessionTransportToken: missingTicket.payload.sessionTransportToken } } as ClientMessage);
    await missing.waitFor('missing session explicit failure', (message) => message.type === 'error' || message.type === 'session-open-failed');
    missing.socket.close(1000, 'negative gate complete');

    send(control, { type: 'tmux-create-session', payload: { sessionName } } as ClientMessage);
    await control.waitFor('created session listed', (message) => message.type === 'sessions' && message.payload.sessions.includes(sessionName));
    created = true;

    const openRequestId = `open-${runMarker}`;
    send(control, { type: 'session-open', payload: { openRequestId, sessionName, cols: 80, rows: 24 } } as ClientMessage);
    const ticket = await control.waitFor('created session ticket', (message) => message.type === 'session-ticket' && message.payload.openRequestId === openRequestId);
    if (ticket.type !== 'session-ticket') throw new Error('session ticket absent');

    session = await openInbox();
    send(session, { type: 'connect', payload: { openRequestId, sessionName, cols: 80, rows: 24, sessionTransportToken: ticket.payload.sessionTransportToken } } as ClientMessage);
    await session.waitFor('created session connected', (message) => message.type === 'connected');
    const initial = await session.waitFor('created session initial buffer-sync', (message) => message.type === 'buffer-sync');
    assertInitialBuffer(initial);

    session.socket.send(`echo ${inputMarker}\r`);
    const echoed = await session.waitFor(
      'input marker buffer-sync',
      (message) => message.type === 'buffer-sync' && payloadText(message.payload).includes(inputMarker),
      20_000,
    );
    if (echoed.type !== 'buffer-sync') throw new Error('input marker was not projected as buffer-sync');

    send(control, { type: 'tmux-kill-session', payload: { sessionName } } as ClientMessage);
    await control.waitFor('targeted session cleanup list', (message) => message.type === 'sessions' && !message.payload.sessions.includes(sessionName));
    created = false;

    console.log(JSON.stringify({
      ok: true,
      daemonUrl,
      backend: (health as { backend?: unknown }).backend || 'health-backend-not-exposed',
      sessionName,
      sourceMarker: inputMarker,
      targetBufferMatched: true,
      initialRevision: initial.type === 'buffer-sync' ? initial.payload.revision : null,
      cleanup: 'targeted-session-removed',
    }, null, 2));
  } finally {
    if (created) {
      send(control, { type: 'tmux-kill-session', payload: { sessionName } } as ClientMessage);
      await control.waitFor(
        'best-effort cleanup list',
        (message) => (message.type === 'sessions' && !message.payload.sessions.includes(sessionName)) || message.type === 'error',
        8_000,
      ).catch(() => undefined);
    }
    session?.socket.close(1000, 'smoke complete');
    control.socket.close(1000, 'smoke complete');
    await delay(50);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

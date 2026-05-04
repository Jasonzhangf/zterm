import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import type {
  HostConfigMessage,
  ScheduleJobDraft,
  ServerMessage,
} from '../lib/types';
import type {
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalAttachPayload,
  TerminalTransportConnection,
} from './terminal-runtime-types';

export interface TerminalMessageControlRuntimeDeps {
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  issueSessionTransportToken: () => string;
  consumeSessionTransportToken: (token: string) => boolean;
  scheduleEngine: {
    listBySession: (sessionName: string) => ScheduleJob[];
    upsert: (job: ScheduleJobDraft) => void;
    delete: (jobId: string) => void;
    toggle: (jobId: string, enabled: boolean) => void;
    runNow: (jobId: string) => Promise<unknown>;
    renameSession: (currentName: string, nextName: string) => void;
    markSessionMissing: (sessionName: string, reason: string) => void;
  };
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  sendScheduleStateToSession: (session: TerminalSession, sessionName?: string) => void;
  listTmuxSessions: () => string[];
  createDetachedTmuxSession: (sessionName?: string) => string;
  renameTmuxSession: (currentName?: string, nextName?: string) => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  sanitizeSessionName: (input?: string) => string;
  createTransportBoundSession: (connection: TerminalTransportConnection) => TerminalSession;
  bindConnectionToSession: (
    connection: TerminalTransportConnection,
    session: TerminalSession,
  ) => TerminalSession;
  getMirrorKey: (sessionName: string) => string;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeLogicalSessions?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
}

export function handleSessionOpenMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  payload: HostConfigMessage,
) {
  connection.role = 'control';
  connection.boundSessionId = null;
  const sessionName = deps.sanitizeSessionName(payload.sessionName);
  const sessionTransportToken = deps.issueSessionTransportToken();
  // Compatibility-only attach handshake:
  // - openRequestId remains client-local request correlation
  // - session-ticket / sessionTransportToken remain attach-only wire material
  // - daemon must not promote either into daemon-owned long-lived business truth
  // - daemon does not keep openRequestId as token owner; token is one-shot attach proof only
  deps.sendTransportMessage(connection.transport, {
    type: 'session-ticket',
    payload: {
      openRequestId: payload.openRequestId,
      clientSessionId: payload.clientSessionId?.trim() || undefined,
      sessionTransportToken,
      sessionName,
    },
  });
  return null;
}

export function handleSessionTransportConnectRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  payload: HostConfigMessage,
) {
  // The token is only a one-shot attach proof for this transport connection.
  const token = (payload.sessionTransportToken || '').trim();
  if (!token || !deps.consumeSessionTransportToken(token)) {
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: {
        message: 'Invalid transport attach token',
        code: 'transport_attach_invalid',
      },
    });
    connection.closeTransport('transport attach invalid');
    return null;
  }
  const serverSession = deps.createTransportBoundSession(connection);
  return deps.bindConnectionToSession(connection, serverSession);
}

export function handleListSessionsMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
) {
  try {
    deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    deps.sendTransportMessage(connection.transport, {
      type: 'error',
      payload: { message: `Failed to list tmux sessions: ${err}`, code: 'list_sessions_failed' },
    });
  }
}

export function handleScheduleMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  session: TerminalSession | null,
  message:
    | { type: 'schedule-list'; payload: { sessionName: string } }
    | { type: 'schedule-upsert'; payload: { job: ScheduleJobDraft } }
    | { type: 'schedule-delete'; payload: { jobId: string } }
    | { type: 'schedule-toggle'; payload: { jobId: string; enabled: boolean } }
    | { type: 'schedule-run-now'; payload: { jobId: string } },
  transport: TerminalSessionTransport | null | undefined,
) {
  if (!session) {
    deps.sendTransportMessage(transport, {
      type: 'error',
      payload: { message: `${message.type} requires an attached session transport`, code: 'session_required' },
    });
    return;
  }

  switch (message.type) {
    case 'schedule-list':
      deps.sendScheduleStateToSession(session, deps.sanitizeSessionName(message.payload.sessionName || session.sessionName));
      return;
    case 'schedule-upsert':
      try {
        const normalized = normalizeScheduleDraft(
          {
            ...message.payload.job,
            targetSessionName: deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName),
          },
          {
            now: new Date(),
            existing: message.payload.job.id
              ? deps.scheduleEngine.listBySession(
                deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName),
              ).find((job) => job.id === message.payload.job.id) || null
              : null,
          },
        );
        if (!normalized.targetSessionName) {
          deps.sendMessage(session, {
            type: 'error',
            payload: { message: 'Missing target session', code: 'schedule_invalid_target' },
          });
          return;
        }
        deps.scheduleEngine.upsert({
          ...message.payload.job,
          targetSessionName: normalized.targetSessionName,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: `Failed to save schedule: ${err}`, code: 'schedule_upsert_failed' },
        });
      }
      return;
    case 'schedule-delete':
      deps.scheduleEngine.delete(message.payload.jobId);
      return;
    case 'schedule-toggle':
      deps.scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled));
      return;
    case 'schedule-run-now':
      void deps.scheduleEngine.runNow(message.payload.jobId);
      return;
  }
}

export function handleTmuxControlMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  message:
    | { type: 'tmux-create-session'; payload: { sessionName: string } }
    | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string } }
    | { type: 'tmux-kill-session'; payload: { sessionName: string } },
) {
  switch (message.type) {
    case 'tmux-create-session':
      try {
        deps.createDetachedTmuxSession(message.payload.sessionName);
        deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to create tmux session: ${err}`, code: 'tmux_create_failed' },
        });
      }
      return;
    case 'tmux-rename-session':
      try {
        const currentName = deps.sanitizeSessionName(message.payload.sessionName);
        const nextName = deps.renameTmuxSession(message.payload.sessionName, message.payload.nextSessionName);
        const currentKey = deps.getMirrorKey(currentName);
        const nextKey = deps.getMirrorKey(nextName);
        deps.scheduleEngine.renameSession(currentName, nextName);
        const mirror = deps.mirrors.get(currentKey);
        if (mirror && currentKey !== nextKey) {
          deps.mirrors.delete(currentKey);
          mirror.key = nextKey;
          mirror.sessionName = nextKey;
          deps.mirrors.set(nextKey, mirror);
          for (const sessionId of mirror.subscribers) {
            const client = deps.sessions.get(sessionId);
            if (!client) {
              continue;
            }
            client.mirrorKey = nextKey;
            client.sessionName = nextKey;
            deps.sendMessage(client, { type: 'title', payload: nextKey });
          }
        }
        deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to rename tmux session: ${err}`, code: 'tmux_rename_failed' },
        });
      }
      return;
    case 'tmux-kill-session':
      try {
        const sessionName = deps.sanitizeSessionName(message.payload.sessionName);
        deps.runTmux(['kill-session', '-t', sessionName]);
        deps.scheduleEngine.markSessionMissing(sessionName, 'session killed');
        const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
        if (mirror) {
          deps.destroyMirror(mirror, 'tmux session killed', {
            closeLogicalSessions: false,
            releaseCode: 'tmux_session_killed',
          });
        }
        deps.sendTransportMessage(connection.transport, { type: 'sessions', payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to kill tmux session: ${err}`, code: 'tmux_kill_failed' },
        });
      }
      return;
  }
}

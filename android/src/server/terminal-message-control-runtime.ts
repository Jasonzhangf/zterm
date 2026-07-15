import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import type {
  HostConfigMessage,
  ScheduleJobDraft,
  ServerMessage,
} from '../lib/types';
import type {
  TerminalTransportSubscriber,
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalAttachPayload,
  TerminalTransportConnection,
} from './terminal-runtime-types';

export interface TerminalMessageControlRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  mirrors: Map<string, SessionMirror>;
  issueSessionTransportToken: () => string;
  consumeSessionTransportToken: (token: string) => boolean;
  scheduleEngine: {
    listBySession: (sessionName: string) => ScheduleJob[];
    upsert: (job: ScheduleJobDraft) => void;
    delete: (jobId: string) => ScheduleJob | null;
    toggle: (jobId: string, enabled: boolean) => ScheduleJob | null;
    runNow: (jobId: string) => Promise<unknown>;
    renameSession: (currentName: string, nextName: string) => void;
    markSessionMissing: (sessionName: string, reason: string) => void;
  };
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: TerminalTransportSubscriber, message: ServerMessage) => void;
  sendScheduleStateToSession: (session: TerminalTransportSubscriber, sessionName?: string) => void;
  listTmuxSessions: () => string[];
  createDetachedTmuxSession: (sessionName?: string, cwd?: string) => string;
  closeDetachedTerminalSession: (sessionName: string) => void;
  renameTmuxSession: (currentName?: string, nextName?: string) => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  sanitizeSessionName: (input?: string) => string;
  createTransportSubscriber: (connection: TerminalTransportConnection) => TerminalTransportSubscriber;
  bindConnectionToSubscriber: (
    connection: TerminalTransportConnection,
    subscriber: TerminalTransportSubscriber,
  ) => TerminalTransportSubscriber;
  getMirrorKey: (sessionName: string) => string;
  attachTmux: (session: TerminalTransportSubscriber, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize?: (
    session: TerminalTransportSubscriber,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string };
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
}

export function handleSessionOpenMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  payload: HostConfigMessage,
) {
  connection.role = 'control';
  connection.boundSubscriberId = null;
  const sessionName = deps.sanitizeSessionName(payload.sessionName);
  const sessionTransportToken = deps.issueSessionTransportToken();
  console.log(
    `[server] session-open transport=${connection.transportId} openRequestId=${payload.openRequestId || 'n/a'} session=${sessionName}`,
  );
  // Attach handshake:
  // - openRequestId is wire correlation only and is not daemon-owned state
  // - session-ticket / sessionTransportToken remain attach-only wire material
  // - daemon does not keep openRequestId as token owner; token is one-shot attach proof only
  deps.sendTransportMessage(connection.transport, {
    type: 'session-ticket',
    payload: {
      openRequestId: payload.openRequestId,
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
    console.warn(
      `[server] transport-attach-invalid transport=${connection.transportId} openRequestId=${payload.openRequestId || 'n/a'} session=${deps.sanitizeSessionName(payload.sessionName)} tokenPresent=${token ? 'yes' : 'no'}`,
    );
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
  console.log(
    `[server] transport-attach-ok transport=${connection.transportId} openRequestId=${payload.openRequestId || 'n/a'} session=${deps.sanitizeSessionName(payload.sessionName)}`,
  );
  const subscriber = deps.createTransportSubscriber(connection);
  return deps.bindConnectionToSubscriber(connection, subscriber);
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
  function sendScheduleError(
    targetSession: TerminalSession,
    payload: {
      operation: 'list' | 'upsert' | 'delete' | 'toggle' | 'run-now';
      jobId?: string;
      code: string;
      message: string;
      sessionName?: string;
    },
  ) {
    deps.sendMessage(targetSession, {
      type: 'schedule-error',
      payload: {
        sessionName: deps.sanitizeSessionName(payload.sessionName || targetSession.sessionName),
        operation: payload.operation,
        jobId: payload.jobId,
        code: payload.code,
        message: payload.message,
      },
    });
  }

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
          sendScheduleError(session, {
            operation: 'upsert',
            code: 'schedule_invalid_target',
            message: 'Missing target session',
          });
          return;
        }
        deps.scheduleEngine.upsert({
          ...message.payload.job,
          targetSessionName: normalized.targetSessionName,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: 'upsert',
          jobId: message.payload.job.id,
          code: 'schedule_upsert_failed',
          message: `Failed to save schedule: ${err}`,
          sessionName: message.payload.job.targetSessionName,
        });
      }
      return;
    case 'schedule-delete':
      if (!deps.scheduleEngine.delete(message.payload.jobId)) {
        sendScheduleError(session, {
          operation: 'delete',
          jobId: message.payload.jobId,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        });
      }
      return;
    case 'schedule-toggle':
      if (!deps.scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled))) {
        sendScheduleError(session, {
          operation: 'toggle',
          jobId: message.payload.jobId,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        });
      }
      return;
    case 'schedule-run-now':
      void deps.scheduleEngine.runNow(message.payload.jobId).then((job) => {
        if (!job) {
          sendScheduleError(session, {
            operation: 'run-now',
            jobId: message.payload.jobId,
            code: 'schedule_job_not_found',
            message: 'Schedule job no longer exists',
          });
        }
      }).catch((error) => {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: 'run-now',
          jobId: message.payload.jobId,
          code: 'schedule_run_now_failed',
          message: `Failed to run schedule: ${err}`,
        });
      });
      return;
  }
}

export function handleTmuxControlMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  message:
    | { type: 'tmux-create-session'; payload: { sessionName: string; cwd?: string } }
    | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string } }
    | { type: 'tmux-kill-session'; payload: { sessionName: string } },
) {
  switch (message.type) {
    case 'tmux-create-session':
      try {
        deps.createDetachedTmuxSession(message.payload.sessionName, message.payload.cwd);
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
            const subscriber = deps.sessions.get(sessionId);
            if (!subscriber) {
              continue;
            }
            subscriber.mirrorKey = nextKey;
            subscriber.sessionName = nextKey;
            deps.sendMessage(subscriber, { type: 'title', payload: nextKey });
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
        deps.closeDetachedTerminalSession(sessionName);
        deps.scheduleEngine.markSessionMissing(sessionName, 'session killed');
        const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
        if (mirror) {
          deps.destroyMirror(mirror, 'tmux session killed', {
            closeTransportSubscribers: false,
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

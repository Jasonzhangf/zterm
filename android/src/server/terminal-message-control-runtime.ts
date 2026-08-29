import { normalizeScheduleDraft } from '../../../packages/shared/src/schedule/next-fire.ts';
import { publishSessionActivitiesRuntime } from './terminal-session-activity-runtime';
import { buildSessionsCatalogPayload } from './daemon-session-catalog-runtime';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import type {
  BridgeServerMessage as ServerMessage,
  HostConfigMessage,
  TerminalSessionCatalogEntry,
  TerminalTransportServerFrame,
} from '@zterm/shared/protocol';
import type {
  ScheduleJobDraft,
} from '@zterm/shared/schedule-types';
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
    listBySession: (sessionName: string, backend?: 'tmux' | 'herdr') => ScheduleJob[];
    upsert: (job: ScheduleJobDraft) => void;
    delete: (jobId: string) => ScheduleJob | null;
    toggle: (jobId: string, enabled: boolean) => ScheduleJob | null;
    runNow: (jobId: string) => Promise<unknown>;
    renameSession: (currentName: string, nextName: string, backend?: 'tmux' | 'herdr') => void;
    markSessionMissing: (sessionName: string, reason: string, backend?: 'tmux' | 'herdr') => void;
  };
  sendTransportMessage: (transport: TerminalSessionTransport | null | undefined, message: TerminalTransportServerFrame) => void;
  sendMessage: (session: TerminalTransportSubscriber, message: ServerMessage) => void;
  sendScheduleStateToSession: (
    session: TerminalTransportSubscriber,
    sessionName?: string,
    backend?: 'tmux' | 'herdr',
  ) => void;
  listTmuxSessions: (backend?: 'tmux' | 'herdr') => string[];
  listTerminalSessions?: () => string[];
  listTerminalSessionCatalog?: () => TerminalSessionCatalogEntry[];
  runTmux: (args: string[]) => { ok: true; stdout: string } | { ok: false; error: string };
  observationHistory?: Map<string, import('./daemon-session-agent-status-runtime').DaemonSessionObservationHistoryEntry>;
  readProcessGroup?: (pid: string) => { groupId: string; alive: boolean } | undefined;
  resolveTerminalSessionBackend?: (sessionName: string) => 'tmux' | 'herdr';
  createDetachedTmuxSession: (sessionName?: string, cwd?: string, backend?: 'tmux' | 'herdr') => string;
  closeDetachedTerminalSession: (sessionName: string, backend?: 'tmux' | 'herdr') => void;
  renameTmuxSession: (currentName?: string, nextName?: string, backend?: 'tmux' | 'herdr') => string;
  sanitizeSessionName: (input?: string) => string;
  createTransportSubscriber: (connection: TerminalTransportConnection) => TerminalTransportSubscriber;
  bindConnectionToSubscriber: (
    connection: TerminalTransportConnection,
    subscriber: TerminalTransportSubscriber,
  ) => TerminalTransportSubscriber;
  getMirrorKey: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  attachTmux: (session: TerminalTransportSubscriber, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize?: (
    session: TerminalTransportSubscriber,
    payload: { cols?: number; rows?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string };
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
}

export type DaemonControlHandlerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

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
  subscriber.backend = payload.backend || deps.resolveTerminalSessionBackend?.(payload.sessionName);
  if (!subscriber.backend) {
    throw new Error(`terminal session backend resolver unavailable for ${payload.sessionName}`);
  }
  return deps.bindConnectionToSubscriber(connection, subscriber);
}

export async function handleScheduleMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  session: TerminalSession | null,
  message:
    | { type: 'schedule-list'; payload: { sessionName: string } }
    | { type: 'schedule-upsert'; payload: { job: ScheduleJobDraft } }
    | { type: 'schedule-delete'; payload: { jobId: string } }
    | { type: 'schedule-toggle'; payload: { jobId: string; enabled: boolean } }
    | { type: 'schedule-run-now'; payload: { jobId: string } },
  transport: TerminalSessionTransport | null | undefined,
): Promise<DaemonControlHandlerResult> {
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
    return { ok: false, code: 'session_required', message: `${message.type} requires an attached session transport` };
  }

  if (session.backend === 'herdr') {
    sendScheduleError(session, {
      operation: message.type === 'schedule-list'
        ? 'list'
        : message.type === 'schedule-upsert'
          ? 'upsert'
          : message.type === 'schedule-delete'
            ? 'delete'
            : message.type === 'schedule-toggle'
              ? 'toggle'
              : 'run-now',
      jobId: message.type === 'schedule-upsert'
        ? message.payload.job.id
        : message.type === 'schedule-delete' || message.type === 'schedule-toggle' || message.type === 'schedule-run-now'
          ? message.payload.jobId
          : undefined,
      code: 'herdr_schedule_unsupported',
      message: 'Herdr single-session backend does not support schedule commands',
    });
    return {
      ok: false,
      code: 'herdr_schedule_unsupported',
      message: 'Herdr single-session backend does not support schedule commands',
    };
  }

  switch (message.type) {
    case 'schedule-list':
      deps.sendScheduleStateToSession(
        session,
        deps.sanitizeSessionName(message.payload.sessionName || session.sessionName),
        session.backend || 'tmux',
      );
      return { ok: true };
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
                session.backend || 'tmux',
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
          return {
            ok: false,
            code: 'schedule_invalid_target',
            message: 'Missing target session',
          };
        }
        deps.scheduleEngine.upsert({
          ...message.payload.job,
          terminalBackend: session.backend || 'tmux',
          targetSessionName: normalized.targetSessionName,
        });
        return { ok: true };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: 'upsert',
          jobId: message.payload.job.id,
          code: 'schedule_upsert_failed',
          message: `Failed to save schedule: ${err}`,
          sessionName: message.payload.job.targetSessionName,
        });
        return {
          ok: false,
          code: 'schedule_upsert_failed',
          message: `Failed to save schedule: ${err}`,
        };
      }
    case 'schedule-delete':
      if (!deps.scheduleEngine.delete(message.payload.jobId)) {
        sendScheduleError(session, {
          operation: 'delete',
          jobId: message.payload.jobId,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        });
        return {
          ok: false,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        };
      }
      return { ok: true };
    case 'schedule-toggle':
      if (!deps.scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled))) {
        sendScheduleError(session, {
          operation: 'toggle',
          jobId: message.payload.jobId,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        });
        return {
          ok: false,
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
        };
      }
      return { ok: true };
    case 'schedule-run-now':
      try {
        const job = await deps.scheduleEngine.runNow(message.payload.jobId);
        if (!job) {
          sendScheduleError(session, {
            operation: 'run-now',
            jobId: message.payload.jobId,
            code: 'schedule_job_not_found',
            message: 'Schedule job no longer exists',
          });
          return {
            ok: false,
            code: 'schedule_job_not_found',
            message: 'Schedule job no longer exists',
          };
        }
        return { ok: true };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: 'run-now',
          jobId: message.payload.jobId,
          code: 'schedule_run_now_failed',
          message: `Failed to run schedule: ${err}`,
        });
        return {
          ok: false,
          code: 'schedule_run_now_failed',
          message: `Failed to run schedule: ${err}`,
        };
      }
  }
}

export function handleTmuxControlMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
  message:
    | { type: 'tmux-create-session'; payload: { sessionName: string; cwd?: string; terminalBackend?: 'tmux' | 'herdr' } }
    | { type: 'tmux-rename-session'; payload: { sessionName: string; nextSessionName: string; terminalBackend?: 'tmux' | 'herdr' } }
    | { type: 'tmux-kill-session'; payload: { sessionName: string; terminalBackend?: 'tmux' | 'herdr' } },
): DaemonControlHandlerResult {
  switch (message.type) {
      case 'tmux-create-session':
      try {
        const backend = message.payload.terminalBackend || 'tmux';
        deps.createDetachedTmuxSession(message.payload.sessionName, message.payload.cwd, backend);
        deps.sendTransportMessage(connection.transport, {
          type: 'sessions',
          payload: buildSessionsCatalogPayload(deps),
        });
        return { ok: true };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to create tmux session: ${err}`, code: 'tmux_create_failed' },
        });
        return {
          ok: false,
          code: 'tmux_create_failed',
          message: `Failed to create tmux session: ${err}`,
        };
      }
    case 'tmux-rename-session':
      {
        // Capability pre-check: Herdr is a single-session backend and never supports
        // session rename. Reject early with a typed error so clients can branch on
        // the specific cause instead of the generic tmux_rename_failed projection.
        const renameBackend = message.payload.terminalBackend
          || deps.resolveTerminalSessionBackend?.(message.payload.sessionName);
        if (!renameBackend) {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: {
              message: `Failed to rename tmux session: terminal session backend resolver unavailable for ${message.payload.sessionName}`,
              code: 'tmux_rename_failed',
            },
          });
          return {
            ok: false,
            code: 'tmux_rename_failed',
            message: `Failed to rename tmux session: terminal session backend resolver unavailable for ${message.payload.sessionName}`,
          };
        }
        if (renameBackend === 'herdr') {
          deps.sendTransportMessage(connection.transport, {
            type: 'error',
            payload: {
              message: 'Failed to rename tmux session: Herdr single-session backend does not support session rename',
              code: 'herdr_rename_unsupported',
            },
          });
          return {
            ok: false,
            code: 'herdr_rename_unsupported',
            message: 'Herdr single-session backend does not support session rename',
          };
        }
      }
      try {
        const currentName = deps.sanitizeSessionName(message.payload.sessionName);
        const backend = message.payload.terminalBackend
          || deps.resolveTerminalSessionBackend?.(message.payload.sessionName);
        if (!backend) {
          throw new Error(`terminal session backend resolver unavailable for ${message.payload.sessionName}`);
        }
        const nextName = deps.renameTmuxSession(message.payload.sessionName, message.payload.nextSessionName, backend);
        const currentKey = deps.getMirrorKey(currentName, backend);
        const nextKey = deps.getMirrorKey(nextName, backend);
        deps.scheduleEngine.renameSession(currentName, nextName, backend);
        const mirror = deps.mirrors.get(currentKey);
        if (mirror && currentKey !== nextKey) {
          deps.mirrors.delete(currentKey);
          mirror.key = nextKey;
          mirror.sessionName = nextName;
          deps.mirrors.set(nextKey, mirror);
          for (const sessionId of mirror.subscribers) {
            const subscriber = deps.sessions.get(sessionId);
            if (!subscriber) {
              continue;
            }
            subscriber.mirrorKey = nextKey;
            subscriber.sessionName = nextName;
            deps.sendMessage(subscriber, { type: 'title', payload: nextName });
          }
        }
        deps.sendTransportMessage(connection.transport, {
          type: 'sessions',
          payload: buildSessionsCatalogPayload(deps),
        });
        return { ok: true };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to rename tmux session: ${err}`, code: 'tmux_rename_failed' },
        });
        return {
          ok: false,
          code: 'tmux_rename_failed',
          message: `Failed to rename tmux session: ${err}`,
        };
      }
    case 'tmux-kill-session':
      try {
        const sessionName = deps.sanitizeSessionName(message.payload.sessionName);
        const killBackend = message.payload.terminalBackend
          || deps.resolveTerminalSessionBackend?.(sessionName);
        if (!killBackend) {
          throw new Error(`terminal session backend resolver unavailable for ${sessionName}`);
        }
        deps.closeDetachedTerminalSession(sessionName, killBackend);
        deps.scheduleEngine.markSessionMissing(sessionName, 'session killed', killBackend);
        const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName, killBackend));
        if (mirror) {
          deps.destroyMirror(mirror, 'tmux session killed', {
            closeTransportSubscribers: false,
            releaseCode: 'tmux_session_killed',
          });
        }
        deps.sendTransportMessage(connection.transport, {
          type: 'sessions',
          payload: buildSessionsCatalogPayload(deps),
        });
        return { ok: true };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        if (/can't find session|no server running|session not found/i.test(err)) {
          const sessionName = deps.sanitizeSessionName(message.payload.sessionName);
          const killBackend = message.payload.terminalBackend
            || deps.resolveTerminalSessionBackend?.(sessionName);
          if (!killBackend) {
            deps.sendTransportMessage(connection.transport, {
              type: 'error',
              payload: { message: err, code: 'tmux_kill_failed' },
            });
            return {
              ok: false,
              code: 'tmux_kill_failed',
              message: err,
            };
          }
          // Killing an already absent session is an idempotent terminal state.
          // Publish the current daemon list so drawer projections remove stale rows.
          deps.scheduleEngine.markSessionMissing(sessionName, 'session already absent', killBackend);
          const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName, killBackend));
          if (mirror) {
            deps.destroyMirror(mirror, 'tmux session already absent', {
              closeTransportSubscribers: false,
              releaseCode: 'tmux_session_killed',
            });
          }
          deps.sendTransportMessage(connection.transport, {
            type: 'sessions',
            payload: buildSessionsCatalogPayload(deps),
          });
          return { ok: true };
        }
        deps.sendTransportMessage(connection.transport, {
          type: 'error',
          payload: { message: `Failed to kill tmux session: ${err}`, code: 'tmux_kill_failed' },
        });
        return {
          ok: false,
          code: 'tmux_kill_failed',
          message: `Failed to kill tmux session: ${err}`,
        };
      }
  }
}
export function handleMuxChannelOpenedMessageRuntime(
  deps: TerminalMessageControlRuntimeDeps,
  connection: TerminalTransportConnection,
) {
  publishSessionActivitiesRuntime({
    connection,
    mirrors: deps.mirrors,
    now: Date.now(),
    sendTransportMessage: deps.sendTransportMessage,
  });
}

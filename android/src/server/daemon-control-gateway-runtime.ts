import {
  createControlCommand,
  errorControlOutcome,
  okControlOutcome,
  type ControlAuditEntry,
  type ControlCenterError,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';
import {
  handleScheduleMessageRuntime,
  handleSessionOpenMessageRuntime,
  handleSessionTransportConnectRuntime,
  handleTmuxControlMessageRuntime,
  type DaemonControlHandlerResult,
  type TerminalMessageControlRuntimeDeps,
} from './terminal-message-control-runtime';
import { handleListSessionsMessageRuntime } from './daemon-session-catalog-runtime';
import {
  DaemonControlCenter,
  type DaemonControlExecutionRequest,
} from './daemon-control-center-runtime';
import type { HostConfigMessage } from '@zterm/shared/protocol';
import type {
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
  TerminalTransportSubscriber,
} from './terminal-runtime-types';

export type DaemonScheduleControlMessage =
  | { readonly type: 'schedule-list'; readonly payload: { readonly sessionName: string } }
  | { readonly type: 'schedule-upsert'; readonly payload: { readonly job: import('@zterm/shared/schedule-types').ScheduleJobDraft } }
  | { readonly type: 'schedule-delete'; readonly payload: { readonly jobId: string } }
  | { readonly type: 'schedule-toggle'; readonly payload: { readonly jobId: string; readonly enabled: boolean } }
  | { readonly type: 'schedule-run-now'; readonly payload: { readonly jobId: string } };

export type DaemonTmuxControlMessage =
  | {
      readonly type: 'tmux-create-session';
      readonly payload: { readonly sessionName: string; readonly cwd?: string };
    }
  | {
      readonly type: 'tmux-rename-session';
      readonly payload: { readonly sessionName: string; readonly nextSessionName: string };
    }
  | {
      readonly type: 'tmux-kill-session';
      readonly payload: { readonly sessionName: string };
    };

export type DaemonControlGatewayDeps = TerminalMessageControlRuntimeDeps;

export interface DaemonControlGatewayRuntime {
  handleSessionOpen(
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ): TerminalTransportSubscriber | null;
  handleSessionTransportConnect(
    connection: TerminalTransportConnection,
    payload: HostConfigMessage,
  ): TerminalTransportSubscriber | null;
  handleListSessions(
    connection: TerminalTransportConnection,
    message: { readonly type: 'list-sessions'; readonly payload?: { readonly terminalBackend?: 'tmux' | 'herdr' } },
  ): void;
  handleScheduleControl(
    session: TerminalSession | null,
    message: DaemonScheduleControlMessage,
    transport: TerminalSessionTransport | null | undefined,
    subject: string,
  ): Promise<ControlOutcome<{ readonly dispatched: true }, ControlCenterError>>;
  handleTmuxControl(
    connection: TerminalTransportConnection,
    message: DaemonTmuxControlMessage,
  ): Promise<ControlOutcome<{ readonly dispatched: true }, ControlCenterError>>;
  getAuditEntries(): readonly ControlAuditEntry[];
}

interface DaemonScheduleControlContext {
  readonly session: TerminalSession | null;
  readonly transport: TerminalSessionTransport | null | undefined;
}

interface DaemonTmuxControlContext {
  readonly connection: TerminalTransportConnection;
}

const daemonControlCapability = 'daemon:control';
const daemonControlDeadlineMs = 5_000;

export function createDaemonControlGateway(
  deps: TerminalMessageControlRuntimeDeps,
): DaemonControlGatewayRuntime {
  const center = new DaemonControlCenter({
    defaultDeadlineMs: daemonControlDeadlineMs,
    maxAuditEntries: 500,
  });
  let commandSequence = 0;

  function executeCommand<C, CTX, R>(
    commandType: string,
    params: C,
    context: Readonly<CTX>,
    subject: string,
  ): Promise<ControlOutcome<R, ControlCenterError>> {
    commandSequence += 1;
    const commandId = `${commandType}:${subject}:${commandSequence}`;
    const request: DaemonControlExecutionRequest<C, CTX> = {
      command: createControlCommand(commandType, commandId, commandId, params),
      subject,
      capabilities: [daemonControlCapability],
      context,
      deadlineMs: daemonControlDeadlineMs,
    };
    return center.execute<C, CTX, R, never>(request);
  }

  for (const commandType of [
    'schedule-list',
    'schedule-upsert',
    'schedule-delete',
    'schedule-toggle',
    'schedule-run-now',
  ] as const) {
    center.register<DaemonScheduleControlMessage, { readonly dispatched: true }, ControlCenterError, DaemonScheduleControlContext>(
      commandType,
      {
        ownerId: `daemon.control_center:${commandType}`,
        async execute(command, context) {
          const result = await handleScheduleMessageRuntime(
            deps,
            context.session,
            command.params,
            context.transport,
          );
          return toControlHandlerOutcome(result, command.commandType);
        },
      },
      daemonControlCapability,
    );
  }

  for (const commandType of [
    'tmux-create-session',
    'tmux-rename-session',
    'tmux-kill-session',
  ] as const) {
    center.register<DaemonTmuxControlMessage, { readonly dispatched: true }, ControlCenterError, DaemonTmuxControlContext>(
      commandType,
      {
        ownerId: `daemon.control_center:${commandType}`,
        async execute(command, context) {
          const result = handleTmuxControlMessageRuntime(deps, context.connection, command.params);
          return toControlHandlerOutcome(result, command.commandType);
        },
      },
      daemonControlCapability,
    );
  }

  return {
    handleSessionOpen(connection, payload) {
      return handleSessionOpenMessageRuntime(deps, connection, payload);
    },
    handleSessionTransportConnect(connection, payload) {
      return handleSessionTransportConnectRuntime(deps, connection, payload);
    },
    handleListSessions(connection, message) {
      handleListSessionsMessageRuntime(deps, connection, message);
    },
    async handleScheduleControl(session, message, transport, subject) {
      return executeCommand<DaemonScheduleControlMessage, DaemonScheduleControlContext, { readonly dispatched: true }>(
        message.type,
        message,
        { session, transport },
        subject,
      );
    },
    async handleTmuxControl(connection, message) {
      return executeCommand<DaemonTmuxControlMessage, DaemonTmuxControlContext, { readonly dispatched: true }>(
        message.type,
        message,
        { connection },
        connection.transportId,
      );
    },
    getAuditEntries() {
      return center.getAuditEntries();
    },
  };
}

function toControlHandlerOutcome(
  result: DaemonControlHandlerResult,
  commandType: string,
): ReturnType<typeof okControlOutcome<{ readonly dispatched: true }>> | ReturnType<typeof errorControlOutcome<ControlCenterError>> {
  return result.ok
    ? okControlOutcome({ dispatched: true })
    : errorControlOutcome({
        code: 'handler_failed',
        commandType,
        message: result.message,
      });
}

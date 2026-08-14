import type {
  ScheduleEventPayload,
  ScheduleStatePayload,
} from '@zterm/shared/schedule-types';
import type { BridgeServerMessage as ServerMessage } from '@zterm/shared/protocol';
import { ScheduleEngine, type ScheduleExecutionResult } from './schedule-engine';
import type { TerminalSession } from './terminal-runtime-types';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';

export interface TerminalScheduleRuntimeDeps {
  initialJobs: ScheduleJob[];
  saveJobs: (jobs: ScheduleJob[]) => void;
  executeJob: (job: ScheduleJob) => Promise<ScheduleExecutionResult> | ScheduleExecutionResult;
  sessions: Map<string, TerminalSession>;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
}

export interface TerminalScheduleRuntime {
  scheduleEngine: ScheduleEngine;
  sendScheduleStateToSession: (session: TerminalSession, sessionName?: string) => void;
  dispose: () => void;
}

export function createTerminalScheduleRuntime(
  deps: TerminalScheduleRuntimeDeps,
): TerminalScheduleRuntime {
  function buildScheduleStatePayload(sessionName: string, terminalBackend: 'tmux' | 'herdr'): ScheduleStatePayload {
    return {
      sessionName,
      terminalBackend,
      jobs: scheduleEngine.listBySession(sessionName, terminalBackend),
    };
  }

  function sendScheduleStateToSession(
    session: TerminalSession,
    sessionName = session.sessionName,
    terminalBackend = session.backend || 'tmux',
  ) {
    if (!sessionName) {
      return;
    }
    deps.sendMessage(session, {
      type: 'schedule-state',
      payload: buildScheduleStatePayload(sessionName, terminalBackend),
    });
  }

  function broadcastScheduleState(sessionName: string, terminalBackend: 'tmux' | 'herdr') {
    if (!sessionName) {
      return;
    }
    for (const session of deps.sessions.values()) {
      if (session.sessionName !== sessionName || (session.backend || 'tmux') !== terminalBackend) {
        continue;
      }
      sendScheduleStateToSession(session, sessionName, terminalBackend);
    }
  }

  function broadcastScheduleEvent(event: ScheduleEventPayload) {
    for (const session of deps.sessions.values()) {
      if (
        session.sessionName !== event.sessionName
        || (session.backend || 'tmux') !== (event.terminalBackend || 'tmux')
      ) {
        continue;
      }
      deps.sendMessage(session, {
        type: 'schedule-event',
        payload: event,
      });
    }
  }

  const scheduleEngine = new ScheduleEngine({
    initialJobs: deps.initialJobs,
    saveJobs: deps.saveJobs,
    executeJob: deps.executeJob,
    onStateChange: (sessionName, _jobs, terminalBackend = 'tmux') => {
      broadcastScheduleState(sessionName, terminalBackend);
    },
    onEvent: (event) => {
      broadcastScheduleEvent(event);
    },
  });

  return {
    scheduleEngine,
    sendScheduleStateToSession,
    dispose: () => {
      scheduleEngine.dispose();
    },
  };
}

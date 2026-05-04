import type { ScheduleEventPayload, ScheduleStatePayload } from '../lib/types';
import type { ServerMessage } from '../lib/types';
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
  function buildScheduleStatePayload(sessionName: string): ScheduleStatePayload {
    return {
      sessionName,
      jobs: scheduleEngine.listBySession(sessionName),
    };
  }

  function sendScheduleStateToSession(session: TerminalSession, sessionName = session.sessionName) {
    if (!sessionName) {
      return;
    }
    deps.sendMessage(session, {
      type: 'schedule-state',
      payload: buildScheduleStatePayload(sessionName),
    });
  }

  function broadcastScheduleState(sessionName: string) {
    if (!sessionName) {
      return;
    }
    for (const session of deps.sessions.values()) {
      if (session.sessionName !== sessionName) {
        continue;
      }
      sendScheduleStateToSession(session, sessionName);
    }
  }

  function broadcastScheduleEvent(event: ScheduleEventPayload) {
    for (const session of deps.sessions.values()) {
      if (session.sessionName !== event.sessionName) {
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
    onStateChange: (sessionName) => {
      broadcastScheduleState(sessionName);
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

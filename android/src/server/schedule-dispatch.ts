import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';

export interface ScheduleDispatchResult {
  ok: boolean;
  message?: string;
  disable?: boolean;
}

export interface ScheduleDispatchContext {
  writeToLiveMirror: (sessionName: string, payload: string) => boolean;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
}

function appendEnter(payload: string, enabled: boolean) {
  return enabled ? `${payload}\r` : payload;
}

export function dispatchScheduledJob(
  context: ScheduleDispatchContext,
  job: ScheduleJob,
): ScheduleDispatchResult {
  const sessionName = job.targetSessionName.trim();
  if (!sessionName) {
    return {
      ok: false,
      message: 'missing target session',
      disable: true,
    };
  }

  const payload = appendEnter(job.payload.text, job.payload.appendEnter);
  if (context.writeToLiveMirror(sessionName, payload)) {
    return { ok: true };
  }

  try {
    context.writeToTmuxSession(sessionName, job.payload.text, job.payload.appendEnter);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const disable = /no server running|can't find session|can't find pane|no such file|target.*not found/i.test(message);
    return {
      ok: false,
      message,
      disable,
    };
  }
}

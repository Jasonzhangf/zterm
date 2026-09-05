import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';

export interface ScheduleDispatchResult {
  ok: boolean;
  message?: string;
  disable?: boolean;
}

export interface ScheduleDispatchContext {
  enqueueBackendInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    backend?: 'tmux' | 'herdr' | 'wezterm',
  ) => Promise<boolean>;
  isHerdrSession?: (sessionName: string, backend?: 'tmux' | 'herdr') => boolean;
}

export async function dispatchScheduledJob(
  context: ScheduleDispatchContext,
  job: ScheduleJob,
): Promise<ScheduleDispatchResult> {
  const sessionName = job.targetSessionName.trim();
  const backend = job.terminalBackend || 'tmux';
  if (!sessionName) {
    return {
      ok: false,
      message: 'missing target session',
      disable: true,
    };
  }

  if (backend === 'herdr' && context.isHerdrSession?.(sessionName, backend)) {
    return {
      ok: false,
      message: 'Herdr single-session backend does not support schedule commands',
      disable: true,
    };
  }

  try {
    const wrote = await context.enqueueBackendInput(
      sessionName,
      job.payload.text,
      job.payload.appendEnter,
      backend,
    );
    return wrote
      ? { ok: true }
      : { ok: false, message: 'backend input was not accepted', disable: false };
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

import { v4 as uuidv4 } from 'uuid';
import {
  computeNextFireAtForJob,
  normalizeScheduleDraft,
  normalizeScheduleExecutionPolicy,
} from '../../../packages/shared/src/schedule/next-fire.ts';
import type {
  ScheduleEventPayload,
  ScheduleJob,
  ScheduleJobDraft,
} from '../../../packages/shared/src/schedule/types.ts';

export interface ScheduleExecutionResult {
  ok: boolean;
  message?: string;
  disable?: boolean;
}

export interface ScheduleEngineOptions {
  initialJobs?: ScheduleJob[];
  saveJobs: (jobs: ScheduleJob[]) => void;
  executeJob: (job: ScheduleJob) => Promise<ScheduleExecutionResult> | ScheduleExecutionResult;
  onStateChange?: (sessionName: string, jobs: ScheduleJob[], backend?: 'tmux' | 'herdr') => void;
  onEvent?: (event: ScheduleEventPayload) => void;
  now?: () => Date;
}

export class ScheduleEngine {
  private jobs = new Map<string, ScheduleJob>();

  private timer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private disposed = false;

  private readonly saveJobs: ScheduleEngineOptions['saveJobs'];

  private readonly executeJob: ScheduleEngineOptions['executeJob'];

  private readonly onStateChange?: ScheduleEngineOptions['onStateChange'];

  private readonly onEvent?: ScheduleEngineOptions['onEvent'];

  private readonly now: () => Date;

  constructor(options: ScheduleEngineOptions) {
    this.saveJobs = options.saveJobs;
    this.executeJob = options.executeJob;
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
    this.now = options.now || (() => new Date());

    const now = this.now();
    for (const job of options.initialJobs || []) {
      const normalized = {
        ...job,
        execution: normalizeScheduleExecutionPolicy(job.execution),
        nextFireAt: computeNextFireAtForJob(job, now),
      };
      this.jobs.set(normalized.id, normalized);
    }
    this.persistAndReschedule();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  listBySession(sessionName: string, backend: 'tmux' | 'herdr' = 'tmux') {
    return Array.from(this.jobs.values())
      .filter((job) => job.targetSessionName === sessionName && (job.terminalBackend || 'tmux') === backend)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  upsert(draft: ScheduleJobDraft) {
    const now = this.now();
    const existing = draft.id ? this.jobs.get(draft.id) || null : null;
    const normalized = normalizeScheduleDraft(draft, { now, existing });
    const nextJob: ScheduleJob = {
      ...normalized,
      terminalBackend: draft.terminalBackend || existing?.terminalBackend || 'tmux',
      id: normalized.id || existing?.id || uuidv4(),
    };
    this.jobs.set(nextJob.id, nextJob);
    this.persistAndReschedule();
    this.emitState(nextJob.targetSessionName, nextJob.terminalBackend || 'tmux');
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId: nextJob.id,
      type: 'updated',
      at: now.toISOString(),
      message: 'schedule updated',
    });
    return nextJob;
  }

  delete(jobId: string) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    this.jobs.delete(jobId);
    this.persistAndReschedule();
    this.emitState(existing.targetSessionName, existing.terminalBackend || 'tmux');
    this.emitEvent({
      sessionName: existing.targetSessionName,
      jobId,
      type: 'deleted',
      at: this.now().toISOString(),
      message: 'schedule deleted',
    });
    return existing;
  }

  toggle(jobId: string, enabled: boolean) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    const now = this.now();
    const nextJob: ScheduleJob = {
      ...existing,
      enabled,
      updatedAt: now.toISOString(),
      nextFireAt: enabled ? computeNextFireAtForJob({ ...existing, enabled }, now) : undefined,
    };
    this.jobs.set(jobId, nextJob);
    this.persistAndReschedule();
    this.emitState(nextJob.targetSessionName, nextJob.terminalBackend || 'tmux');
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId,
      type: 'updated',
      at: now.toISOString(),
      message: enabled ? 'schedule enabled' : 'schedule disabled',
    });
    return nextJob;
  }

  async runNow(jobId: string) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    const executed = await this.execute(existing, this.now());
    this.persistAndReschedule();
    return executed;
  }

  renameSession(previousSessionName: string, nextSessionName: string, backend: 'tmux' | 'herdr' = 'tmux') {
    if (!previousSessionName || previousSessionName === nextSessionName) {
      return;
    }
    const now = this.now().toISOString();
    let touched = false;
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.targetSessionName !== previousSessionName || (job.terminalBackend || 'tmux') !== backend) {
        continue;
      }
      touched = true;
      this.jobs.set(jobId, {
        ...job,
        targetSessionName: nextSessionName,
        label: job.label === previousSessionName ? nextSessionName : job.label,
        updatedAt: now,
      });
    }
    if (!touched) {
      return;
    }
    this.persistAndReschedule();
    this.emitState(previousSessionName, backend);
    this.emitState(nextSessionName, backend);
  }

  markSessionMissing(sessionName: string, message = 'session not found', backend: 'tmux' | 'herdr' = 'tmux') {
    const now = this.now().toISOString();
    let touched = false;
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.targetSessionName !== sessionName || (job.terminalBackend || 'tmux') !== backend) {
        continue;
      }
      touched = true;
      this.jobs.set(jobId, {
        ...job,
        enabled: false,
        nextFireAt: undefined,
        lastResult: 'error',
        lastError: message,
        updatedAt: now,
      });
      this.emitEvent({
        sessionName,
        terminalBackend: backend,
        jobId,
        type: 'error',
        at: now,
        message,
      });
    }
    if (!touched) {
      return;
    }
    this.persistAndReschedule();
    this.emitState(sessionName, backend);
  }

  private emitState(sessionName: string, backend: 'tmux' | 'herdr' = 'tmux') {
    this.onStateChange?.(sessionName, this.listBySession(sessionName, backend), backend);
  }

  private emitEvent(event: ScheduleEventPayload) {
    this.onEvent?.(event);
  }

  private getNextDueJob() {
    return Array.from(this.jobs.values())
      .filter((job) => job.enabled && job.nextFireAt)
      .sort((left, right) => {
        const leftMs = Date.parse(left.nextFireAt || '');
        const rightMs = Date.parse(right.nextFireAt || '');
        return leftMs - rightMs;
      })
      .find((job) => Number.isFinite(Date.parse(job.nextFireAt || ''))) || null;
  }

  private persistAndReschedule() {
    const snapshot = Array.from(this.jobs.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.saveJobs(snapshot);
    this.scheduleNextTimer();
  }

  private scheduleNextTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) {
      return;
    }
    const nextJob = this.getNextDueJob();
    if (!nextJob?.nextFireAt) {
      return;
    }
    const delay = Math.max(0, Date.parse(nextJob.nextFireAt) - this.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueJobs();
    }, delay);
    this.timer.unref?.();
  }

  private async runDueJobs() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      const dueJobs = Array.from(this.jobs.values())
        .filter((job) => job.enabled && job.nextFireAt && Date.parse(job.nextFireAt) <= now.getTime())
        .sort((left, right) => Date.parse(left.nextFireAt || '') - Date.parse(right.nextFireAt || ''));

      for (const job of dueJobs) {
        await this.execute(job, this.now());
      }
    } finally {
      this.running = false;
      this.persistAndReschedule();
    }
  }

  private async execute(job: ScheduleJob, now: Date): Promise<ScheduleJob | null> {
    const currentBeforeExecute = this.jobs.get(job.id);
    if (!currentBeforeExecute) {
      return null;
    }
    const currentMaxRuns = Math.max(0, Math.floor(currentBeforeExecute.execution.maxRuns || 0));
    const currentFiredCount = Math.max(0, Math.floor(currentBeforeExecute.execution.firedCount || 0));
    if (currentMaxRuns > 0 && currentFiredCount >= currentMaxRuns) {
      const stoppedJob: ScheduleJob = {
        ...currentBeforeExecute,
        enabled: false,
        updatedAt: now.toISOString(),
        nextFireAt: undefined,
      };
      this.jobs.delete(job.id);
      this.emitState(currentBeforeExecute.targetSessionName, currentBeforeExecute.terminalBackend || 'tmux');
      this.emitEvent({
        sessionName: stoppedJob.targetSessionName,
        jobId: stoppedJob.id,
        type: 'updated',
        at: now.toISOString(),
        message: 'schedule removed after reaching max runs',
      });
      return stoppedJob;
    }
    if (currentBeforeExecute.execution.endAt) {
      const endAtMs = Date.parse(currentBeforeExecute.execution.endAt);
      if (!Number.isFinite(endAtMs) || endAtMs <= now.getTime()) {
        const stoppedJob: ScheduleJob = {
          ...currentBeforeExecute,
          enabled: false,
          updatedAt: now.toISOString(),
          nextFireAt: undefined,
        };
        this.jobs.delete(job.id);
        this.emitState(currentBeforeExecute.targetSessionName, currentBeforeExecute.terminalBackend || 'tmux');
        this.emitEvent({
          sessionName: stoppedJob.targetSessionName,
          jobId: stoppedJob.id,
          type: 'updated',
          at: now.toISOString(),
          message: 'schedule removed after end time',
        });
        return stoppedJob;
      }
    }

    const result = await (async (): Promise<ScheduleExecutionResult> => {
      try {
        return await this.executeJob(job);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    const current = this.jobs.get(job.id);
    if (!current) {
      return null;
    }

    const lastResult = result.ok ? 'ok' : 'error';
    const nextFiredCount = Math.max(0, Math.floor(current.execution.firedCount || 0)) + 1;
    const nextMaxRuns = Math.max(0, Math.floor(current.execution.maxRuns || 0));
    const reachedRunLimit = nextMaxRuns > 0 && nextFiredCount >= nextMaxRuns;
    const nextBase: ScheduleJob = {
      ...current,
      updatedAt: now.toISOString(),
      lastFiredAt: now.toISOString(),
      lastResult,
      lastError: result.ok ? undefined : result.message,
      enabled: result.disable || reachedRunLimit ? false : current.enabled,
      execution: {
        ...current.execution,
        firedCount: nextFiredCount,
      },
    };
    const nextJob: ScheduleJob = {
      ...nextBase,
      nextFireAt: nextBase.enabled ? computeNextFireAtForJob(nextBase, now) : undefined,
    };
    if (reachedRunLimit) {
      this.jobs.delete(job.id);
    } else {
      this.jobs.set(job.id, nextJob);
    }
    this.emitState(nextJob.targetSessionName, nextJob.terminalBackend || 'tmux');
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId: nextJob.id,
      type: result.ok ? 'triggered' : 'error',
      at: now.toISOString(),
      message:
        reachedRunLimit
          ? 'schedule reached max runs'
          : result.message,
    });
    return nextJob;
  }
}

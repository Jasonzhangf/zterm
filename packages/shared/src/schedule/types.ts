export type ScheduleRepeat = 'once' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export interface ScheduleIntervalRule {
  kind: 'interval';
  intervalMs: number;
  startAt: string;
  fireImmediately?: boolean;
}

export interface ScheduleAlarmRule {
  kind: 'alarm';
  timezone: string;
  date: string;
  time: string;
  repeat: ScheduleRepeat;
  weekdays?: number[];
}

export type ScheduleRule = ScheduleIntervalRule | ScheduleAlarmRule;

export interface SchedulePayload {
  text: string;
  appendEnter: boolean;
}

export interface ScheduleExecutionPolicy {
  maxRuns: number; // 0 = unlimited
  firedCount: number;
  endAt?: string;
}

export interface ScheduleJob {
  id: string;
  targetSessionName: string;
  terminalBackend?: 'tmux' | 'herdr';
  label: string;
  enabled: boolean;
  payload: SchedulePayload;
  rule: ScheduleRule;
  execution: ScheduleExecutionPolicy;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastResult?: 'ok' | 'error';
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleJobDraft {
  id?: string;
  targetSessionName: string;
  terminalBackend?: 'tmux' | 'herdr';
  label?: string;
  enabled?: boolean;
  payload: SchedulePayload;
  rule: ScheduleRule;
  execution?: Partial<Pick<ScheduleExecutionPolicy, 'maxRuns' | 'endAt'>>;
}

export interface ScheduleStatePayload {
  sessionName: string;
  terminalBackend?: 'tmux' | 'herdr';
  jobs: ScheduleJob[];
}

export interface ScheduleEventPayload {
  sessionName: string;
  terminalBackend?: 'tmux' | 'herdr';
  jobId: string;
  type: 'triggered' | 'updated' | 'deleted' | 'error';
  at: string;
  message?: string;
}

export interface ScheduleErrorPayload {
  sessionName: string;
  operation: 'list' | 'upsert' | 'delete' | 'toggle' | 'run-now';
  jobId?: string;
  code: string;
  message: string;
}

export interface SessionScheduleState {
  sessionName: string;
  jobs: ScheduleJob[];
  loading: boolean;
  lastEvent?: ScheduleEventPayload;
  error?: string;
}

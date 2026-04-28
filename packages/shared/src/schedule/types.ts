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
  label?: string;
  enabled?: boolean;
  payload: SchedulePayload;
  rule: ScheduleRule;
  execution?: Partial<Pick<ScheduleExecutionPolicy, 'maxRuns' | 'endAt'>>;
}

export interface ScheduleStatePayload {
  sessionName: string;
  jobs: ScheduleJob[];
}

export interface ScheduleEventPayload {
  sessionName: string;
  jobId: string;
  type: 'triggered' | 'updated' | 'deleted' | 'error';
  at: string;
  message?: string;
}

export interface SessionScheduleState {
  sessionName: string;
  jobs: ScheduleJob[];
  loading: boolean;
  lastEvent?: ScheduleEventPayload;
  error?: string;
}

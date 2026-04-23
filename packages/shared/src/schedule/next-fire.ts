import type {
  ScheduleAlarmRule,
  ScheduleEventPayload,
  ScheduleJob,
  ScheduleJobDraft,
  ScheduleRule,
} from './types';

const DEFAULT_TIMEZONE = 'UTC';
const WEEKDAY_SET = new Set([1, 2, 3, 4, 5]);
const MIN_INTERVAL_MS = 1000;

function parseIsoDateParts(input: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.trim());
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

function parseTimeParts(input: string) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(input.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function getFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedParts(date: Date, timeZone: string) {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_TO_INDEX[lookup.weekday] ?? 0;
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
    hour: Number.parseInt(lookup.hour, 10),
    minute: Number.parseInt(lookup.minute, 10),
    second: Number.parseInt(lookup.second, 10),
    weekday,
  };
}

function compareWallDateTime(
  left: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  right: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
) {
  const leftStamp = Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute, left.second || 0);
  const rightStamp = Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute, right.second || 0);
  return leftStamp - rightStamp;
}

function addUtcDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function wallTimeToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
) {
  let guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0);
    const delta = desired - actual;
    guess += delta;
    if (delta === 0) {
      break;
    }
  }

  const finalParts = getZonedParts(new Date(guess), timeZone);
  if (
    finalParts.year !== wall.year
    || finalParts.month !== wall.month
    || finalParts.day !== wall.day
    || finalParts.hour !== wall.hour
    || finalParts.minute !== wall.minute
  ) {
    return null;
  }

  return new Date(guess);
}

function normalizeWeekdays(rule: ScheduleAlarmRule) {
  if (rule.repeat === 'weekdays') {
    return Array.from(WEEKDAY_SET);
  }
  if (rule.repeat === 'custom') {
    return Array.from(new Set((rule.weekdays || []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort((a, b) => a - b);
  }
  if (rule.repeat === 'weekly') {
    const dateParts = parseIsoDateParts(rule.date);
    if (!dateParts) {
      return [];
    }
    const weekday = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
    return [weekday];
  }
  return [];
}

function resolveNextAlarmFireAt(rule: ScheduleAlarmRule, now: Date) {
  const timezone = rule.timezone || DEFAULT_TIMEZONE;
  const dateParts = parseIsoDateParts(rule.date);
  const timeParts = parseTimeParts(rule.time);
  if (!dateParts || !timeParts) {
    return undefined;
  }

  if (rule.repeat === 'once') {
    const candidate = wallTimeToUtc({ ...dateParts, ...timeParts, second: 0 }, timezone);
    return candidate && candidate.getTime() > now.getTime() ? candidate.toISOString() : undefined;
  }

  const zonedNow = getZonedParts(now, timezone);
  const allowedWeekdays = normalizeWeekdays(rule);
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const candidateDate = addUtcDays(
      { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day },
      dayOffset,
    );
    const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();

    if (rule.repeat === 'daily') {
      // no weekday filter
    } else if (rule.repeat === 'weekdays' || rule.repeat === 'custom' || rule.repeat === 'weekly') {
      if (!allowedWeekdays.includes(weekday)) {
        continue;
      }
    }

    const candidateWall = { ...candidateDate, ...timeParts, second: 0 };
    if (dayOffset === 0 && compareWallDateTime(candidateWall, zonedNow) <= 0) {
      continue;
    }

    const candidate = wallTimeToUtc(candidateWall, timezone);
    if (candidate && candidate.getTime() > now.getTime()) {
      return candidate.toISOString();
    }
  }

  return undefined;
}

function resolveNextIntervalFireAt(job: ScheduleJob, now: Date) {
  if (job.rule.kind !== 'interval') {
    return undefined;
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(job.rule.intervalMs || 0));
  const startAtMs = Date.parse(job.rule.startAt);
  if (!Number.isFinite(startAtMs)) {
    return undefined;
  }

  if (job.lastFiredAt) {
    const lastFiredAtMs = Date.parse(job.lastFiredAt);
    if (!Number.isFinite(lastFiredAtMs)) {
      return undefined;
    }
    let nextMs = lastFiredAtMs + intervalMs;
    while (nextMs <= now.getTime()) {
      nextMs += intervalMs;
    }
    return new Date(nextMs).toISOString();
  }

  if (job.rule.fireImmediately) {
    if (startAtMs > now.getTime()) {
      return new Date(startAtMs).toISOString();
    }
    return now.toISOString();
  }

  let nextMs = startAtMs + intervalMs;
  while (nextMs <= now.getTime()) {
    nextMs += intervalMs;
  }
  return new Date(nextMs).toISOString();
}

export function computeNextFireAtForRule(
  rule: ScheduleRule,
  now: Date,
  lastFiredAt?: string,
) {
  const pseudoJob: ScheduleJob = {
    id: 'preview',
    targetSessionName: 'preview',
    label: 'preview',
    enabled: true,
    payload: { text: '', appendEnter: true },
    rule,
    lastFiredAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return computeNextFireAtForJob(pseudoJob, now);
}

export function computeNextFireAtForJob(job: ScheduleJob, now = new Date()) {
  if (!job.enabled) {
    return undefined;
  }
  if (job.rule.kind === 'interval') {
    return resolveNextIntervalFireAt(job, now);
  }
  return resolveNextAlarmFireAt(job.rule, now);
}

export function resolveScheduleTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function normalizeScheduleDraft(
  draft: ScheduleJobDraft,
  options?: { now?: Date; existing?: ScheduleJob | null },
) {
  const now = options?.now || new Date();
  const existing = options?.existing || null;
  const targetSessionName = draft.targetSessionName.trim();
  const enabled = draft.enabled ?? existing?.enabled ?? true;
  const label = (draft.label || '').trim() || targetSessionName || 'Scheduled message';
  const payload = {
    text: draft.payload.text,
    appendEnter: Boolean(draft.payload.appendEnter),
  };
  const baseJob: ScheduleJob = {
    id: draft.id || existing?.id || '',
    targetSessionName,
    label,
    enabled,
    payload,
    rule: draft.rule,
    nextFireAt: existing?.nextFireAt,
    lastFiredAt: existing?.lastFiredAt,
    lastResult: existing?.lastResult,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    ...baseJob,
    nextFireAt: computeNextFireAtForJob(baseJob, now),
  };
}

function pluralize(label: string, count: number) {
  return count === 1 ? label : `${label}s`;
}

export function formatIntervalMs(intervalMs: number) {
  const safeMs = Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs || 0));
  if (safeMs % (60 * 60 * 1000) === 0) {
    const hours = safeMs / (60 * 60 * 1000);
    return `每 ${hours} ${pluralize('hour', hours)}`;
  }
  if (safeMs % (60 * 1000) === 0) {
    const minutes = safeMs / (60 * 1000);
    return `每 ${minutes} ${pluralize('minute', minutes)}`;
  }
  const seconds = safeMs / 1000;
  return `每 ${seconds} ${pluralize('second', seconds)}`;
}

export function describeScheduleRule(job: Pick<ScheduleJob, 'rule'>) {
  if (job.rule.kind === 'interval') {
    return formatIntervalMs(job.rule.intervalMs);
  }
  const repeatLabel = ({
    once: '仅一次',
    daily: '每天',
    weekdays: '工作日',
    weekly: '每周',
    custom: '自定义周几',
  } satisfies Record<ScheduleAlarmRule['repeat'], string>)[job.rule.repeat];
  return `${repeatLabel} ${job.rule.time}`;
}

export function formatScheduleDateTime(input?: string, options?: { locale?: string; timeZone?: string }) {
  if (!input) {
    return '-';
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return new Intl.DateTimeFormat(options?.locale || 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: options?.timeZone,
  }).format(date);
}

export function buildEmptyScheduleState(sessionName: string) {
  return {
    sessionName,
    jobs: [],
    loading: false,
  };
}

export function mergeScheduleEventState(
  jobs: ScheduleJob[],
  event?: ScheduleEventPayload,
) {
  return {
    jobs,
    lastEvent: event,
  };
}


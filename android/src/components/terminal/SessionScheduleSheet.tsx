import { useEffect, useMemo, useState } from 'react';
import {
  describeScheduleRule,
  formatScheduleDateTime,
  resolveScheduleTimeZone,
} from '../../../../packages/shared/src/schedule/next-fire';
import type {
  ScheduleJob,
  ScheduleJobDraft,
  SessionScheduleState,
} from '../../../../packages/shared/src/schedule/types';
import { mobileTheme } from '../../lib/mobile-ui';

interface SessionScheduleSheetProps {
  open: boolean;
  sessionName: string;
  scheduleState: SessionScheduleState;
  composerSeedText?: string;
  composerSeedNonce?: number;
  onClose: () => void;
  onRefresh: () => void;
  onSave: (job: ScheduleJobDraft) => void;
  onDelete: (jobId: string) => void;
  onToggle: (jobId: string, enabled: boolean) => void;
  onRunNow: (jobId: string) => void;
}

type IntervalUnit = 'seconds' | 'minutes' | 'hours';

function toDateInputValue(date = new Date()) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function toTimeInputValue(date = new Date()) {
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`;
}

function toDateTimeLocalValue(input?: string) {
  const date = input ? new Date(input) : new Date();
  return `${toDateInputValue(date)}T${toTimeInputValue(date)}`;
}

function resolveIntervalUnit(intervalMs: number): { value: number; unit: IntervalUnit } {
  if (intervalMs % (60 * 60 * 1000) === 0) {
    return { value: Math.max(1, intervalMs / (60 * 60 * 1000)), unit: 'hours' };
  }
  if (intervalMs % (60 * 1000) === 0) {
    return { value: Math.max(1, intervalMs / (60 * 1000)), unit: 'minutes' };
  }
  return { value: Math.max(1, intervalMs / 1000), unit: 'seconds' };
}

function intervalToMs(value: number, unit: IntervalUnit) {
  const safeValue = Math.max(1, Math.floor(value || 1));
  if (unit === 'hours') {
    return safeValue * 60 * 60 * 1000;
  }
  if (unit === 'minutes') {
    return safeValue * 60 * 1000;
  }
  return safeValue * 1000;
}

function createDefaultDraft(sessionName: string, seededText = ''): ScheduleJobDraft {
  const now = new Date();
  return {
    targetSessionName: sessionName,
    enabled: true,
    label: '',
    payload: {
      text: seededText,
      appendEnter: true,
    },
    rule: {
      kind: 'interval',
      intervalMs: 30 * 60 * 1000,
      startAt: now.toISOString(),
      fireImmediately: false,
    },
  };
}

function createDraftFromJob(job: ScheduleJob): ScheduleJobDraft {
  return {
    id: job.id,
    targetSessionName: job.targetSessionName,
    enabled: job.enabled,
    label: job.label,
    payload: {
      ...job.payload,
    },
    rule: {
      ...job.rule,
      ...(job.rule.kind === 'alarm'
        ? { weekdays: Array.isArray(job.rule.weekdays) ? [...job.rule.weekdays] : undefined }
        : {}),
    },
  };
}

export function SessionScheduleSheet({
  open,
  sessionName,
  scheduleState,
  composerSeedText = '',
  composerSeedNonce = 0,
  onClose,
  onRefresh,
  onSave,
  onDelete,
  onToggle,
  onRunNow,
}: SessionScheduleSheetProps) {
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleJobDraft>(() => createDefaultDraft(sessionName, composerSeedText));
  const [intervalValue, setIntervalValue] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('minutes');

  useEffect(() => {
    if (!open) {
      return;
    }
    setEditingJobId(null);
    setDraft(createDefaultDraft(sessionName, composerSeedText));
    setIntervalValue(30);
    setIntervalUnit('minutes');
  }, [open, sessionName, composerSeedNonce, composerSeedText]);

  const editingJob = useMemo(
    () => scheduleState.jobs.find((job) => job.id === editingJobId) || null,
    [editingJobId, scheduleState.jobs],
  );

  const startEditing = (job?: ScheduleJob) => {
    const nextDraft = job ? createDraftFromJob(job) : createDefaultDraft(sessionName, composerSeedText);
    setDraft(nextDraft);
    setEditingJobId(job?.id || null);
    if (nextDraft.rule.kind === 'interval') {
      const normalized = resolveIntervalUnit(nextDraft.rule.intervalMs);
      setIntervalValue(normalized.value);
      setIntervalUnit(normalized.unit);
    }
  };

  const submitDraft = () => {
    if (!draft.payload.text.trim()) {
      window.alert('先填写要发送的文本。');
      return;
    }

    const nextDraft: ScheduleJobDraft = {
      ...draft,
      targetSessionName: sessionName,
      label: draft.label?.trim() || sessionName,
      payload: {
        text: draft.payload.text,
        appendEnter: draft.payload.appendEnter,
      },
      rule: draft.rule.kind === 'interval'
        ? {
            ...draft.rule,
            intervalMs: intervalToMs(intervalValue, intervalUnit),
            startAt: draft.rule.startAt || new Date().toISOString(),
          }
        : draft.rule,
    };
    onSave(nextDraft);
    setEditingJobId(null);
    setDraft(createDefaultDraft(sessionName, composerSeedText));
  };

  if (!open) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(5, 8, 14, 0.72)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'stretch',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxHeight: '88vh',
          overflow: 'auto',
          borderTopLeftRadius: '20px',
          borderTopRightRadius: '20px',
          border: `1px solid ${mobileTheme.colors.cardBorder}`,
          background: mobileTheme.colors.shell,
          padding: '12px 14px 24px',
          boxShadow: '0 -16px 40px rgba(0,0,0,0.32)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '17px', fontWeight: 800, color: mobileTheme.colors.textPrimary }}>
              Session Schedule
            </div>
            <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.textSecondary }}>
              {sessionName}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" onClick={onRefresh} style={ghostButtonStyle}>Refresh</button>
            <button type="button" onClick={onClose} style={ghostButtonStyle}>Done</button>
          </div>
        </div>

        <div style={{ marginTop: '14px', display: 'grid', gap: '10px' }}>
          {scheduleState.jobs.length === 0 ? (
            <div style={emptyStateStyle}>
              还没有定时任务。先新建一个 interval 或 alarm。
            </div>
          ) : (
            scheduleState.jobs.map((job) => (
              <div key={job.id} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.textPrimary }}>
                      {job.label || job.targetSessionName}
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.textSecondary }}>
                      {describeScheduleRule(job)}
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: mobileTheme.colors.textMuted }}>
                      下次：{formatScheduleDateTime(job.nextFireAt)}
                      {' · '}
                      上次：{formatScheduleDateTime(job.lastFiredAt)}
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: job.lastResult === 'error' ? '#ff8f8f' : mobileTheme.colors.textMuted }}>
                      {job.lastResult === 'error'
                        ? `最近错误：${job.lastError || 'unknown error'}`
                        : `发送后回车：${job.payload.appendEnter ? '是' : '否'}`}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: mobileTheme.colors.textSecondary }}>
                    <input
                      type="checkbox"
                      checked={job.enabled}
                      onChange={(event) => onToggle(job.id, event.target.checked)}
                    />
                    Enabled
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => startEditing(job)} style={ghostButtonStyle}>Edit</button>
                  <button type="button" onClick={() => onRunNow(job.id)} style={ghostButtonStyle}>Run now</button>
                  <button type="button" onClick={() => onDelete(job.id)} style={dangerButtonStyle}>Delete</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ marginTop: '18px', ...cardStyle }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.textPrimary }}>
            {editingJob ? '编辑任务' : '新建任务'}
          </div>

          <label style={fieldStyle}>
            <span>Label</span>
            <input
              value={draft.label || ''}
              onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              placeholder="比如：heartbeat / 每天签到"
              style={inputStyle}
            />
          </label>

          <label style={fieldStyle}>
            <span>发送内容</span>
            <textarea
              value={draft.payload.text}
              onChange={(event) => setDraft((current) => ({
                ...current,
                payload: {
                  ...current.payload,
                  text: event.target.value,
                },
              }))}
              rows={4}
              placeholder="输入要定时发送到 tmux session 的文本"
              style={{ ...inputStyle, resize: 'vertical', minHeight: '92px' }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', color: mobileTheme.colors.textPrimary, fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={draft.payload.appendEnter}
              onChange={(event) => setDraft((current) => ({
                ...current,
                payload: {
                  ...current.payload,
                  appendEnter: event.target.checked,
                },
              }))}
            />
            发送后自动回车
          </label>

          <label style={fieldStyle}>
            <span>规则类型</span>
            <select
              value={draft.rule.kind}
              onChange={(event) => {
                const nextKind = event.target.value;
                setDraft((current) => ({
                  ...current,
                  rule: nextKind === 'alarm'
                    ? {
                        kind: 'alarm',
                        timezone: resolveScheduleTimeZone(),
                        date: toDateInputValue(new Date()),
                        time: toTimeInputValue(new Date(Date.now() + 60 * 1000)),
                        repeat: 'once',
                      }
                    : {
                        kind: 'interval',
                        intervalMs: intervalToMs(intervalValue, intervalUnit),
                        startAt: new Date().toISOString(),
                        fireImmediately: false,
                      },
                }));
              }}
              style={inputStyle}
            >
              <option value="interval">周期</option>
              <option value="alarm">闹钟</option>
            </select>
          </label>

          {draft.rule.kind === 'interval' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
              <label style={fieldStyle}>
                <span>每隔</span>
                <input
                  type="number"
                  min={1}
                  value={intervalValue}
                  onChange={(event) => setIntervalValue(Math.max(1, Number.parseInt(event.target.value || '1', 10) || 1))}
                  style={inputStyle}
                />
              </label>
              <label style={fieldStyle}>
                <span>单位</span>
                <select
                  value={intervalUnit}
                  onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                  style={inputStyle}
                >
                  <option value="seconds">秒</option>
                  <option value="minutes">分钟</option>
                  <option value="hours">小时</option>
                </select>
              </label>
              <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                <span>起始时间</span>
                <input
                  type="datetime-local"
                  value={toDateTimeLocalValue(draft.rule.startAt)}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'interval'
                      ? (() => {
                          const nextDate = new Date(event.target.value);
                          return Number.isNaN(nextDate.getTime())
                            ? current.rule
                            : {
                                ...current.rule,
                                startAt: nextDate.toISOString(),
                              };
                        })()
                      : current.rule,
                  }))}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', gridColumn: '1 / -1', color: mobileTheme.colors.textPrimary, fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={Boolean(draft.rule.fireImmediately)}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'interval'
                      ? {
                          ...current.rule,
                          fireImmediately: event.target.checked,
                        }
                      : current.rule,
                  }))}
                />
                创建后立即触发一次
              </label>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
              <label style={fieldStyle}>
                <span>日期</span>
                <input
                  type="date"
                  value={draft.rule.date}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm'
                      ? { ...current.rule, date: event.target.value }
                      : current.rule,
                  }))}
                  style={inputStyle}
                />
              </label>
              <label style={fieldStyle}>
                <span>时间</span>
                <input
                  type="time"
                  value={draft.rule.time}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm'
                      ? { ...current.rule, time: event.target.value }
                      : current.rule,
                  }))}
                  style={inputStyle}
                />
              </label>
              <label style={fieldStyle}>
                <span>重复</span>
                <select
                  value={draft.rule.repeat}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm'
                      ? {
                          ...current.rule,
                          repeat: event.target.value as typeof current.rule.repeat,
                        }
                      : current.rule,
                  }))}
                  style={inputStyle}
                >
                  <option value="once">仅一次</option>
                  <option value="daily">每天</option>
                  <option value="weekdays">工作日</option>
                  <option value="weekly">每周</option>
                  <option value="custom">自定义周几</option>
                </select>
              </label>
              <label style={fieldStyle}>
                <span>时区</span>
                <input
                  value={draft.rule.timezone}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm'
                      ? { ...current.rule, timezone: event.target.value }
                      : current.rule,
                  }))}
                  style={inputStyle}
                />
              </label>
              {draft.rule.repeat === 'custom' ? (
                <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {['日', '一', '二', '三', '四', '五', '六'].map((label, index) => {
                    const selected = draft.rule.kind === 'alarm' && Array.isArray(draft.rule.weekdays)
                      ? draft.rule.weekdays.includes(index)
                      : false;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setDraft((current) => {
                          if (current.rule.kind !== 'alarm') {
                            return current;
                          }
                          const currentWeekdays = Array.isArray(current.rule.weekdays) ? current.rule.weekdays : [];
                          const nextWeekdays = currentWeekdays.includes(index)
                            ? currentWeekdays.filter((day) => day !== index)
                            : [...currentWeekdays, index].sort((left, right) => left - right);
                          return {
                            ...current,
                            rule: {
                              ...current.rule,
                              weekdays: nextWeekdays,
                            },
                          };
                        })}
                        style={{
                          ...ghostButtonStyle,
                          background: selected ? 'rgba(110, 168, 255, 0.2)' : ghostButtonStyle.background,
                          borderColor: selected ? 'rgba(110, 168, 255, 0.4)' : ghostButtonStyle.border as string,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => startEditing()} style={ghostButtonStyle}>
              Reset
            </button>
            <button type="button" onClick={submitDraft} style={primaryButtonStyle}>
              {editingJob ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '6px',
  marginTop: '12px',
  color: mobileTheme.colors.textSecondary,
  fontSize: '12px',
};

const inputStyle = {
  width: '100%',
  borderRadius: '12px',
  border: `1px solid ${mobileTheme.colors.cardBorder}`,
  background: mobileTheme.colors.card,
  color: mobileTheme.colors.textPrimary,
  padding: '10px 12px',
};

const cardStyle = {
  borderRadius: '16px',
  border: `1px solid ${mobileTheme.colors.cardBorder}`,
  background: mobileTheme.colors.card,
  padding: '12px',
};

const emptyStateStyle = {
  ...cardStyle,
  color: mobileTheme.colors.textSecondary,
  fontSize: '13px',
};

const ghostButtonStyle = {
  minHeight: '34px',
  borderRadius: '12px',
  border: `1px solid ${mobileTheme.colors.cardBorder}`,
  background: mobileTheme.colors.shellMuted,
  color: mobileTheme.colors.textPrimary,
  padding: '0 12px',
};

const primaryButtonStyle = {
  ...ghostButtonStyle,
  background: 'linear-gradient(180deg, rgba(96, 149, 255, 0.92), rgba(72, 122, 230, 0.92))',
  border: '1px solid rgba(113, 164, 255, 0.42)',
};

const dangerButtonStyle = {
  ...ghostButtonStyle,
  color: '#ffd0d0',
  background: 'rgba(103, 29, 37, 0.92)',
  border: '1px solid rgba(255, 120, 120, 0.32)',
};

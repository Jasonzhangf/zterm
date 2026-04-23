import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  describeScheduleRule,
  formatScheduleDateTime,
  resolveScheduleTimeZone,
} from '../../../packages/shared/src/schedule/next-fire';
import type {
  ScheduleJob,
  ScheduleJobDraft,
  SessionScheduleState,
} from '../../../packages/shared/src/schedule/types';

interface SessionScheduleModalProps {
  open: boolean;
  sessionName: string;
  scheduleState: SessionScheduleState;
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
  if (unit === 'hours') return safeValue * 60 * 60 * 1000;
  if (unit === 'minutes') return safeValue * 60 * 1000;
  return safeValue * 1000;
}

function createDefaultDraft(sessionName: string): ScheduleJobDraft {
  return {
    targetSessionName: sessionName,
    enabled: true,
    label: '',
    payload: {
      text: '',
      appendEnter: true,
    },
    rule: {
      kind: 'interval',
      intervalMs: 30 * 60 * 1000,
      startAt: new Date().toISOString(),
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
    payload: { ...job.payload },
    rule: {
      ...job.rule,
      ...(job.rule.kind === 'alarm'
        ? { weekdays: Array.isArray(job.rule.weekdays) ? [...job.rule.weekdays] : undefined }
        : {}),
    },
  };
}

export function SessionScheduleModal({
  open,
  sessionName,
  scheduleState,
  onClose,
  onRefresh,
  onSave,
  onDelete,
  onToggle,
  onRunNow,
}: SessionScheduleModalProps) {
  const [draft, setDraft] = useState<ScheduleJobDraft>(() => createDefaultDraft(sessionName));
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [intervalValue, setIntervalValue] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('minutes');

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(createDefaultDraft(sessionName));
    setEditingJobId(null);
    setIntervalValue(30);
    setIntervalUnit('minutes');
  }, [open, sessionName]);

  const editingJob = useMemo(
    () => scheduleState.jobs.find((job) => job.id === editingJobId) || null,
    [editingJobId, scheduleState.jobs],
  );

  const handleEdit = (job?: ScheduleJob) => {
    const nextDraft = job ? createDraftFromJob(job) : createDefaultDraft(sessionName);
    setDraft(nextDraft);
    setEditingJobId(job?.id || null);
    if (nextDraft.rule.kind === 'interval') {
      const normalized = resolveIntervalUnit(nextDraft.rule.intervalMs);
      setIntervalValue(normalized.value);
      setIntervalUnit(normalized.unit);
    }
  };

  const submit = () => {
    if (!draft.payload.text.trim()) {
      window.alert('先填写发送文本。');
      return;
    }
    onSave({
      ...draft,
      targetSessionName: sessionName,
      label: draft.label?.trim() || sessionName,
      rule: draft.rule.kind === 'interval'
        ? {
            ...draft.rule,
            intervalMs: intervalToMs(intervalValue, intervalUnit),
          }
        : draft.rule,
    });
    handleEdit();
  };

  if (!open) {
    return null;
  }

  return (
    <div className="shell-overlay-backdrop" onClick={onClose}>
      <div className="shell-overlay-card" style={{ width: 'min(960px, calc(100vw - 48px))' }} onClick={(event) => event.stopPropagation()}>
        <div className="shell-overlay-header">
          <div>
            <strong>Session Schedule</strong>
            <span>{sessionName}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button" type="button" onClick={onRefresh}>Refresh</button>
            <button className="ghost-button" type="button" onClick={onClose}>Done</button>
          </div>
        </div>

        <div style={{ padding: '18px', display: 'grid', gap: 12 }}>
          {scheduleState.jobs.length === 0 ? (
            <div className="shell-quick-empty">还没有定时任务。先创建一个 interval 或 alarm。</div>
          ) : (
            scheduleState.jobs.map((job) => (
              <div key={job.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>{job.label || job.targetSessionName}</div>
                    <div style={subtleStyle}>{describeScheduleRule(job)}</div>
                    <div style={subtleStyle}>
                      下次：{formatScheduleDateTime(job.nextFireAt)} · 上次：{formatScheduleDateTime(job.lastFiredAt)}
                    </div>
                    <div style={{ ...subtleStyle, color: job.lastResult === 'error' ? '#ff9a9a' : subtleStyle.color }}>
                      {job.lastResult === 'error'
                        ? `最近错误：${job.lastError || 'unknown'}`
                        : `发送后回车：${job.payload.appendEnter ? '是' : '否'}`}
                    </div>
                  </div>
                  <label style={{ ...subtleStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={job.enabled} onChange={(event) => onToggle(job.id, event.target.checked)} />
                    Enabled
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="ghost-button" type="button" onClick={() => handleEdit(job)}>Edit</button>
                  <button className="ghost-button" type="button" onClick={() => onRunNow(job.id)}>Run now</button>
                  <button className="danger-button" type="button" onClick={() => onDelete(job.id)}>Delete</button>
                </div>
              </div>
            ))
          )}

          <div style={cardStyle}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>{editingJob ? '编辑任务' : '新建任务'}</div>

            <label style={fieldStyle}>
              <span>Label</span>
              <input
                value={draft.label || ''}
                onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                placeholder="比如：heartbeat / 每天打卡"
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>发送内容</span>
              <textarea
                value={draft.payload.text}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  payload: { ...current.payload, text: event.target.value },
                }))}
                rows={5}
                style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }}
              />
            </label>

            <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={draft.payload.appendEnter}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  payload: { ...current.payload, appendEnter: event.target.checked },
                }))}
              />
              <span>发送后自动回车</span>
            </label>

            <label style={fieldStyle}>
              <span>规则类型</span>
              <select
                value={draft.rule.kind}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  rule: event.target.value === 'alarm'
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
                }))}
                style={inputStyle}
              >
                <option value="interval">周期</option>
                <option value="alarm">闹钟</option>
              </select>
            </label>

            {draft.rule.kind === 'interval' ? (
              <div style={gridStyle}>
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
                  <select value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)} style={inputStyle}>
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
                              : { ...current.rule, startAt: nextDate.toISOString() };
                          })()
                        : current.rule,
                    }))}
                    style={inputStyle}
                  />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1', flexDirection: 'row', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(draft.rule.fireImmediately)}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      rule: current.rule.kind === 'interval'
                        ? { ...current.rule, fireImmediately: event.target.checked }
                        : current.rule,
                    }))}
                  />
                  <span>创建后立即触发一次</span>
                </label>
              </div>
            ) : (
              <div style={gridStyle}>
                <label style={fieldStyle}>
                  <span>日期</span>
                  <input type="date" value={draft.rule.date} onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm' ? { ...current.rule, date: event.target.value } : current.rule,
                  }))} style={inputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span>时间</span>
                  <input type="time" value={draft.rule.time} onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm' ? { ...current.rule, time: event.target.value } : current.rule,
                  }))} style={inputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span>重复</span>
                  <select value={draft.rule.repeat} onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm'
                      ? { ...current.rule, repeat: event.target.value as typeof current.rule.repeat }
                      : current.rule,
                  }))} style={inputStyle}>
                    <option value="once">仅一次</option>
                    <option value="daily">每天</option>
                    <option value="weekdays">工作日</option>
                    <option value="weekly">每周</option>
                    <option value="custom">自定义周几</option>
                  </select>
                </label>
                <label style={fieldStyle}>
                  <span>时区</span>
                  <input value={draft.rule.timezone} onChange={(event) => setDraft((current) => ({
                    ...current,
                    rule: current.rule.kind === 'alarm' ? { ...current.rule, timezone: event.target.value } : current.rule,
                  }))} style={inputStyle} />
                </label>
                {draft.rule.repeat === 'custom' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {['日', '一', '二', '三', '四', '五', '六'].map((label, index) => {
                      const selected = draft.rule.kind === 'alarm' && Array.isArray(draft.rule.weekdays)
                        ? draft.rule.weekdays.includes(index)
                        : false;
                      return (
                        <button
                          key={label}
                          className="ghost-button"
                          type="button"
                          style={selected ? { background: 'rgba(120, 156, 221, 0.18)' } : undefined}
                          onClick={() => setDraft((current) => {
                            if (current.rule.kind !== 'alarm') {
                              return current;
                            }
                            const weekdays = Array.isArray(current.rule.weekdays) ? current.rule.weekdays : [];
                            const nextWeekdays = weekdays.includes(index)
                              ? weekdays.filter((day) => day !== index)
                              : [...weekdays, index].sort((left, right) => left - right);
                            return {
                              ...current,
                              rule: {
                                ...current.rule,
                                weekdays: nextWeekdays,
                              },
                            };
                          })}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="ghost-button" type="button" onClick={() => handleEdit()}>Reset</button>
              <button className="shell-primary-button" type="button" onClick={submit}>
                {editingJob ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(166, 186, 214, 0.12)',
  background: 'rgba(255,255,255,0.03)',
  padding: 14,
};

const subtleStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#94a4ba',
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 12,
  color: '#dbe5f4',
  fontSize: 12,
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid rgba(165, 185, 215, 0.14)',
  background: 'rgba(255,255,255,0.05)',
  color: '#edf2fa',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 12,
  marginTop: 12,
};

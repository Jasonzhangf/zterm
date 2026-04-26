// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleJob, SessionScheduleState } from '../../lib/types';
import { SessionScheduleSheet } from './SessionScheduleSheet';

afterEach(() => {
  cleanup();
});

function createJob(overrides?: Partial<ScheduleJob>): ScheduleJob {
  const now = new Date().toISOString();
  return {
    id: 'job-1',
    targetSessionName: 'demo-session',
    label: 'test-heartbeat',
    enabled: true,
    payload: { text: 'echo hello', appendEnter: true },
    rule: { kind: 'interval', intervalMs: 60000, startAt: now },
    nextFireAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createState(jobs: ScheduleJob[] = []): SessionScheduleState {
  return { sessionName: 'demo-session', jobs, loading: false };
}

function renderSheet(props?: Partial<React.ComponentProps<typeof SessionScheduleSheet>>) {
  const defaults = {
    open: true,
    sessionName: 'demo-session',
    scheduleState: createState(),
    composerSeedText: '',
    composerSeedNonce: 0,
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onRunNow: vi.fn(),
  };
  return render(<SessionScheduleSheet {...defaults} {...props} />);
}

describe('SessionScheduleSheet', () => {
  it('prefills composer draft text when opened from quick input schedule entry', () => {
    renderSheet({ composerSeedText: 'echo seeded from quick input', composerSeedNonce: 1 });
    expect((screen.getByPlaceholderText('输入要定时发送到 tmux session 的文本') as HTMLTextAreaElement).value).toBe('echo seeded from quick input');
  });

  it('renders empty state when no jobs exist', () => {
    renderSheet();
    expect(screen.getByText('还没有定时任务。先新建一个 interval 或 alarm。')).toBeTruthy();
  });

  it('renders existing job with label, rule description, and action buttons', () => {
    const job = createJob({ label: 'heartbeat', rule: { kind: 'interval', intervalMs: 60000, startAt: new Date().toISOString() } });
    renderSheet({ scheduleState: createState([job]) });
    expect(screen.getByText('heartbeat')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Run now')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
  });

  it('creates a new schedule job with text and interval', () => {
    const onSave = vi.fn();
    renderSheet({ onSave });

    // Fill text
    const textarea = screen.getByPlaceholderText('输入要定时发送到 tmux session 的文本');
    fireEvent.change(textarea, { target: { value: 'echo scheduled' } });

    // Fill interval
    const intervalInput = screen.getByDisplayValue('30');
    fireEvent.change(intervalInput, { target: { value: '5' } });

    // Submit
    const createButton = screen.getByText('Create');
    fireEvent.click(createButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedJob = onSave.mock.calls[0][0];
    expect(savedJob.payload.text).toBe('echo scheduled');
    expect(savedJob.rule.kind).toBe('interval');
    expect(savedJob.rule.intervalMs).toBe(5 * 60 * 1000);
    expect(savedJob.targetSessionName).toBe('demo-session');
  });

  it('does not submit when text is empty', () => {
    const onSave = vi.fn();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderSheet({ onSave });

    const createButton = screen.getByText('Create');
    fireEvent.click(createButton);

    expect(onSave).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('先填写要发送的文本。');
    alertSpy.mockRestore();
  });

  it('toggles job enabled state', () => {
    const onToggle = vi.fn();
    const job = createJob({ id: 'job-42', enabled: true });
    renderSheet({ onToggle, scheduleState: createState([job]) });

    const checkbox = screen.getByRole('checkbox', { name: 'Enabled' });
    fireEvent.click(checkbox);

    expect(onToggle).toHaveBeenCalledWith('job-42', false);
  });

  it('calls onRunNow when Run now is clicked', () => {
    const onRunNow = vi.fn();
    const job = createJob({ id: 'job-7' });
    renderSheet({ onRunNow, scheduleState: createState([job]) });

    fireEvent.click(screen.getByText('Run now'));
    expect(onRunNow).toHaveBeenCalledWith('job-7');
  });

  it('calls onDelete when Delete is clicked', () => {
    const onDelete = vi.fn();
    const job = createJob({ id: 'job-3' });
    renderSheet({ onDelete, scheduleState: createState([job]) });

    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith('job-3');
  });

  it('enters edit mode and updates existing job', () => {
    const onSave = vi.fn();
    const job = createJob({ id: 'job-5', label: 'old-label', payload: { text: 'old-text', appendEnter: false } });
    renderSheet({ onSave, scheduleState: createState([job]) });

    // Enter edit mode
    fireEvent.click(screen.getByText('Edit'));

    // Verify existing values loaded
    const textarea = screen.getByPlaceholderText('输入要定时发送到 tmux session 的文本') as HTMLTextAreaElement;
    expect(textarea.value).toBe('old-text');

    // Modify text
    fireEvent.change(textarea, { target: { value: 'updated-text' } });

    // Submit update
    fireEvent.click(screen.getByText('Update'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.id).toBe('job-5');
    expect(saved.payload.text).toBe('updated-text');
  });

  it('switches between interval and alarm rule types', () => {
    renderSheet();

    const select = screen.getByDisplayValue('周期');
    fireEvent.change(select, { target: { value: 'alarm' } });

    // Alarm fields should appear
    expect(screen.getByText('日期')).toBeTruthy();
    expect(screen.getByText('时间')).toBeTruthy();
    expect(screen.getByText('重复')).toBeTruthy();
    expect(screen.getByText('时区')).toBeTruthy();
  });

  it('calls onClose when Done is clicked', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });

    fireEvent.click(screen.getByText('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onRefresh when Refresh is clicked', () => {
    const onRefresh = vi.fn();
    renderSheet({ onRefresh });

    fireEvent.click(screen.getByText('Refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders error state from lastResult', () => {
    const job = createJob({ lastResult: 'error', lastError: 'tmux session not found' });
    renderSheet({ scheduleState: createState([job]) });
    expect(screen.getByText('最近错误：tmux session not found')).toBeTruthy();
  });

  it('renders disabled job without checked checkbox', () => {
    const job = createJob({ id: 'job-off', enabled: false });
    renderSheet({ scheduleState: createState([job]) });

    const checkbox = screen.getByRole('checkbox', { name: 'Enabled' });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });
});

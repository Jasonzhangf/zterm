// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionScheduleSheet } from './SessionScheduleSheet';

afterEach(() => {
  cleanup();
});

describe('SessionScheduleSheet', () => {
  it('prefills composer draft text when opened from quick input schedule entry', () => {
    render(
      <SessionScheduleSheet
        open
        sessionName="demo-session"
        scheduleState={{ sessionName: 'demo-session', jobs: [], loading: false }}
        composerSeedText={'echo seeded from quick input'}
        composerSeedNonce={1}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect((screen.getByPlaceholderText('输入要定时发送到 tmux session 的文本') as HTMLTextAreaElement).value).toBe('echo seeded from quick input');
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenameDialog } from './RenameDialog';

describe('RenameDialog', () => {
  afterEach(cleanup);

  it('submits the trimmed value with Enter', () => {
    const onSubmit = vi.fn();
    render(
      <RenameDialog
        open
        title="重命名标签页"
        initialValue="main"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  work  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('work');
  });

  it('blocks blank submit and cancels with Escape', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <RenameDialog
        open
        title="重命名 tmux session"
        initialValue="main"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

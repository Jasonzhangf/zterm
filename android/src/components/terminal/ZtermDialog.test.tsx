// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZtermDialog } from './ZtermDialog';

describe('ZtermDialog', () => {
  afterEach(cleanup);

  it('renders title, message and detail with the requested tone', () => {
    render(
      <ZtermDialog
        open
        tone="error"
        title="关闭失败"
        message="host mac-studio is offline"
        detail="TypeError: fetch failed"
        confirmLabel="知道了"
        onConfirm={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('zterm-dialog');
    expect(panel.getAttribute('data-tone')).toBe('error');
    expect(screen.getByText('关闭失败')).toBeTruthy();
    expect(screen.getByTestId('zterm-dialog-message').textContent).toContain(
      'host mac-studio is offline',
    );
    expect(screen.getByTestId('zterm-dialog-detail').textContent).toContain(
      'TypeError: fetch failed',
    );
    expect(screen.getByTestId('zterm-dialog-glyph').textContent).toBe('×');
  });

  it('invokes onConfirm when the primary button is clicked and does not block tests synchronously', () => {
    const onConfirm = vi.fn();
    render(
      <ZtermDialog
        open
        title="关闭 session"
        confirmLabel="关闭"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByTestId('zterm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders cancel button when showCancel is set and forwards cancel clicks', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ZtermDialog
        open
        title="Kill session"
        showCancel
        confirmLabel="Kill"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('zterm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('auto-dismisses by calling onConfirm after the timer fires', async () => {
    const onConfirm = vi.fn();
    render(
      <ZtermDialog
        open
        tone="info"
        title="已保存"
        autoDismissMs={40}
        onConfirm={onConfirm}
      />,
    );

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('does not render anything when open=false', () => {
    render(
      <ZtermDialog
        open={false}
        title="hidden"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('zterm-dialog')).toBeNull();
  });
});

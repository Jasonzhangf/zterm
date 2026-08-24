// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZtermDialog } from './ZtermDialog';

describe('ZtermDialog', () => {
  afterEach(cleanup);

  it('defines every referenced dialog animation in the owning stylesheet', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/index.css'),
      'utf8',
    );
    const animationNames = [
      'ztermDialogFade',
      'ztermDialogPop',
      'ztermDialogSpin',
      'ztermDialogExit',
      'ztermDialogPanelExit',
    ];

    for (const animationName of animationNames) {
      expect(stylesheet).toContain(`@keyframes ${animationName}`);
    }
  });

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
    expect(screen.getByTestId('zterm-dialog-glyph').querySelector('svg')).not.toBeNull();
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

  it('closes through Escape without invoking the destructive action', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ZtermDialog
        open
        title="Kill session"
        showCancel
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByTestId('zterm-dialog-panel'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the dialog', () => {
    render(
      <ZtermDialog
        open
        title="Kill session"
        showCancel
        confirmLabel="Kill"
        cancelLabel="Cancel"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const panel = screen.getByTestId('zterm-dialog-panel');
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('zterm-dialog-cancel'));
  });

  it('plays a bounded exit transition before removing the dialog', async () => {
    const { rerender } = render(
      <ZtermDialog open title="Saved" onConfirm={vi.fn()} />,
    );

    rerender(<ZtermDialog open={false} title="Saved" onConfirm={vi.fn()} />);
    const closingPanel = screen.getByTestId('zterm-dialog');
    expect(closingPanel.style.animation).toContain('ztermDialogExit');

    await waitFor(() => {
      expect(screen.queryByTestId('zterm-dialog')).toBeNull();
    }, { timeout: 300 });
  });

  it('uses shell theme tokens instead of fixed dark error colors', () => {
    render(
      <div className="zterm-terminal-shell" data-terminal-shell-skin="blue">
        <ZtermDialog
          open
          tone="error"
          title="关闭失败"
          message="daemon did not answer"
          onConfirm={vi.fn()}
        />
      </div>,
    );

    expect(screen.getByTestId('zterm-dialog').style.backgroundColor).toContain('--zterm-sheet-overlay');
    expect(screen.getByTestId('zterm-dialog-glyph').style.color).toMatch(/--zterm-dialog-error|--zterm-panel-danger/);
  });
});

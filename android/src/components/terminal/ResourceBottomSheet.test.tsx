// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceBottomSheet } from './ResourceBottomSheet';

describe('ResourceBottomSheet', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the remote file slot inside the bottom sheet and switches to web rendering', () => {
    const renderFileBrowser = vi.fn((open: boolean) => open ? <div data-testid="remote-files">files</div> : null);
    render(<ResourceBottomSheet open renderFileBrowser={renderFileBrowser} onClose={vi.fn()} />);

    expect(screen.getByTestId('remote-files')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '网页' }));
    expect(screen.getByTestId('resource-web-pane')).toBeTruthy();
    expect(screen.queryByTestId('remote-files')).toBeNull();
    expect(renderFileBrowser).toHaveBeenLastCalledWith(false);
  });

  it('hosts remote window streaming as the third resource surface', () => {
    const renderRemoteWindow = vi.fn((open: boolean) => open ? <div data-testid="remote-stream">stream</div> : null);
    render(<ResourceBottomSheet open renderFileBrowser={() => null} renderRemoteWindow={renderRemoteWindow} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '窗口串流' }));
    expect(screen.getByTestId('resource-stream-pane')).toBeTruthy();
    expect(screen.getByTestId('remote-stream')).toBeTruthy();
    expect(renderRemoteWindow).toHaveBeenLastCalledWith(true);
  });

  it('accepts only http(s) URLs and renders the submitted page in a sandbox', () => {
    const onWebUrlChange = vi.fn();
    render(<ResourceBottomSheet open renderFileBrowser={() => null} onWebUrlChange={onWebUrlChange} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '网页' }));
    fireEvent.change(screen.getByLabelText('网页地址'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByRole('alert').textContent).toContain('仅支持 http:// 或 https:// 地址');
    expect(onWebUrlChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('网页地址'), { target: { value: 'https://example.com/docs' } });
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    const frame = screen.getByTitle('网页渲染');
    expect(frame.getAttribute('src')).toBe('https://example.com/docs');
    expect(frame.getAttribute('sandbox')).toBe('allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(onWebUrlChange).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('closes from the backdrop and downward swipe', () => {
    const onClose = vi.fn();
    render(<ResourceBottomSheet open renderFileBrowser={() => null} onClose={onClose} />);
    const overlay = screen.getByTestId('resource-bottom-sheet-overlay');
    fireEvent.click(overlay);
    fireEvent.touchStart(overlay, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(overlay, { changedTouches: [{ clientY: 180 }] });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

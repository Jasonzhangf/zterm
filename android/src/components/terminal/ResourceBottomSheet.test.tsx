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
    expect((screen.getByTestId('resource-bottom-sheet-overlay') as HTMLElement).style.zIndex).toBe('40');
    expect(renderRemoteWindow).toHaveBeenLastCalledWith(true, 'stream', false, expect.any(Function));
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
    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.click(overlay);
    fireEvent.touchStart(handle, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 180 }] });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps stream gestures inside the stream pane', () => {
    const onClose = vi.fn();
    render(<ResourceBottomSheet open initialTab="stream" renderFileBrowser={() => null} renderRemoteWindow={() => <div data-testid="stream-surface" />} onClose={onClose} />);
    const pane = screen.getByTestId('resource-stream-pane');
    fireEvent.touchStart(pane, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(pane, { touches: [{ clientY: 80 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientY: 80 }] });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps file page vertical drags inside the content scope', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        renderFileBrowser={() => <div data-testid="remote-files">files</div>}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const files = screen.getByTestId('remote-files');
    fireEvent.touchStart(files, { touches: [{ clientY: 150 }] });
    fireEvent.touchMove(files, { touches: [{ clientY: 220 }] });
    fireEvent.touchEnd(files, { changedTouches: [{ clientY: 220 }] });

    fireEvent.touchStart(files, { touches: [{ clientY: 220 }] });
    fireEvent.touchEnd(files, { changedTouches: [{ clientY: 140 }] });

    expect(onClose).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('completes a handle drag when WebView retargets the touchend to the overlay shell', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        renderFileBrowser={() => <div data-testid="remote-files">files</div>}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const overlay = screen.getByTestId('resource-bottom-sheet-overlay');
    const handle = screen.getByTestId('resource-bottom-sheet-grip');
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 41, clientY: 240 }],
      changedTouches: [{ identifier: 41, clientY: 240 }],
    });
    fireEvent.touchEnd(overlay, {
      changedTouches: [{ identifier: 41, clientY: 100 }],
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('does not let a content-originated touchend expand the drawer', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        renderFileBrowser={() => <div data-testid="remote-files">files</div>}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const overlay = screen.getByTestId('resource-bottom-sheet-overlay');
    const files = screen.getByTestId('remote-files');
    fireEvent.touchStart(files, {
      touches: [{ identifier: 51, clientY: 240 }],
      changedTouches: [{ identifier: 51, clientY: 240 }],
    });
    fireEvent.touchEnd(overlay, {
      changedTouches: [{ identifier: 51, clientY: 100 }],
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('keeps toolbar button gestures from driving drawer open/close actions', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(<ResourceBottomSheet open renderFileBrowser={() => null} onClose={onClose} onExpand={onExpand} />);

    const nav = screen.getByLabelText('资源类型');
    fireEvent.touchStart(nav, { touches: [{ clientY: 120 }] });
    fireEvent.touchEnd(nav, { changedTouches: [{ clientY: 220 }] });
    fireEvent.touchStart(nav, { touches: [{ clientY: 220 }] });
    fireEvent.touchEnd(nav, { changedTouches: [{ clientY: 120 }] });

    expect(onClose).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('keeps stream pane vertical drags from expanding or closing the parent drawer', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const pane = screen.getByTestId('resource-stream-pane');
    fireEvent.touchStart(pane, { touches: [{ clientY: 240 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientY: 100 }] });
    fireEvent.touchStart(pane, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientY: 240 }] });

    expect(onClose).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('clears a handle gesture when a nested pointer is cancelled', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    const pane = screen.getByTestId('resource-stream-pane');
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 240 });
    fireEvent.pointerCancel(pane, { pointerId: 1, clientY: 120 });
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 240 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 120 });

    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps handle drag authoritative when pointer capture retargets the shared touch sequence', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    const pane = screen.getByTestId('resource-stream-pane');
    let capturedTarget: HTMLElement | null = null;
    const setPointerCapture = vi.fn(() => {
      capturedTarget = handle;
    });
    const releasePointerCapture = vi.fn(() => {
      capturedTarget = null;
    });
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(handle, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });
    Object.defineProperty(handle, 'hasPointerCapture', { configurable: true, value: () => capturedTarget === handle });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 240 });
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 1, clientY: 240 }],
      changedTouches: [{ identifier: 1, clientY: 240 }],
    });
    fireEvent.pointerUp(capturedTarget ?? pane, { pointerId: 1, clientY: 100 });
    fireEvent.touchEnd(handle, { changedTouches: [{ identifier: 1, clientY: 100 }] });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the first handle touch as owner when a second handle touch ends', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 11, clientY: 240 }],
      changedTouches: [{ identifier: 11, clientY: 240 }],
    });
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 11, clientY: 240 }, { identifier: 22, clientY: 100 }],
      changedTouches: [{ identifier: 22, clientY: 100 }],
    });
    fireEvent.touchEnd(handle, {
      touches: [{ identifier: 11, clientY: 240 }],
      changedTouches: [{ identifier: 22, clientY: 340 }],
    });
    fireEvent.touchEnd(handle, {
      touches: [],
      changedTouches: [{ identifier: 11, clientY: 100 }],
    });

    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ends the owner touch when a batch release lists a non-owner first', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    const renderRemoteWindow = vi.fn((
      open: boolean,
      _tab?: 'stream' | 'web',
      _expanded?: boolean,
      onExitFullscreen?: () => void,
    ) => open ? <button type="button" onClick={onExitFullscreen}>退出串流全屏</button> : null);
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={renderRemoteWindow}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    let handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 11, clientY: 240 }],
      changedTouches: [{ identifier: 11, clientY: 240 }],
    });
    fireEvent.touchEnd(handle, {
      touches: [],
      changedTouches: [{ identifier: 22, clientY: 340 }, { identifier: 11, clientY: 100 }],
    });

    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '退出串流全屏' }));
    handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;

    fireEvent.touchStart(handle, {
      touches: [{ identifier: 33, clientY: 240 }],
      changedTouches: [{ identifier: 33, clientY: 240 }],
    });
    fireEvent.touchEnd(handle, {
      touches: [],
      changedTouches: [{ identifier: 33, clientY: 100 }],
    });

    expect(onExpand).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels the owner touch when a batch cancel lists a non-owner first', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 11, clientY: 240 }],
      changedTouches: [{ identifier: 11, clientY: 240 }],
    });
    fireEvent.touchCancel(handle, {
      touches: [],
      changedTouches: [{ identifier: 22, clientY: 100 }, { identifier: 11, clientY: 100 }],
    });

    expect(onExpand).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.touchStart(handle, {
      touches: [{ identifier: 33, clientY: 240 }],
      changedTouches: [{ identifier: 33, clientY: 240 }],
    });
    fireEvent.touchEnd(handle, {
      touches: [],
      changedTouches: [{ identifier: 33, clientY: 100 }],
    });

    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps handle pointer ownership while a stream pinch runs in parallel', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    const pane = screen.getByTestId('resource-stream-pane');
    let capturedTarget: HTMLElement | null = null;
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: () => {
        capturedTarget = handle;
      },
    });
    Object.defineProperty(handle, 'releasePointerCapture', {
      configurable: true,
      value: () => {
        capturedTarget = null;
      },
    });
    Object.defineProperty(handle, 'hasPointerCapture', { configurable: true, value: () => capturedTarget === handle });

    fireEvent.pointerDown(handle, { pointerId: 3, clientY: 260 });
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 3, clientY: 260 }],
      changedTouches: [{ identifier: 3, clientY: 260 }],
    });
    fireEvent.touchStart(pane, {
      touches: [{ identifier: 31, clientY: 180 }, { identifier: 32, clientY: 180 }],
      changedTouches: [{ identifier: 31, clientY: 180 }, { identifier: 32, clientY: 180 }],
    });
    fireEvent.touchMove(pane, {
      touches: [{ identifier: 31, clientY: 120 }, { identifier: 32, clientY: 240 }],
      changedTouches: [{ identifier: 31, clientY: 120 }, { identifier: 32, clientY: 240 }],
    });
    fireEvent.touchEnd(pane, {
      touches: [],
      changedTouches: [{ identifier: 31, clientY: 120 }, { identifier: 32, clientY: 240 }],
    });
    fireEvent.pointerUp(capturedTarget ?? pane, { pointerId: 3, clientY: 100 });
    fireEvent.touchEnd(handle, { changedTouches: [{ identifier: 3, clientY: 100 }] });

    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears a captured handle pointer on pointer cancel', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    let capturedTarget: HTMLElement | null = null;
    const releasePointerCapture = vi.fn(() => {
      capturedTarget = null;
    });
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: () => {
        capturedTarget = handle;
      },
    });
    Object.defineProperty(handle, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });
    Object.defineProperty(handle, 'hasPointerCapture', { configurable: true, value: () => capturedTarget === handle });

    fireEvent.pointerDown(handle, { pointerId: 7, clientY: 240 });
    fireEvent.touchStart(handle, {
      touches: [{ identifier: 7, clientY: 240 }],
      changedTouches: [{ identifier: 7, clientY: 240 }],
    });
    fireEvent.pointerCancel(handle, { pointerId: 7, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientY: 100 });
    fireEvent.touchEnd(handle, { changedTouches: [{ identifier: 7, clientY: 100 }] });

    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onExpand).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a cancelled grip gesture from expanding or closing the drawer', () => {
    const onClose = vi.fn();
    const onExpand = vi.fn();
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        renderFileBrowser={() => null}
        renderRemoteWindow={() => <div data-testid="stream-surface" />}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );

    const handle = screen.getByTestId('resource-bottom-sheet-grip');
    expect(handle.style.touchAction).toBe('none');

    fireEvent.pointerDown(handle, { pointerId: 9, clientY: 240 });
    fireEvent.pointerCancel(handle, { pointerId: 9, clientY: 100 });
    fireEvent.touchEnd(handle, { changedTouches: [{ identifier: 9, clientY: 100 }] });

    expect(onExpand).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides duplicate drawer chrome when the stream expands to fullscreen', () => {
    const renderRemoteWindow = vi.fn((open: boolean) => open ? <div data-testid="stream-surface" /> : null);
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        placement="bottom"
        renderFileBrowser={() => null}
        renderRemoteWindow={renderRemoteWindow}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: '资源类型' })).toBeTruthy();
    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.touchStart(handle, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 180 }] });

    expect(renderRemoteWindow).toHaveBeenLastCalledWith(true, 'stream', true, expect.any(Function));
    expect(screen.queryByRole('navigation', { name: '资源类型' })).toBeNull();
    expect(screen.queryByTestId('resource-bottom-sheet-grip')).toBeNull();
    expect(screen.getByTestId('resource-bottom-sheet').style.height).toBe('100%');
  });

  it('restores drawer chrome when the expanded stream exits fullscreen', () => {
    const renderRemoteWindow = vi.fn((
      open: boolean,
      _tab?: 'stream' | 'web',
      _expanded?: boolean,
      onExitFullscreen?: () => void,
    ) => open ? <button type="button" onClick={onExitFullscreen}>退出串流全屏</button> : null);
    render(
      <ResourceBottomSheet
        open
        initialTab="stream"
        placement="bottom"
        renderFileBrowser={() => null}
        renderRemoteWindow={renderRemoteWindow}
        onClose={vi.fn()}
      />,
    );

    const handle = screen.getByLabelText('资源').querySelector('[data-resource-drawer-handle]') as HTMLElement;
    fireEvent.touchStart(handle, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 180 }] });
    expect(screen.queryByRole('navigation', { name: '资源类型' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '退出串流全屏' }));

    expect(screen.getByRole('navigation', { name: '资源类型' })).toBeTruthy();
    expect(screen.getByTestId('resource-bottom-sheet-grip')).toBeTruthy();
    expect(renderRemoteWindow).toHaveBeenLastCalledWith(true, 'stream', false, expect.any(Function));
  });
});

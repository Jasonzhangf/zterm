// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalQuickBar } from './TerminalQuickBar';

vi.mock('../../plugins/DeviceClipboardPlugin', () => ({
  DeviceClipboardPlugin: {
    readText: vi.fn().mockResolvedValue({ value: '' }),
  },
  isNativeClipboardSupported: () => false,
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function stubVisualViewport(overrides?: Partial<VisualViewport>) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const visualViewport = {
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    addEventListener,
    removeEventListener,
    ...overrides,
  } as Record<string, unknown>;

  if (!('width' in (overrides || {}))) {
    Object.defineProperty(visualViewport, 'width', {
      configurable: true,
      get: () => window.innerWidth,
    });
  }

  if (!('height' in (overrides || {}))) {
    Object.defineProperty(visualViewport, 'height', {
      configurable: true,
      get: () => window.innerHeight,
    });
  }

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: visualViewport as unknown as VisualViewport,
  });

  return { visualViewport: visualViewport as unknown as VisualViewport, addEventListener, removeEventListener };
}

describe('TerminalQuickBar', () => {
  beforeEach(() => {
    cleanup();
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    stubVisualViewport();
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderQuickBar(props?: Partial<React.ComponentProps<typeof TerminalQuickBar>>) {
    return render(
      <TerminalQuickBar
        activeSessionId="session-1"
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onSendSequence={vi.fn()}
        onSessionDraftChange={vi.fn()}
        onSessionDraftSend={vi.fn()}
        onQuickActionsChange={vi.fn()}
        onShortcutActionsChange={vi.fn()}
        onOpenScheduleComposer={vi.fn()}
        onMeasuredHeightChange={vi.fn()}
        {...props}
      />,
    );
  }

  it('closes floating quick input when clicking outside', async () => {
    renderQuickBar();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    expect(screen.getByText('快捷输入')).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByText('快捷输入')).toBeNull();
    });
  });

  it('opens schedule composer from current draft text', async () => {
    const onSessionDraftChange = vi.fn();
    const onOpenScheduleComposer = vi.fn();

    renderQuickBar({
      sessionDraft: 'echo schedule me',
      onSessionDraftChange,
      onOpenScheduleComposer,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    fireEvent.click(screen.getByRole('button', { name: '定时' }));

    await waitFor(() => {
      expect(onOpenScheduleComposer).toHaveBeenCalledWith('echo schedule me');
    });
  });

  it('still opens the current session schedule list even when local draft is empty', async () => {
    const onOpenScheduleComposer = vi.fn();

    renderQuickBar({
      sessionDraft: '',
      onOpenScheduleComposer,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    fireEvent.click(screen.getByRole('button', { name: '定时' }));

    await waitFor(() => {
      expect(onOpenScheduleComposer).toHaveBeenCalledWith('');
    });
  });

  it('persists floating bubble position after drag', async () => {
    renderQuickBar();

    const bubble = screen.getByRole('button', { name: 'Toggle floating quick menu' });
    fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 54 });
    fireEvent.pointerUp(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 54 });

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(typeof parsed.x).toBe('number');
      expect(typeof parsed.y).toBe('number');
    });
  });

  it('rescues stored floating bubble position back into viewport on mount', async () => {
    localStorage.setItem(
      'zterm:floating-bubble-position',
      JSON.stringify({ x: 9999, y: 9999 }),
    );

    renderQuickBar();

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it('re-clamps floating bubble position after viewport resize', async () => {
    localStorage.setItem(
      'zterm:floating-bubble-position',
      JSON.stringify({ x: 500, y: 500 }),
    );
    renderQuickBar();

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 220,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 180,
    });

    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      const raw = localStorage.getItem('zterm:floating-bubble-position');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}');
      expect(parsed.x).toBeLessThan(window.innerWidth);
      expect(parsed.y).toBeLessThan(window.innerHeight);
    });
  });

  it('hides shell quick rows while floating menu is open', async () => {
    renderQuickBar();

    expect(screen.getByRole('button', { name: '状态' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '文件' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '状态' })).toBeNull();
      expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
    });
  });

  it('restores shell quick rows after floating menu closes', async () => {
    renderQuickBar();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '状态' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭快捷输入' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '状态' })).not.toBeNull();
      expect(screen.getByRole('button', { name: '文件' })).not.toBeNull();
    });
  });

  it('lifts floating bubble above keyboard inset', async () => {
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 240,
    });

    const bubble = screen.getByRole('button', { name: 'Toggle floating quick menu' });
    const style = bubble.getAttribute('style') || '';
    expect(style).toContain('bottom: calc(312px');
  });

  it('does not add a second keyboard inset padding inside shell quick rows', async () => {
    renderQuickBar({
      keyboardVisible: true,
      keyboardInsetPx: 240,
    });

    const shellRows = screen.getByTestId('terminal-quickbar-shell-rows');
    const style = shellRows.getAttribute('style') || '';
    expect(style).not.toContain('padding-bottom: 240px');
  });



  it('renders three shell rows with the third row as the visible tool bar', async () => {
    renderQuickBar({
      onOpenFileTransfer: vi.fn(),
      onToggleDebugOverlay: vi.fn(),
      onToggleAbsoluteLineNumbers: vi.fn(),
      onRequestRemoteScreenshot: vi.fn(),
    });

    const shellRows = screen.getByTestId('terminal-quickbar-shell-rows');
    expect(shellRows.querySelectorAll('[data-quickbar-shell-row="true"]').length).toBe(3);
    expect(screen.getByRole('button', { name: '状态' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '键盘' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '↑' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '←' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '↓' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '→' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '文件' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '图片' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '同步' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '截图' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '行号' })).not.toBeNull();

    const topFixedClusterButtons = screen
      .getByTestId('quickbar-fixed-cluster-top')
      .querySelectorAll('button');
    expect(Array.from(topFixedClusterButtons).map((node) => node.getAttribute('aria-label'))).toEqual(['状态', '↑', '键盘']);
    const topClusterStyle = screen.getByTestId('quickbar-fixed-cluster-top').getAttribute('style') || '';
    expect(topClusterStyle).toContain('width: 158px');
  });

  it('routes visible tool bar actions through explicit callbacks and keeps file/sync semantics correct', async () => {
    const onOpenFileTransfer = vi.fn();
    const onToggleDebugOverlay = vi.fn();
    const onToggleAbsoluteLineNumbers = vi.fn();
    const onRequestRemoteScreenshot = vi.fn().mockResolvedValue(undefined);
    const onFileAttach = vi.fn();

    renderQuickBar({
      onOpenFileTransfer,
      onFileAttach,
      onToggleDebugOverlay,
      onToggleAbsoluteLineNumbers,
      onRequestRemoteScreenshot,
    });

    fireEvent.click(screen.getByRole('button', { name: '状态' }));
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(screen.getByRole('button', { name: '同步' }));
    fireEvent.click(screen.getByRole('button', { name: '截图' }));
    fireEvent.click(screen.getByRole('button', { name: '行号' }));

    await waitFor(() => {
      expect(onOpenFileTransfer).toHaveBeenCalledTimes(1);
      expect(onToggleDebugOverlay).toHaveBeenCalledTimes(1);
      expect(onToggleAbsoluteLineNumbers).toHaveBeenCalledTimes(1);
      expect(onRequestRemoteScreenshot).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    expect(screen.queryByText('文件')).toBeNull();
    expect(screen.queryByText('图片')).toBeNull();
    expect(screen.queryByText('同步')).toBeNull();
    expect(screen.queryByText('截图')).toBeNull();
    expect(screen.queryByText('行号')).toBeNull();
  });

  it('shows screenshot transfer state on the visible third-row toolbar while keeping keyboard in the old fixed spot', async () => {
    renderQuickBar({
      remoteScreenshotStatus: 'transferring',
    });

    expect(screen.getByRole('button', { name: '键盘' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '传图中' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '截图' })).toBeNull();
  });

  it('deduplicates visible shortcut rows when saved shortcuts overlap built-in presets', async () => {
    renderQuickBar({
      shortcutActions: [
        { id: 'custom-tab', label: '我的 Tab', sequence: '\t', order: 0, row: 'top-scroll' },
        { id: 'custom-enter', label: '我的回车', sequence: '\r', order: 1, row: 'top-scroll' },
        { id: 'custom-paste', label: '我的粘贴', sequence: '\x16', order: 0, row: 'bottom-scroll' },
        { id: 'custom-senter', label: '我的换行', sequence: '\n', order: 1, row: 'bottom-scroll' },
      ],
    });

    expect(screen.getAllByRole('button', { name: '我的 Tab' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '我的回车' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '我的粘贴' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '我的换行' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'S-Enter' })).toBeNull();
  });

  it('blocks non-interactive shell clicks from bubbling to terminal layer', async () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <TerminalQuickBar
          activeSessionId="session-1"
          quickActions={[]}
          shortcutActions={[]}
          sessionDraft=""
          onSendSequence={vi.fn()}
          onSessionDraftChange={vi.fn()}
          onSessionDraftSend={vi.fn()}
          onQuickActionsChange={vi.fn()}
          onShortcutActionsChange={vi.fn()}
          onOpenScheduleComposer={vi.fn()}
          onMeasuredHeightChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId('terminal-quickbar-shell-rows'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('reports DOM editor focus transitions for quick input textarea', async () => {
    const onEditorDomFocusChange = vi.fn();
    renderQuickBar({
      onEditorDomFocusChange,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    const textarea = screen.getByPlaceholderText('预输入内容，按 session 持久化');
    fireEvent.focus(textarea);
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(onEditorDomFocusChange).toHaveBeenCalledWith(true);
      expect(onEditorDomFocusChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('keeps local quick-input textarea value stable while parent rerenders with stale sessionDraft during active editing', async () => {
    const onSessionDraftChange = vi.fn();

    function Harness() {
      const [sessionDraft] = React.useState('');
      const [tick, setTick] = React.useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((current) => current + 1)}>rerender</button>
          <div data-testid="tick">{tick}</div>
          <TerminalQuickBar
            activeSessionId="session-1"
            quickActions={[]}
            shortcutActions={[]}
            sessionDraft={sessionDraft}
            onSendSequence={vi.fn()}
            onSessionDraftChange={(value) => {
              onSessionDraftChange(value);
              // simulate parent persistence lag: do not immediately update sessionDraft prop
            }}
            onSessionDraftSend={vi.fn()}
            onQuickActionsChange={vi.fn()}
            onShortcutActionsChange={vi.fn()}
            onOpenScheduleComposer={vi.fn()}
            onMeasuredHeightChange={vi.fn()}
          />
        </div>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    const textarea = screen.getByPlaceholderText('预输入内容，按 session 持久化') as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: 'draft typing' } });

    expect(textarea.value).toBe('draft typing');
    expect(onSessionDraftChange).toHaveBeenLastCalledWith('draft typing');

    fireEvent.click(screen.getByText('rerender'));

    await waitFor(() => {
      expect(screen.getByTestId('tick').textContent).toBe('1');
      expect((screen.getByPlaceholderText('预输入内容，按 session 持久化') as HTMLTextAreaElement).value).toBe('draft typing');
    });
  });

  it('sends floating quick action immediately with trailing enter', async () => {
    const onSendSequence = vi.fn();
    renderQuickBar({
      quickActions: [
        {
          id: 'qa-1',
          label: 'ls',
          sequence: 'ls -la',
          order: 0,
        },
      ],
      onSendSequence,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    const actionLabel = screen.getByText('ls');
    const actionButton = actionLabel.closest('button');
    expect(actionButton).not.toBeNull();
    fireEvent.click(actionButton as HTMLButtonElement);

    await waitFor(() => {
      expect(onSendSequence).toHaveBeenCalledWith('ls -la\r');
    });
  });

  it('uses combo preview as default shortcut label when saving ctrl combination', async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);
    expect(screen.getByText('快捷按键设置')).not.toBeNull();
    expect(screen.getByText('当前滚动快捷键')).not.toBeNull();
    expect(screen.getByText('第二行（单按键）')).not.toBeNull();
    expect(screen.getByText('第三行（组合键）')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ 添加组合键' }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('快捷键名称 / 显示名称')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    fireEvent.change(screen.getByPlaceholderText('输入组合键里的目标字符，例如 c'), {
      target: { value: 'c' },
    });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));
    fireEvent.click(screen.getByRole('button', { name: '添加快捷键' }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(Array.isArray(latest)).toBe(true);
      expect(latest[latest.length - 1]?.label).toBe('Ctrl + C');
      expect(latest[latest.length - 1]?.row).toBe('bottom-scroll');
    });
  });

  it('keeps single-key row and combo row separated in shortcut manager', async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    fireEvent.click(screen.getByRole('button', { name: '+ 添加单按键' }));
    await waitFor(() => {
      expect(screen.getByText('当前编辑：第二行单按键')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Return' }));
    fireEvent.click(screen.getByRole('button', { name: '添加快捷键' }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(latest[latest.length - 1]?.label).toBe('Return');
      expect(latest[latest.length - 1]?.row).toBe('top-scroll');
    });
  });

  it('blocks saving multi-key content into first single-key row', async () => {
    renderQuickBar();

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '+ 添加单按键' }));

    expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('输入单个字母/数字/符号'), {
      target: { value: 'cd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    expect(screen.getByText('第二行只支持单个按键。')).not.toBeNull();
    expect(screen.getByRole('button', { name: '添加快捷键' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps enter decoded as single key when editing existing shortcut', async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-enter',
          label: 'Enter',
          sequence: '\r',
          order: 0,
          row: 'top-scroll',
        },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '编辑 Enter' }));

    await waitFor(() => {
      expect(screen.getByText('当前编辑：第二行单按键')).not.toBeNull();
      expect((screen.getByPlaceholderText('快捷键名称 / 显示名称') as HTMLInputElement).value).toBe('Enter');
      expect((screen.getByPlaceholderText('点击下方按钮选择单个按键') as HTMLTextAreaElement).value).toBe('Enter');
    });
  });

  it('allows renaming existing shortcut from explicit edit action', async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-copy',
          label: 'Ctrl + C',
          sequence: '\u0003',
          order: 0,
          row: 'bottom-scroll',
        },
      ],
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '编辑 Ctrl + C' }));

    await waitFor(() => {
      expect(screen.getByText('编辑快捷键')).not.toBeNull();
      expect((screen.getByPlaceholderText('快捷键名称 / 显示名称') as HTMLInputElement).value).toBe('Ctrl + C');
    });

    fireEvent.change(screen.getByPlaceholderText('快捷键名称 / 显示名称'), {
      target: { value: '复制当前行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存快捷键' }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalled();
      const calls = onShortcutActionsChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(latest).toEqual([
        {
          id: 'shortcut-copy',
          label: '复制当前行',
          sequence: '\u0003',
          order: 0,
          row: 'bottom-scroll',
        },
      ]);
    });
  });

  it('shows shortcut management list and allows delete from list page', async () => {
    const onShortcutActionsChange = vi.fn();

    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-1',
          label: 'Ctrl + C',
          sequence: '\u0003',
          order: 0,
          row: 'bottom-scroll',
        },
      ],
      onShortcutActionsChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    expect(screen.getByText('当前滚动快捷键')).not.toBeNull();
    expect(screen.getByRole('button', { name: '删除 Ctrl + C' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除 Ctrl + C' }));

    await waitFor(() => {
      expect(onShortcutActionsChange).toHaveBeenCalledWith([]);
    });
  });

  it('renders special shortcut keys with compact symbols instead of empty previews', async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-tab',
          label: 'Tab',
          sequence: '\t',
          order: 0,
          row: 'top-scroll',
        },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    const detailButton = screen.getByRole('button', { name: '查看 Tab 详情' });
    expect(detailButton.querySelector('[data-shortcut-keycap="Tab"]')).not.toBeNull();
    expect(detailButton.textContent).not.toContain('(空)');
  });

  it('renders terminal base special keys with familiar icon glyphs', async () => {
    renderQuickBar({
      shortcutActions: [
        { id: 's-tab', label: 'Tab', sequence: '\t', order: 0, row: 'top-scroll' },
        { id: 's-enter', label: 'Enter', sequence: '\r', order: 1, row: 'top-scroll' },
        { id: 's-space', label: 'Space', sequence: ' ', order: 2, row: 'top-scroll' },
      ],
    });

    expect(screen.getAllByRole('button', { name: 'Tab' }).some((button) => button.querySelector('[data-shortcut-keycap=\"Tab\"]'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Enter' }).some((button) => button.querySelector('[data-shortcut-keycap=\"Enter\"]'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Space' }).some((button) => button.querySelector('[data-shortcut-space-visual=\"true\"]'))).toBe(true);
  });

  it('renders space shortcut as a long narrow keycap visual in settings list', async () => {
    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-space',
          label: 'Space',
          sequence: ' ',
          order: 0,
          row: 'top-scroll',
        },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    const detailButton = screen.getByRole('button', { name: '查看 Space 详情' });
    expect(detailButton.querySelector('[data-shortcut-space-visual="true"]')).not.toBeNull();
    expect(detailButton.textContent).toContain('Space');
  });

  it('uses a dedicated scroll container for shortcut settings sheet', async () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 754,
    });
    stubVisualViewport({
      width: 347.4285583496094,
      height: 456.8571472167969,
      offsetTop: 0,
    });

    renderQuickBar({
      shortcutActions: [
        {
          id: 'shortcut-1',
          label: 'Ctrl + C',
          sequence: '\u0003',
          order: 0,
          row: 'bottom-scroll',
        },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    const scrollContainer = screen.getByTestId('shortcut-editor-scroll');
    const sheet = scrollContainer.parentElement;
    const overlay = sheet?.parentElement;
    const style = scrollContainer.getAttribute('style') || '';
    expect(style).toContain('flex: 1');
    expect(style).toContain('min-height: 0');
    expect(style).toContain('overflow-y: auto');
    expect(style).toContain('overflow-x: hidden');
    expect(style).toContain('touch-action: pan-y');
    expect(sheet?.getAttribute('style') || '').toContain('height: 441px');
    expect(overlay?.getAttribute('style') || '').toContain('padding-bottom: 297px');
    expect(screen.getByTestId('shortcut-editor-list').getAttribute('style') || '').toContain('min-height: max-content');
  });

  it('lifts quick action editor above visual viewport keyboard occlusion', async () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 754,
    });
    stubVisualViewport({
      width: 347.4285583496094,
      height: 456.8571472167969,
      offsetTop: 0,
    });

    renderQuickBar({
      quickActions: [
        {
          id: 'qa-1',
          label: 'ls',
          sequence: 'ls -la',
          order: 0,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    fireEvent.click(screen.getByRole('button', { name: '管理' }));

    await waitFor(() => {
      expect(screen.getByText('快捷输入设置')).not.toBeNull();
    });

    const scrollContainer = screen.getByTestId('quick-action-editor-scroll');
    const sheet = scrollContainer.parentElement;
    const overlay = sheet?.parentElement;
    expect(sheet?.getAttribute('style') || '').toContain('height: 441px');
    expect(overlay?.getAttribute('style') || '').toContain('padding-bottom: 297px');
  });

  it('resets shortcut editor scrollTop when switching from list to form', async () => {
    renderQuickBar({
      shortcutActions: [
        { id: 's1', label: 'Tab', sequence: '\t', order: 0, row: 'top-scroll' },
        { id: 's2', label: 'Enter', sequence: '\r', order: 1, row: 'top-scroll' },
        { id: 's3', label: 'Space', sequence: ' ', order: 2, row: 'top-scroll' },
        { id: 's4', label: 'S-Enter', sequence: '\n', order: 0, row: 'bottom-scroll' },
        { id: 's5', label: 'Esc', sequence: '\u001b', order: 1, row: 'bottom-scroll' },
        { id: 's6', label: 'Bksp', sequence: '\u007f', order: 2, row: 'bottom-scroll' },
        { id: 's7', label: 'Paste', sequence: '\u0016', order: 3, row: 'bottom-scroll' },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    const scrollContainer = screen.getByTestId('shortcut-editor-scroll');
    scrollContainer.scrollTop = 188;
    fireEvent.click(screen.getByRole('button', { name: '+ 添加组合键' }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('快捷键名称 / 显示名称')).not.toBeNull();
      expect(screen.getByTestId('shortcut-editor-scroll').scrollTop).toBe(0);
    });
  });

  it('hides floating bubble while shortcut editor is open', async () => {
    renderQuickBar();

    expect(screen.getByRole('button', { name: 'Toggle floating quick menu' })).not.toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '+' })[0]);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Toggle floating quick menu' })).toBeNull();
    });
  });

  it('starts repeat mode on long press and stops on next short tap', async () => {
    vi.useFakeTimers();
    const onSendSequence = vi.fn();

    renderQuickBar({
      onSendSequence,
      shortcutActions: [
        {
          id: 'shortcut-enter',
          label: 'Enter',
          sequence: '\r',
          order: 0,
          row: 'bottom-scroll',
        },
      ],
    });

    const enterButton = screen.getAllByRole('button', { name: 'Enter' })[0] as HTMLButtonElement;

    fireEvent.pointerDown(enterButton, { pointerId: 1, pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(720);
    });

    expect(onSendSequence.mock.calls.length).toBeGreaterThan(2);
    expect(enterButton.getAttribute('aria-pressed')).toBe('true');

    const callCountBeforeStop = onSendSequence.mock.calls.length;
    fireEvent.click(enterButton);

    act(() => {
      vi.advanceTimersByTime(240);
    });

    expect(enterButton.getAttribute('aria-pressed')).toBe('false');
    expect(onSendSequence).toHaveBeenCalledTimes(callCountBeforeStop);
    vi.useRealTimers();
  });
});

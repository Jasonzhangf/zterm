// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellWorkspace } from './ShellWorkspace';
import type { BridgeSettings } from '@zterm/shared';

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    getState: () => ({}) as any,
    subscribe: () => () => {},
    connectRemote: vi.fn(),
    connectLocalTmux: vi.fn(),
    disconnect: vi.fn(),
    setActivityMode: vi.fn(),
    updateViewport: vi.fn(),
    requestScheduleList: vi.fn(),
    upsertScheduleJob: vi.fn(),
    deleteScheduleJob: vi.fn(),
    toggleScheduleJob: vi.fn(),
    runScheduleJobNow: vi.fn(),
    sendInput: vi.fn(),
    pasteImage: () => true,
    resizeTerminal: vi.fn(),
    requestRemoteScreenshot: () => true,
    sendRawJson: () => true,
    onFileTransferMessage: () => () => {},
    dispose: vi.fn(),
  }),
  useTerminalRuntimeState: () => ({
    connection: { status: 'idle', error: '', connectedSessionId: '', title: '', activeTarget: null } as any,
    render: { lines: [], cols: 80, rows: 24 } as any,
    schedule: { jobs: [], loading: false } as any,
  }),
}));

function makeBridgeSettings(): BridgeSettings {
  return {
    defaultServerId: 'default',
    servers: [],
    currentServerId: 'default',
    targetHost: '127.0.0.1',
    targetPort: 3333,
    terminalThemeId: 'default',
    widthMode: 'adaptive-phone',
  } as any;
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() { return store.size; },
    },
  });
});

afterEach(() => cleanup());

function renderShell() {
  return render(
    <ShellWorkspace
      hosts={[]}
      isLoaded={true}
      bridgeSettings={makeBridgeSettings()}
      setBridgeSettings={vi.fn() as any}
      addHost={vi.fn() as any}
      updateHost={vi.fn()}
    />,
  );
}

describe('ShellWorkspace iTerm2-style split tree', () => {
  it('does not render fake in-app macOS traffic light buttons', () => {
    const { container } = renderShell();
    expect(container.querySelector('.traffic-light')).toBeNull();
    expect(container.querySelector('.shell-topbar-leading')).toBeNull();
  });

  it('creates a horizontal row split via Split', () => {
    const { container } = renderShell();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split')!);
    expect(container.querySelector('[data-split-direction="row"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shell-divider-vertical"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-pane-id]').length).toBe(2);
  });

  it('creates a vertical column split via Split ↓', () => {
    const { container } = renderShell();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split ↓')!);
    expect(container.querySelector('[data-split-direction="column"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shell-divider-horizontal"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-pane-id]').length).toBe(2);
  });

  it('shows per-pane split controls so new splits are discoverable', () => {
    const { container } = renderShell();
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Split →')).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Split ↓')).toBe(true);
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split →')!);
    expect(container.querySelector('[data-split-direction="row"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-pane-id]').length).toBe(2);
  });

  it('labels panes and highlights the hovered move target pane', () => {
    const { container } = renderShell();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split →')!);
    expect(container.querySelector('[aria-label="Pane 1"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Pane 2"]')).toBeTruthy();
    const firstTab = container.querySelector('[data-pane-number="1"] .shell-pane-tab')!;
    fireEvent.contextMenu(firstTab);
    const pane2MenuItem = Array.from(container.querySelectorAll('.shell-context-item')).find((button) => button.textContent === 'Pane 2')!;
    fireEvent.mouseEnter(pane2MenuItem);
    expect(container.querySelector('[data-pane-number="2"]')?.getAttribute('data-move-target-hover')).toBe('true');
    expect(container.querySelector('[data-pane-number="2"]')?.className).toContain('move-target-hover');
    fireEvent.mouseLeave(pane2MenuItem);
    expect(container.querySelector('[data-pane-number="2"]')?.getAttribute('data-move-target-hover')).toBe('false');
  });

  it('can nest vertical split inside an existing horizontal split', () => {
    const { container } = renderShell();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split')!);
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split ↓')!);
    expect(container.querySelector('[data-split-direction="row"]')).toBeTruthy();
    expect(container.querySelector('[data-split-direction="column"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-pane-id]').length).toBe(3);
  });

  it('does not cap recursive iTerm2-style splits at three panes', () => {
    const { container } = renderShell();
    const buttons = () => Array.from(container.querySelectorAll('button'));
    const splitRight = () => fireEvent.click(buttons().find((button) => button.textContent === 'Split')!);
    splitRight();
    splitRight();
    splitRight();
    expect(container.querySelectorAll('[data-pane-id]').length).toBe(4);
    expect(buttons().find((button) => button.textContent === 'Split')).not.toBeDisabled();
  });

  it('keeps vertical and horizontal resize handles distinct', () => {
    const { container } = renderShell();
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split')!);
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Split ↓')!);
    expect(container.querySelectorAll('[data-testid="shell-divider-vertical"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid="shell-divider-horizontal"]').length).toBe(1);
  });
});

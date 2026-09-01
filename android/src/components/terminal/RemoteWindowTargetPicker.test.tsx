// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { RemoteWindowTargetPicker } from './RemoteWindowTargetPicker';

afterEach(cleanup);

function target(id: string, kind: 'app-window' | 'iterm2-pane' = 'app-window', appBundleId?: string): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind,
      appBundleId: appBundleId || (kind === 'app-window' ? 'com.example.app' : 'com.googlecode.iterm2'),
      pid: 42,
      windowId: id,
      title: id,
      windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
    },
    inputTarget: { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  };
}

describe('RemoteWindowTargetPicker view owner', () => {
  it('renders loading truth without target controls', () => {
    render(<RemoteWindowTargetPicker
      phase="targetEnumerating"
      targets={[]}
      errors={[]}
      errorMessage={null}
      catalogRefreshing={false}
      itermPaneTargetsExpanded={false}
      onToggleItermPaneTargets={vi.fn()}
      onSelectTarget={vi.fn()}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(screen.getByTestId('remote-window-picker-loading')).toBeTruthy();
  });

  it('uses sibling buttons and emits selection, refresh, close, and pane-toggle intents', () => {
    const onSelectTarget = vi.fn();
    const onRefresh = vi.fn();
    const onClose = vi.fn();
    const onToggleItermPaneTargets = vi.fn();
    const appTarget = target('app-1');
    render(<RemoteWindowTargetPicker
      phase="pickerOpen"
      targets={[appTarget, target('pane-1', 'iterm2-pane')]}
      errors={[]}
      errorMessage={null}
      catalogRefreshing={false}
      itermPaneTargetsExpanded={false}
      onToggleItermPaneTargets={onToggleItermPaneTargets}
      onSelectTarget={onSelectTarget}
      onRefresh={onRefresh}
      onClose={onClose}
    />);

    fireEvent.click(screen.getByTestId(/remote-window-app-group-/));
    fireEvent.click(screen.getByRole('button', { name: '刷新远程窗口列表' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口选择' }));
    fireEvent.click(screen.getByTestId('remote-window-iterm-pane-group'));
    expect(onSelectTarget).toHaveBeenCalledWith(appTarget);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggleItermPaneTargets).toHaveBeenCalledTimes(1);
    expect(document.querySelector('button button')).toBeNull();
  });

  it('browser mode only exposes Chrome windows', () => {
    const onSelectTarget = vi.fn();
    const chromeTarget = target('chrome-1', 'app-window', 'com.google.Chrome');
    render(<RemoteWindowTargetPicker
      phase="pickerOpen"
      targets={[chromeTarget, target('safari-1', 'app-window', 'com.apple.Safari')]}
      errors={[]}
      errorMessage={null}
      catalogRefreshing={false}
      itermPaneTargetsExpanded={false}
      onToggleItermPaneTargets={vi.fn()}
      onSelectTarget={onSelectTarget}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
      browserOnly
    />);

    expect(screen.getByText('浏览器窗口')).toBeTruthy();
    expect(screen.getByTestId('remote-window-app-group-com-google-Chrome-42')).toBeTruthy();
    expect(screen.queryByText('safari-1')).toBeNull();
    fireEvent.click(screen.getByTestId('remote-window-app-group-com-google-Chrome-42'));
    expect(onSelectTarget).toHaveBeenCalledWith(chromeTarget);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { RemoteWindowAppSwitch } from './RemoteWindowAppSwitch';

afterEach(cleanup);

function target(id: string, kind: 'app-window' | 'iterm2-pane' = 'app-window'): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind,
      appBundleId: kind === 'app-window' ? 'com.example.app' : 'com.googlecode.iterm2',
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

describe('RemoteWindowAppSwitch view owner', () => {
  it('groups targets and emits select or dismiss according to active truth', () => {
    const active = target('active');
    const sibling = target('sibling');
    const pane = target('pane', 'iterm2-pane');
    const onSelectTarget = vi.fn();
    const onDismiss = vi.fn();
    render(<RemoteWindowAppSwitch
      targets={[active, sibling, pane]}
      activeTargetId="active"
      catalogSyncError="catalog partial"
      onSelectTarget={onSelectTarget}
      onDismiss={onDismiss}
    />);

    expect(screen.getByTestId('remote-window-active-catalog-sync-error').textContent).toContain('catalog partial');
    expect(screen.getByTestId('remote-window-active-app-switch-group-iterm2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-target-sibling'));
    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-target-active'));
    expect(onSelectTarget).toHaveBeenCalledWith(sibling);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders an explicit empty state', () => {
    render(<RemoteWindowAppSwitch
      targets={[]}
      activeTargetId="missing"
      catalogSyncError={null}
      onSelectTarget={vi.fn()}
      onDismiss={vi.fn()}
    />);
    expect(screen.getByText('没有可切换窗口')).toBeTruthy();
  });
});

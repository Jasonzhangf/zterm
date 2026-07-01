// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacDesktopApp } from './MacDesktopApp';

const addHost = vi.fn();
const updateHost = vi.fn();
const setSettings = vi.fn();
const transitionalShell = vi.fn();

vi.mock('@zterm/shared', async () => {
  const actual = await vi.importActual<typeof import('@zterm/shared')>('@zterm/shared');
  return {
    ...actual,
    useHostStorage: () => ({
      hosts: [{ id: 'host-1', name: 'mac-studio' }],
      isLoaded: true,
      addHost,
      updateHost,
    }),
    useBridgeSettingsStorage: () => ({
      settings: {
        defaultServerId: 'default',
        servers: [],
        currentServerId: 'default',
        targetHost: '127.0.0.1',
        targetPort: 3333,
        terminalThemeId: 'default',
        widthMode: 'adaptive-phone',
      },
      setSettings,
    }),
  };
});

vi.mock('./MacWorkspaceTransitionalShell', () => ({
  MacWorkspaceTransitionalShell: (props: Record<string, unknown>) => {
    transitionalShell(props);
    return <div data-testid="mac-workspace-transitional-shell" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MacDesktopApp production entrypoint', () => {
  it('boots the explicit transitional workspace shell through one owner boundary', () => {
    const { container } = render(<MacDesktopApp />);

    expect(container.querySelector('[data-testid="mac-workspace-transitional-shell"]')).toBeTruthy();
    expect(transitionalShell).toHaveBeenCalledTimes(1);
    expect(transitionalShell.mock.calls[0][0]).toMatchObject({
      hosts: [{ id: 'host-1', name: 'mac-studio' }],
      isLoaded: true,
      bridgeSettings: {
        targetHost: '127.0.0.1',
        targetPort: 3333,
      },
      addHost,
      updateHost,
      setBridgeSettings: setSettings,
    });
  });
});

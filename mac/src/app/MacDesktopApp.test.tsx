// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacDesktopApp } from './MacDesktopApp';

const addHost = vi.fn();
const updateHost = vi.fn();
const setSettings = vi.fn();
const macAppShell = vi.fn();

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

vi.mock('./MacAppShell', () => ({
  MacAppShell: (props: Record<string, unknown>) => {
    macAppShell(props);
    return <div data-testid="mac-app-shell" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MacDesktopApp production entrypoint', () => {
  it('boots MacAppShell through the shared workspace owner boundary', () => {
    window.history.replaceState(null, '', '/?windowId=window-from-query');
    const { container } = render(<MacDesktopApp />);

    expect(container.querySelector('[data-testid="mac-app-shell"]')).toBeTruthy();
    expect(macAppShell).toHaveBeenCalledTimes(1);
    expect(macAppShell.mock.calls[0][0]).toMatchObject({
      windowId: 'window-from-query',
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

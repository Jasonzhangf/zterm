// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../connection/types';
import { useBridgeSettingsStorage } from './use-bridge-settings-storage';

describe('useBridgeSettingsStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads persisted adaptive width mode before the first render', () => {
    localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify({
      targetHost: '100.66.1.82',
      targetPort: 3333,
      terminalWidthMode: 'adaptive-phone',
      terminalCacheLines: 1000,
      terminalThemeId: 'default',
      shortcutSmartSort: true,
      servers: [],
    }));

    const renderModes: string[] = [];

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      renderModes.push(settings.terminalWidthMode);
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('adaptive-phone');
    expect(renderModes[0]).toBe('adaptive-phone');
  });

  it('reads persisted mirror-fixed width mode before the first render', () => {
    localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify({
      targetHost: '100.66.1.82',
      targetPort: 3333,
      terminalWidthMode: 'mirror-fixed',
      terminalCacheLines: 1000,
      terminalThemeId: 'default',
      shortcutSmartSort: true,
      servers: [],
    }));

    const renderModes: string[] = [];

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      renderModes.push(settings.terminalWidthMode);
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('mirror-fixed');
    expect(renderModes[0]).toBe('mirror-fixed');
  });

  it('uses the explicit width-mode preference when old persisted settings have no terminalWidthMode', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 393,
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 393,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 393,
      },
    });
    localStorage.setItem(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE, 'mirror-fixed');
    localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify({
      targetHost: '100.66.1.82',
      targetPort: 3333,
      terminalCacheLines: 1000,
      terminalThemeId: 'default',
      shortcutSmartSort: true,
      servers: [],
    }));

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('mirror-fixed');
  });

  it('writes width-mode preference when settings change', () => {
    function Harness() {
      const { settings, setSettings } = useBridgeSettingsStorage();
      return (
        <button
          type="button"
          data-testid="set-fixed"
          onClick={() => setSettings({
            ...settings,
            terminalWidthMode: 'mirror-fixed',
          })}
        >
          {settings.terminalWidthMode}
        </button>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('set-fixed'));

    expect(localStorage.getItem(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE)).toBe('mirror-fixed');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS) || '{}').terminalWidthMode).toBe('mirror-fixed');
  });

  it('detects adaptive-phone as the first-launch default on narrow viewports', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 393,
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 393,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 393,
      },
    });

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('adaptive-phone');
  });

  it('uses visual viewport as first-launch width truth when Android WebView layout viewport is wide', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 980,
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 980,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 393,
      },
    });

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('adaptive-phone');
  });

  it('uses detected width mode for old persisted settings without terminalWidthMode', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 980,
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 980,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 393,
      },
    });
    localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify({
      targetHost: '100.66.1.82',
      targetPort: 3333,
      terminalCacheLines: 1000,
      terminalThemeId: 'default',
      shortcutSmartSort: true,
      servers: [],
    }));

    const renderModes: string[] = [];

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      renderModes.push(settings.terminalWidthMode);
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('adaptive-phone');
    expect(renderModes[0]).toBe('adaptive-phone');
  });

  it('keeps mirror-fixed as the first-launch default when the visual viewport is wide', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1180,
    });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1180,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 1180,
      },
    });

    function Harness() {
      const { settings } = useBridgeSettingsStorage();
      return <div data-testid="width-mode">{settings.terminalWidthMode}</div>;
    }

    render(<Harness />);

    expect(screen.getByTestId('width-mode').textContent).toBe('mirror-fixed');
  });
});

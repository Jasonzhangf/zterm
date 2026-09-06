// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../connection/types';
import { DEFAULT_BRIDGE_SETTINGS } from '../connection/bridge-settings';
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

  it('returns an explicit failure and keeps the committed state when bridge storage fails', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bridge storage failed');
    });
    let result: any;

    function Harness() {
      const { settings, setSettings } = useBridgeSettingsStorage();
      return (
        <>
          <div data-testid="cache-lines">{settings.terminalCacheLines}</div>
          <button
            type="button"
            onClick={() => {
              result = setSettings((current) => ({
                ...current,
                terminalCacheLines: current.terminalCacheLines + 1,
              }));
            }}
          >
            save
          </button>
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, persistedKeys: [] });
    expect(screen.getByTestId('cache-lines').textContent).toBe(String(DEFAULT_BRIDGE_SETTINGS.terminalCacheLines));
  });

  it('reports partial persistence when the width preference key fails', () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE) {
        throw new Error('width preference failed');
      }
      return originalSetItem.call(this, key, value);
    });
    let result: any;

    function Harness() {
      const { settings, setSettings } = useBridgeSettingsStorage();
      return (
        <button
          type="button"
          onClick={() => {
            result = setSettings({
              ...settings,
              terminalWidthMode: 'mirror-fixed',
            });
          }}
        >
          save
        </button>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(result).toMatchObject({
      ok: false,
      persistedKeys: [STORAGE_KEYS.BRIDGE_SETTINGS],
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS) || '{}').terminalWidthMode).toBe('mirror-fixed');
    expect(localStorage.getItem(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE)).toBeNull();
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('does not lose a partially persisted bridge update on the next retry', () => {
    let failWidthPreference = true;
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE && failWidthPreference) {
        failWidthPreference = false;
        throw new Error('width preference failed');
      }
      return originalSetItem.call(this, key, value);
    });
    let setSettingsRef: ReturnType<typeof useBridgeSettingsStorage>['setSettings'] | undefined;
    let firstResult: any;

    function Harness() {
      const { settings, setSettings } = useBridgeSettingsStorage();
      setSettingsRef = setSettings;
      return <div data-testid="settings">{JSON.stringify(settings)}</div>;
    }

    render(<Harness />);
    act(() => {
      firstResult = setSettingsRef?.((current) => ({
        ...current,
        terminalCacheLines: current.terminalCacheLines + 1,
        terminalWidthMode: 'mirror-fixed',
      }));
    });
    expect(firstResult).toMatchObject({
      ok: false,
      persistedKeys: [STORAGE_KEYS.BRIDGE_SETTINGS],
    });

    act(() => {
      setSettingsRef?.((current) => ({
        ...current,
        terminalThemeId: 'classic-dark',
      }));
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS) || '{}');
    expect(stored.terminalCacheLines).toBe(DEFAULT_BRIDGE_SETTINGS.terminalCacheLines + 1);
    expect(stored.terminalWidthMode).toBe('mirror-fixed');
    expect(stored.terminalThemeId).toBe('classic-dark');
  });

  it('resolves consecutive functional updates from the committed value', () => {
    let setSettingsRef: ReturnType<typeof useBridgeSettingsStorage>['setSettings'] | undefined;

    function Harness() {
      const { settings, setSettings } = useBridgeSettingsStorage();
      setSettingsRef = setSettings;
      return <div data-testid="cache-lines">{settings.terminalCacheLines}</div>;
    }

    render(<Harness />);
    act(() => {
      setSettingsRef?.((current) => ({ ...current, terminalCacheLines: current.terminalCacheLines + 1 }));
      setSettingsRef?.((current) => ({ ...current, terminalCacheLines: current.terminalCacheLines + 1 }));
    });

    expect(screen.getByTestId('cache-lines').textContent).toBe(String(DEFAULT_BRIDGE_SETTINGS.terminalCacheLines + 2));
  });

  it('keeps the setter identity stable across unrelated renders', () => {
    const setters: Array<ReturnType<typeof useBridgeSettingsStorage>['setSettings']> = [];

    function Harness() {
      const { setSettings } = useBridgeSettingsStorage();
      setters.push(setSettings);
      return <div />;
    }

    const view = render(<Harness />);
    view.rerender(<Harness />);

    expect(setters[0]).toBe(setters[1]);
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

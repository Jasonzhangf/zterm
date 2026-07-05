// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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

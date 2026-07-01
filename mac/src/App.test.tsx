// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const macDesktopApp = vi.fn();

vi.mock('./app/MacDesktopApp', () => ({
  MacDesktopApp: () => {
    macDesktopApp();
    return <div data-testid="mac-desktop-app" />;
  },
}));

vi.mock('./pages/ShellWorkspace', () => ({
  ShellWorkspace: () => <div data-testid="forbidden-shell-workspace-root" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('App renderer root', () => {
  it('renders MacDesktopApp as the only production entrypoint', () => {
    const { container } = render(<App />);

    expect(macDesktopApp).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="mac-desktop-app"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="forbidden-shell-workspace-root"]')).toBeNull();
  });
});

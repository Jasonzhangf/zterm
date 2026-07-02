import type { BrowserWindowConstructorOptions } from 'electron';

export function createMainWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#10131b',
    title: 'ZTerm',
  };
}

import { describe, expect, it } from 'vitest';
import { createMainWindowOptions } from '../../electron/window-options.js';

describe('Mac main window options', () => {
  it('starts hidden so the packaged app can maximize before first paint', () => {
    expect(createMainWindowOptions()).toMatchObject({
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: 'ZTerm',
    });
  });
});

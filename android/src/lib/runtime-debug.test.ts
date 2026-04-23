// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { isRuntimeDebugEnabled, RUNTIME_DEBUG_STORAGE_KEY, setRuntimeDebugEnabled } from './runtime-debug';

describe('runtime debug storage flag', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('toggles the runtime debug flag through storage', () => {
    expect(isRuntimeDebugEnabled()).toBe(false);

    setRuntimeDebugEnabled(true);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe('1');
    expect(isRuntimeDebugEnabled()).toBe(true);

    setRuntimeDebugEnabled(false);
    expect(window.localStorage.getItem(RUNTIME_DEBUG_STORAGE_KEY)).toBe(null);
    expect(isRuntimeDebugEnabled()).toBe(false);
  });
});

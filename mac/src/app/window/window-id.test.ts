import { describe, expect, it } from 'vitest';
import { MAC_BROWSER_DEV_WINDOW_ID, resolveMacRendererWindowId } from './window-id';

describe('Mac renderer windowId', () => {
  it('reads windowId from the renderer URL query', () => {
    expect(resolveMacRendererWindowId({ search: '?windowId=window-a' })).toBe('window-a');
  });

  it('uses an explicit browser-dev id when no Electron windowId exists', () => {
    expect(resolveMacRendererWindowId({ search: '' })).toBe(MAC_BROWSER_DEV_WINDOW_ID);
  });
});

/**
 * Submodule tests: terminal-session-drawer-helpers (client.session_drawer_preview).
 */
import { describe, expect, it } from 'vitest';
import {
  DRAWER_MAX_WIDTH,
  DRAWER_WIDTH,
  resolveSessionGroupSlotTone,
  shortenFolderLabel,
  UNSCOPED_HOST_GROUP_KEY,
  UNSCOPED_HOST_GROUP_LABEL,
} from './terminal-session-drawer-helpers';

describe('terminal-session-drawer-helpers', () => {
  it('keeps drawer layout tokens stable', () => {
    expect(DRAWER_WIDTH).toBe('48vw');
    expect(DRAWER_MAX_WIDTH).toBe('187px');
    expect(UNSCOPED_HOST_GROUP_KEY).toBe('__unscoped__');
    expect(UNSCOPED_HOST_GROUP_LABEL).toBe('未绑定主机');
  });

  it('resolves session group slot tones with axis labels', () => {
    expect(resolveSessionGroupSlotTone('top')?.label).toBe('上方');
    expect(resolveSessionGroupSlotTone('top', 'horizontal')?.label).toBe('左侧');
    expect(resolveSessionGroupSlotTone('center')?.label).toBe('中间');
    expect(resolveSessionGroupSlotTone(null)).toBeNull();
  });

  it('shortens folder labels to the final directory', () => {
    expect(shortenFolderLabel('/Users/jason/projects/zterm')).toBe('zterm');
    expect(shortenFolderLabel('~/code/api')).toBe('api');
    expect(shortenFolderLabel('/Users/jason/projects/zterm/')).toBe('zterm');
    expect(shortenFolderLabel('cwd 未知')).toBe('未知目录');
  });
});

import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from './types';

// Persistence compatibility gate: STORAGE_KEYS is the single truth for
// localStorage key strings across android/mac/win. Key VALUES are frozen —
// changing any string breaks installed users' persisted data.
const FROZEN_KEY_VALUES: Record<string, string> = {
  HOSTS: 'zterm:hosts',
  BRIDGE_SETTINGS: 'zterm:bridge-settings',
  TERMINAL_WIDTH_MODE_PREFERENCE: 'zterm:terminal-width-mode-preference',
  SESSION_HISTORY: 'zterm:session-history',
  SESSION_GROUPS: 'zterm:session-groups',
  OPEN_TABS: 'zterm:open-tabs',
  SAVED_TAB_LISTS: 'zterm:saved-tab-lists',
  QUICK_ACTIONS: 'zterm:quick-actions',
  SHORTCUT_ACTIONS: 'zterm:shortcut-actions',
  SESSION_DRAFTS: 'zterm:session-drafts',
  WEBDAV_CONFIG: 'zterm:webdav-config',
  COMMAND_HISTORY: 'zterm:command-history',
  ACTIVE_SESSION: 'zterm:active-session',
  ACTIVE_PAGE: 'zterm:active-page',
  TERMINAL_LAYOUT: 'zterm:terminal-layout',
  SHORTCUT_FREQUENCY: 'zterm:shortcut-frequency',
};

describe('STORAGE_KEYS single truth', () => {
  it('contains every frozen key with its exact persisted string value', () => {
    for (const [key, value] of Object.entries(FROZEN_KEY_VALUES)) {
      expect(STORAGE_KEYS[key as keyof typeof STORAGE_KEYS], key).toBe(value);
    }
  });

  it('has no keys outside the frozen set (additions must update this gate)', () => {
    expect(Object.keys(STORAGE_KEYS).sort()).toEqual(Object.keys(FROZEN_KEY_VALUES).sort());
  });
});

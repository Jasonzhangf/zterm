import { describe, expect, it } from 'vitest';
import { resolveTerminalLayoutProfile } from './terminal-layout-profile';

describe('terminal-layout-profile', () => {
  it('uses split-landscape profile when split panes are visible in landscape', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: true,
      landscape: true,
      topInsetPx: 0,
    });

    expect(profile.mode).toBe('split-landscape');
    expect(profile.header.tabMinHeight).toBe('22px');
    expect(profile.header.outerPadding).toBe('21px 4px 2px');
    expect(profile.stage.paneGap).toBe('6px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });

  it('keeps default split profile when not in landscape', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: true,
      landscape: false,
      topInsetPx: 0,
    });

    expect(profile.mode).toBe('split-default');
    expect(profile.header.tabMinHeight).toBe('28px');
    expect(profile.header.outerPadding).toBe('22px 4px 4px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });

  it('keeps single-pane phone profile untouched', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: false,
      topInsetPx: 24,
    });

    expect(profile.mode).toBe('single-pane');
    expect(profile.header.outerPadding).toBe('44px 6px 6px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildTmuxSessionPickerRows,
  filterActionableTmuxSelections,
  tabMatchesTarget,
} from './tmux-session-picker-rows';

describe('tmux session picker rows', () => {
  it('keeps daemon session order while merging matching open tabs into the same rows', () => {
    const rows = buildTmuxSessionPickerRows({
      availableSessions: ['alpha', 'beta', 'gamma'],
      openTabs: [
        {
          id: 'tab-beta',
          sessionName: 'beta',
          customName: 'Beta Tab',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
        },
      ],
      target: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
      },
      includeOpenTabs: true,
    });

    expect(rows.map((row) => row.sessionName)).toEqual(['alpha', 'beta', 'gamma']);
    expect(rows[1]).toMatchObject({
      sessionName: 'beta',
      displayName: 'Beta Tab',
      remotePresent: true,
      openTab: expect.objectContaining({ id: 'tab-beta' }),
    });
  });

  it('appends local open tabs that daemon refresh no longer reports without making them selectable', () => {
    const rows = buildTmuxSessionPickerRows({
      availableSessions: ['alpha', 'gamma'],
      openTabs: [
        {
          id: 'tab-beta',
          sessionName: 'beta',
          customName: 'Beta Tab',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
        },
      ],
      target: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
      },
      includeOpenTabs: true,
    });

    expect(rows.map((row) => row.displayName)).toEqual(['alpha', 'gamma', 'Beta Tab']);
    expect(rows[2]).toMatchObject({
      sessionName: 'beta',
      remotePresent: false,
      openTab: expect.objectContaining({ id: 'tab-beta' }),
    });
    expect(filterActionableTmuxSelections(['alpha', 'beta'], rows, true)).toEqual(['alpha']);
  });

  it('uses daemonHostId as the owner match before bridge endpoint', () => {
    expect(tabMatchesTarget(
      {
        id: 'tab-rcc',
        sessionName: 'rcc',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
      },
      {
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        daemonHostId: 'daemon-a',
      },
    )).toBe(true);
  });
});

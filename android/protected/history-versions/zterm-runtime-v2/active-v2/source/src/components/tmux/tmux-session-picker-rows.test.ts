import { describe, expect, it } from 'vitest';
import {
  buildTmuxSessionPickerRows,
  findOpenTabsMissingFromRemote,
  filterActionableTmuxSelections,
  shouldAutoRefreshTmuxPicker,
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
        id: 'tab-demo',
        sessionName: 'demo',
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

  it('finds only target-owned open tabs missing from the refreshed daemon list', () => {
    const missing = findOpenTabsMissingFromRemote({
      availableSessions: ['alpha', 'gamma'],
      openTabs: [
        {
          id: 'tab-alpha',
          sessionName: 'alpha',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
        },
        {
          id: 'tab-beta',
          sessionName: 'beta',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
        },
        {
          id: 'tab-other',
          sessionName: 'beta',
          bridgeHost: '100.127.23.99',
          bridgePort: 3333,
          daemonHostId: 'daemon-b',
        },
      ],
      target: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
      },
    });

    expect(missing.map((tab) => tab.id)).toEqual(['tab-beta']);
  });

  it('auto-refreshes only when the picker has a concrete authenticated target', () => {
    expect(shouldAutoRefreshTmuxPicker({
      open: true,
      relayDirectoryTarget: false,
      target: { bridgeHost: '100.66.1.82', authToken: 'token-a' },
    })).toBe(true);

    expect(shouldAutoRefreshTmuxPicker({
      open: true,
      relayDirectoryTarget: false,
      target: { bridgeHost: '100.66.1.82', authToken: '' },
    })).toBe(false);

    expect(shouldAutoRefreshTmuxPicker({
      open: true,
      relayDirectoryTarget: false,
      target: { bridgeHost: '100.66.1.82', authToken: 'token-a', daemonHostId: '' },
    })).toBe(true);

    expect(shouldAutoRefreshTmuxPicker({
      open: true,
      relayDirectoryTarget: true,
      target: { bridgeHost: '100.66.1.82', authToken: 'token-a', daemonHostId: 'daemon-a' },
    })).toBe(true);

    expect(shouldAutoRefreshTmuxPicker({
      open: true,
      relayDirectoryTarget: true,
      target: {
        bridgeHost: 'daemon-a',
        authToken: '',
        daemonHostId: 'daemon-a',
        relayTmuxSessions: [{ name: 'main', updatedAt: '2026-06-28T00:00:00.000Z' }],
      },
    })).toBe(true);
  });
});

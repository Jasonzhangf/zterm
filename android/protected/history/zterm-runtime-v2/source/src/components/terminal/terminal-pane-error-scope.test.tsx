import { describe, expect, it } from 'vitest';

/**
 * Red test: network banner must be scoped to active pane session only.
 * Forward gate: when splitVisible=true, global TerminalNetworkBanner
 *   should NOT fire for inactive pane errors.
 * Inverse gate: when active pane has error, banner MUST fire.
 * Scope gate: toast must carry paneId so only the calling pane shows it.
 */

describe('TerminalNetworkBanner pane scope', () => {
  it.skip('RED: global banner should not fire for inactive pane errors', () => {
    // TODO: implement when pane-group error state is plumbed through
    expect(true).toBe(false);
  });

  it.skip('RED: global banner MUST fire for active pane session error', () => {
    // TODO: implement when uiSession is correctly scoped to active pane
    expect(true).toBe(false);
  });
});

describe('Toast pane scope', () => {
  it.skip('RED: showToast must be scoped to calling paneId', () => {
    // TODO: implement when toast state includes paneId
    expect(true).toBe(false);
  });
});

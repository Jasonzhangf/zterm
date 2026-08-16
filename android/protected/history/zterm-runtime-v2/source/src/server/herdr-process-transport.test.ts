import { describe, expect, it } from 'vitest';
import {
  HERDR_SCROLL_METRICS_THROTTLE_MS,
  parseHerdrPaneGeometry,
  parseHerdrScrollMetrics,
  selectHerdrTerminalPane,
  shouldPublishHerdrScrollMetrics,
  shouldRefreshHerdrScrollMetrics,
} from './herdr-process-transport';

describe('Herdr process transport scroll metadata', () => {
  it('parses pane get scroll metrics without importing workspace layout truth', () => {
    expect(parseHerdrScrollMetrics(JSON.stringify({
      result: {
        pane: {
          scroll: {
            max_offset_from_bottom: 61,
            offset_from_bottom: 1,
            viewport_rows: 30,
          },
        },
      },
    }))).toEqual({
      maxOffsetFromBottom: 61,
      offsetFromBottom: 1,
      viewportRows: 30,
    });
  });

  it('rejects missing or invalid scroll metadata explicitly', () => {
    expect(() => parseHerdrScrollMetrics(JSON.stringify({ result: {} }))).toThrow(
      'did not contain valid scroll metrics',
    );
    expect(() => parseHerdrScrollMetrics(JSON.stringify({
      result: { scroll: { max_offset_from_bottom: 1, offset_from_bottom: 2, viewport_rows: 24 } },
    }))).toThrow('did not contain valid scroll metrics');
  });

  it('throttles pane get scroll metric reads without dropping the authoritative frame', () => {
    expect(HERDR_SCROLL_METRICS_THROTTLE_MS).toBe(100);
    const metrics = { maxOffsetFromBottom: 10, offsetFromBottom: 0, viewportRows: 24 };

    expect(shouldRefreshHerdrScrollMetrics(1000, 999, 24, metrics)).toBe(false);
    expect(shouldRefreshHerdrScrollMetrics(1100, 999, 24, metrics)).toBe(true);
    expect(shouldRefreshHerdrScrollMetrics(1000, 999, 24, null)).toBe(true);
    expect(shouldRefreshHerdrScrollMetrics(1000, 999, 25, metrics)).toBe(true);
  });

  it('publishes scroll metrics only from a fresh pane get read', () => {
    const metrics = { maxOffsetFromBottom: 10, offsetFromBottom: 0, viewportRows: 24 };

    expect(shouldPublishHerdrScrollMetrics(1000, 1000, 24, metrics)).toBe(true);
    expect(shouldPublishHerdrScrollMetrics(1010, 1000, 24, metrics)).toBe(false);
    expect(shouldPublishHerdrScrollMetrics(1100, 1000, 24, metrics)).toBe(false);
    expect(shouldPublishHerdrScrollMetrics(1000, 1000, 25, metrics)).toBe(false);
    expect(shouldPublishHerdrScrollMetrics(1000, 1000, 24, null)).toBe(false);
  });

  it('reads pane geometry from the official layout rectangle', () => {
    expect(parseHerdrPaneGeometry(JSON.stringify({
      result: {
        snapshot: {
          layouts: [{
            panes: [{
              pane_id: 'workspace:p1',
              rect: { x: 26, y: 1, width: 242, height: 113 },
            }],
          }],
        },
      },
    }), 'workspace:p1', 'named-session')).toEqual({
      cols: 242,
      rows: 113,
    });
  });

  it('does not use pane scroll viewport rows as layout geometry', () => {
    expect(parseHerdrPaneGeometry(JSON.stringify({
      result: {
        snapshot: {
          panes: [{
            pane_id: 'workspace:p1',
            scroll: { viewport_rows: 24 },
          }],
          layouts: [{
            panes: [{
              pane_id: 'workspace:p1',
              rect: { x: 0, y: 0, width: 160, height: 90 },
            }],
          }],
        },
      },
    }), 'workspace:p1', 'named-session')).toEqual({
      cols: 160,
      rows: 90,
    });
  });

  it('rejects missing, malformed, or ambiguous layout geometry explicitly', () => {
    expect(() => parseHerdrPaneGeometry(JSON.stringify({ result: {} }), 'p1', 'named-session'))
      .toThrow('one unambiguous layout rect');
    expect(() => parseHerdrPaneGeometry(JSON.stringify({
      result: { snapshot: { layouts: [{ panes: [{ pane_id: 'p1', rect: { width: 0, height: 80 } }] }] } },
    }), 'p1', 'named-session')).toThrow('invalid layout rect');
    expect(() => parseHerdrPaneGeometry(JSON.stringify({
      result: {
        snapshot: {
          layouts: [
            { panes: [{ pane_id: 'p1', rect: { width: 80, height: 80 } }] },
            { panes: [{ pane_id: 'p1', rect: { width: 120, height: 90 } }] },
          ],
        },
      },
    }), 'p1', 'named-session')).toThrow('one unambiguous layout rect');
  });

  it('rejects ambiguous restart discovery instead of selecting panes[0]', () => {
    expect(() => selectHerdrTerminalPane([
      { terminal_id: 'terminal-a', pane_id: 'workspace:0' },
      { terminal_id: 'terminal-b', pane_id: 'workspace:1' },
    ], {}, 'named-session')).toThrow('unambiguous terminal surface');
  });

  it('selects only the persisted terminal and pane identity when provided', () => {
    expect(selectHerdrTerminalPane([
      { terminal_id: 'terminal-a', pane_id: 'workspace:0' },
      { terminal_id: 'terminal-b', pane_id: 'workspace:1' },
    ], { terminalId: 'terminal-b', paneId: 'workspace:1' }, 'named-session')).toEqual({
      terminalId: 'terminal-b',
      paneId: 'workspace:1',
    });
  });
});

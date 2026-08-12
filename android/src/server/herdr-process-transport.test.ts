import { describe, expect, it } from 'vitest';
import { parseHerdrScrollMetrics, selectHerdrTerminalPane } from './herdr-process-transport';

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

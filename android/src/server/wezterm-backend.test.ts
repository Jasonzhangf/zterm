import { describe, expect, it } from 'vitest';
import {
  buildWezTermSendTextArgs,
  buildWezTermMirrorSnapshot,
  parseWezTermPaneList,
  requireWezTermInputContract,
} from './wezterm-backend';

describe('wezterm backend contract', () => {
  it('parses wezterm cli list into explicit pane records', () => {
    const panes = parseWezTermPaneList(`
WINID TABID PANEID WORKSPACE    SIZE  TITLE          CWD
    2     2      2 zterm-live   80x24 powershell.exe file:///C:/Users/huawei/
    4     4      4 zterm-output 120x30 cmd.exe        file:///D:/work/project/
`);

    expect(panes).toEqual([
      {
        winId: 2,
        tabId: 2,
        paneId: 2,
        workspace: 'zterm-live',
        cols: 80,
        rows: 24,
        title: 'powershell.exe',
        cwd: 'file:///C:/Users/huawei/',
      },
      {
        winId: 4,
        tabId: 4,
        paneId: 4,
        workspace: 'zterm-output',
        cols: 120,
        rows: 30,
        title: 'cmd.exe',
        cwd: 'file:///D:/work/project/',
      },
    ]);
  });

  it('rejects malformed pane list rows instead of guessing a backend truth', () => {
    expect(() => parseWezTermPaneList(`
WINID TABID PANEID WORKSPACE SIZE TITLE CWD
oops
`)).toThrow('invalid wezterm pane row');
  });

  it('materializes get-text output into a daemon-owned absolute mirror snapshot', async () => {
    const panes = parseWezTermPaneList(`
WINID TABID PANEID WORKSPACE SIZE  TITLE   CWD
    6     6      6 demo      80x24 cmd.exe file:///C:/Users/huawei/
`);
    const snapshot = await buildWezTermMirrorSnapshot({
      pane: panes[0]!,
      revision: 3,
      previousStartIndex: 40,
      previousLineCount: 20,
      getTextEscapes: '\x1b[91mZTERM_RED\n\x1b[30m\x1b[102mZTERM_GREEN_BG\n\x1b[39m\x1b[49m',
    });

    expect(snapshot.revision).toBe(3);
    expect(snapshot.bufferStartIndex).toBe(40);
    expect(snapshot.bufferLines).toHaveLength(2);
    expect(snapshot.bufferLines[0]?.map((cell) => String.fromCodePoint(cell.char)).join('')).toBe('ZTERM_RED');
    expect(snapshot.bufferLines[0]?.[0]).toMatchObject({ fg: 9, bg: 256 });
    expect(snapshot.bufferLines[1]?.map((cell) => String.fromCodePoint(cell.char)).join('')).toBe('ZTERM_GREEN_BG');
    expect(snapshot.bufferLines[1]?.[0]).toMatchObject({ fg: 0, bg: 10 });
    expect(snapshot.cols).toBe(80);
    expect(snapshot.rows).toBe(24);
  });

  it('advances the absolute start only when the bounded capture window drops old lines', async () => {
    const pane = parseWezTermPaneList(`
WINID TABID PANEID WORKSPACE SIZE TITLE CWD
    5     5      5 demo      80x24 cmd.exe file:///C:/Users/huawei/
`)[0]!;

    const snapshot = await buildWezTermMirrorSnapshot({
      pane,
      revision: 4,
      previousStartIndex: 10,
      previousLineCount: 80,
      getTextEscapes: Array.from({ length: 100 }, (_item, index) => `ROW_${index + 1}`).join('\n'),
      maxMirrorLines: 60,
    });

    expect(snapshot.bufferStartIndex).toBe(50);
    expect(snapshot.bufferLines).toHaveLength(60);
    expect(snapshot.bufferLines[0]?.map((cell) => String.fromCodePoint(cell.char)).join('')).toBe('ROW_41');
  });

  it('only permits the verified no-paste stdin input path', () => {
    expect(buildWezTermSendTextArgs(17)).toEqual([
      'cli',
      '--prefer-mux',
      'send-text',
      '--pane-id',
      '17',
      '--no-paste',
    ]);
    expect(() => buildWezTermSendTextArgs(0)).toThrow('invalid wezterm paneId for input');

    expect(requireWezTermInputContract()).toEqual({
      verified: true,
      mode: 'send-text-no-paste-stdin',
      args: ['cli', '--prefer-mux', 'send-text', '--pane-id', '<paneId>', '--no-paste'],
      limitations: [
        'write raw bytes to stdin; do not pass input through shell arguments',
        'verified for Enter, Backspace/DEL, arrow escape sequences, raw-mode TUI bytes, and Codex TUI text entry',
        'Ctrl+C is delivered as ETX to raw-mode programs, but does not interrupt cmd.exe ping as a Windows console control event',
      ],
    });
  });
});

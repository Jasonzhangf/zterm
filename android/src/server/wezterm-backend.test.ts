import { describe, expect, it } from 'vitest';
import {
  buildWezTermPersistentShellCommand,
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

  it('parses wezterm cli list json with cursor metadata', () => {
    const panes = parseWezTermPaneList(JSON.stringify([
      {
        window_id: 7,
        tab_id: 8,
        pane_id: 9,
        workspace: 'zterm-demo',
        size: { rows: 24, cols: 80 },
        title: 'cmd.exe',
        cwd: 'file:///C:/Users/huawei/',
        cursor_x: 12,
        cursor_y: 3,
        cursor_visibility: 'Visible',
        top_row: 0,
      },
    ]));

    expect(panes).toEqual([
      {
        winId: 7,
        tabId: 8,
        paneId: 9,
        workspace: 'zterm-demo',
        cols: 80,
        rows: 24,
        title: 'cmd.exe',
        cwd: 'file:///C:/Users/huawei/',
        cursorX: 12,
        cursorY: 3,
        cursorVisibility: 'Visible',
        topRow: 0,
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
    const panes = parseWezTermPaneList(JSON.stringify([
      {
        window_id: 6,
        tab_id: 6,
        pane_id: 6,
        workspace: 'demo',
        size: { rows: 24, cols: 80 },
        title: 'cmd.exe',
        cwd: 'file:///C:/Users/huawei/',
        cursor_x: 16,
        cursor_y: 3,
        cursor_visibility: 'Visible',
        top_row: 0,
      },
    ]));
    const snapshot = await buildWezTermMirrorSnapshot({
      pane: panes[0]!,
      revision: 3,
      previousStartIndex: 40,
      previousLineCount: 20,
      getTextEscapes: Array.from({ length: 24 }, (_item, index) => {
        if (index === 0) {
          return '\x1b[91mZTERM_RED';
        }
        if (index === 3) {
          return '\x1b[91mZTERM_CURSOR_ROW';
        }
        return `ROW_${index + 1}`;
      }).join('\n'),
    });

    expect(snapshot.revision).toBe(3);
    expect(snapshot.bufferStartIndex).toBe(40);
    expect(snapshot.bufferLines).toHaveLength(24);
    expect(snapshot.bufferLines[0]?.map((cell) => String.fromCodePoint(cell.char)).join('')).toBe('ZTERM_RED');
    expect(snapshot.bufferLines[3]?.map((cell) => String.fromCodePoint(cell.char)).join('')).toBe('ZTERM_CURSOR_ROW');
    expect(snapshot.bufferLines[3]?.[0]).toMatchObject({ fg: 9, bg: 256 });
    expect(snapshot.cols).toBe(80);
    expect(snapshot.rows).toBe(24);
    expect(snapshot.cursor).toEqual({
      rowIndex: 43,
      col: 16,
      visible: true,
    });
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

  it('requires Windows sessions to be rooted in a persistent shell', () => {
    expect(buildWezTermPersistentShellCommand()).toEqual(['cmd.exe', '/k']);
    expect(buildWezTermPersistentShellCommand(['cmd.exe', '/k'])).toEqual(['cmd.exe', '/k']);
    expect(buildWezTermPersistentShellCommand(['powershell.exe', '-NoLogo'])).toEqual(['powershell.exe', '-NoLogo']);
    expect(() => buildWezTermPersistentShellCommand(['cmd.exe', '/c', 'codex'])).toThrow(
      'wezterm sessions must use a persistent shell',
    );
  });
});

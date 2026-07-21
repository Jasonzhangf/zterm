import { describe, expect, it } from 'vitest';
import {
  buildTerminalShortcutSequence,
  buildTerminalShortcutTokensFromSequence,
} from './terminal-shortcut-composer';

describe('terminal-shortcut-composer', () => {
  it('encodes shift modified arrow shortcuts with canonical preview order', () => {
    const built = buildTerminalShortcutSequence([
      { label: 'Shift', sequence: '__SHIFT__', kind: 'modifier' },
      { label: '←', sequence: '\x1b[D', kind: 'key' },
    ]);

    expect(built).toEqual({
      sequence: '\x1b[1;2D',
      preview: 'Shift + ←',
      error: '',
    });
  });

  it('applies shift only to the first key after the modifier', () => {
    const built = buildTerminalShortcutSequence([
      { label: 'Shift', sequence: '__SHIFT__', kind: 'modifier' },
      { label: '←', sequence: '\x1b[D', kind: 'key' },
      { label: 'a', sequence: 'a', kind: 'text' },
    ]);

    expect(built).toEqual({
      sequence: '\x1b[1;2Da',
      preview: 'Shift + ← + a',
      error: '',
    });
  });

  it('decodes shift modified arrow sequences back into modifier plus arrow tokens', () => {
    expect(buildTerminalShortcutTokensFromSequence('', '\x1b[1;2A')).toEqual([
      { label: 'Shift', sequence: '__SHIFT__', kind: 'modifier' },
      { label: '↑', sequence: '\x1b[A', kind: 'key' },
    ]);
  });
});

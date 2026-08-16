import { describe, expect, it } from 'vitest';
import { assertSupportedTerminalSourceKind } from './terminal-source-adapter';

describe('terminal source adapter contract', () => {
  it('accepts every supported terminal source kind', () => {
    expect(assertSupportedTerminalSourceKind('tmux')).toBe('tmux');
    expect(assertSupportedTerminalSourceKind('herdr')).toBe('herdr');
    expect(assertSupportedTerminalSourceKind('wezterm')).toBe('wezterm');
  });

  it('normalizes case and surrounding whitespace without changing semantics', () => {
    expect(assertSupportedTerminalSourceKind('  TMUX ')).toBe('tmux');
    expect(assertSupportedTerminalSourceKind('Herdr')).toBe('herdr');
    expect(assertSupportedTerminalSourceKind('WEZTERM')).toBe('wezterm');
  });

  it('rejects unsupported kinds explicitly', () => {
    expect(() => assertSupportedTerminalSourceKind('unknown')).toThrow(
      'unsupported terminal source kind: unknown',
    );
  });

  it('rejects empty source kinds explicitly', () => {
    expect(() => assertSupportedTerminalSourceKind(undefined)).toThrow(
      'unsupported terminal source kind: <empty>',
    );
    expect(() => assertSupportedTerminalSourceKind('  ')).toThrow(
      'unsupported terminal source kind: <empty>',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertSupportedTerminalSourceKind,
  buildRexSessionStableId,
  parseTerminalSessionStableId,
} from './terminal-source-adapter';

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

  it('round-trips an exact Rex block identity without losing backend qualification', () => {
    const stableId = buildRexSessionStableId({
      instanceId: '80866d32-7d2f-4dfa-a38f-bd531db0e5dc',
      sessionId: 'session:01a1baae-5766-7724-92d9-59a846daaf02',
      blockId: 'block:01a1c5ed-34aa-7e5f-9298-708a046ad459',
    });

    expect(stableId.startsWith('rex:v1:')).toBe(true);
    expect(parseTerminalSessionStableId(stableId)).toEqual({
      backend: 'rex',
      instanceId: '80866d32-7d2f-4dfa-a38f-bd531db0e5dc',
      sessionId: 'session:01a1baae-5766-7724-92d9-59a846daaf02',
      blockId: 'block:01a1c5ed-34aa-7e5f-9298-708a046ad459',
    });
  });

  it('rejects malformed and cross-backend Rex identities', () => {
    expect(parseTerminalSessionStableId('rex:v1:%7B%22backend%22%3A%22rex%22%7D')).toBeNull();
    const forgedTmuxId = buildRexSessionStableId({
      instanceId: 'rex-server-a',
      sessionId: 'session:a',
      blockId: 'block:a',
    }).replace('rex:v1:', 'tmux:v1:');
    expect(parseTerminalSessionStableId(forgedTmuxId)).toBeNull();
    expect(() => buildRexSessionStableId({
      instanceId: 'rex-server-a',
      sessionId: 'session:a',
      blockId: ' ',
    })).toThrow('Rex session identity requires instanceId, sessionId, and blockId');
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

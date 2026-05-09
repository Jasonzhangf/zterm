import { describe, it, expect } from 'vitest';
import {
  createForegroundResumeState,
  markHidden,
  markVisible,
  shouldResumeForeground,
} from './foreground-resume';

describe('foreground-resume pure utilities', () => {
  it('creates initial state with wasHidden=false', () => {
    const state = createForegroundResumeState();
    expect(state.wasHidden).toBe(false);
    expect(state.lastResumeAt).toBe(0);
  });

  it('markHidden sets wasHidden=true immutably', () => {
    const original = createForegroundResumeState();
    const hidden = markHidden(original);
    expect(hidden.wasHidden).toBe(true);
    expect(original.wasHidden).toBe(false);
  });

  it('markVisible sets wasHidden=false immutably', () => {
    const hidden = markHidden(createForegroundResumeState());
    const visible = markVisible(hidden);
    expect(visible.wasHidden).toBe(false);
    expect(hidden.wasHidden).toBe(true);
  });

  it('shouldResume=true when all conditions met', () => {
    const d = shouldResumeForeground(1000, 100, 800, true, true, true);
    expect(d.shouldResume).toBe(true);
    expect(d.skipReason).toBeUndefined();
  });

  it('skip when no sessions', () => {
    const d = shouldResumeForeground(1000, 100, 800, true, false, true);
    expect(d.shouldResume).toBe(false);
    expect(d.skipReason).toBe('no-sessions');
  });

  it('skip when debounced', () => {
    const d = shouldResumeForeground(500, 400, 800, true, true, true);
    expect(d.shouldResume).toBe(false);
    expect(d.skipReason).toBe('debounced');
  });

  it('skip when no active session', () => {
    const d = shouldResumeForeground(1000, 100, 800, true, true, false);
    expect(d.shouldResume).toBe(false);
    expect(d.skipReason).toBe('no-active-session');
  });

  it('skip when not hidden', () => {
    const d = shouldResumeForeground(1000, 100, 800, false, true, true);
    expect(d.shouldResume).toBe(false);
    expect(d.skipReason).toBe('not-hidden');
  });
});

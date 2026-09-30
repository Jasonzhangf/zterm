import { describe, expect, it } from 'vitest';
import {
  resolveCyclePreviewSession,
  resolvePinchVerticalCwdStep,
} from './junction-preview-navigation';

const cells = [
  { col: -1, row: 0, target: { sessionId: 's1' } },
  { col: 0, row: 0, target: { sessionId: 's2' } },
  { col: 1, row: 0, target: { sessionId: 's3' } },
];

const sessions = [
  { id: 's1', cwd: '/a' },
  { id: 's2', cwd: '/a' },
  { id: 's3', cwd: '/b' },
];

describe('junction preview navigation', () => {
  it('cycles same cwd sessions horizontally without crossing cwd', () => {
    expect(resolveCyclePreviewSession({
      focus: { col: 0, row: 0 },
      cells,
      sessions,
      direction: 'next',
    })).toEqual({
      action: 'focus',
      coordinate: { col: -1, row: 0 },
      sessionId: 's1',
    });

    expect(resolveCyclePreviewSession({
      focus: { col: -1, row: 0 },
      cells,
      sessions,
      direction: 'previous',
    })).toEqual({
      action: 'focus',
      coordinate: { col: 0, row: 0 },
      sessionId: 's2',
    });
  });

  it('does not cycle when the focused session has no cwd sibling', () => {
    expect(resolveCyclePreviewSession({
      focus: { col: 1, row: 0 },
      cells,
      sessions,
      direction: 'next',
    })).toEqual({ action: 'none' });
  });

  it('steps cwd by replacing the current focus coordinate', () => {
    expect(resolvePinchVerticalCwdStep({
      focus: { col: 0, row: 0 },
      cells,
      sessions,
      direction: 'next',
    })).toEqual({
      action: 'replace',
      coordinate: { col: 0, row: 0 },
      sessionId: 's3',
    });

    expect(resolvePinchVerticalCwdStep({
      focus: { col: 0, row: 0 },
      cells,
      sessions,
      direction: 'previous',
    })).toEqual({
      action: 'replace',
      coordinate: { col: 0, row: 0 },
      sessionId: 's3',
    });
  });
});

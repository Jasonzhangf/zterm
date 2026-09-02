/**
 * Submodule tests: terminal-quickbar-logic (client.input_runtime).
 */
import { describe, expect, it } from 'vitest';
import {
  buildVisibleShortcutRowActions,
  clampFloatingBubblePosition,
  inferShortcutRow,
  moveShortcutActionWithinRow,
  normalizeSequenceForImmediateSend,
  resolveOverlayViewportMetrics,
  resolveGoalPastePlan,
  sortShortcutActions,
  validateShortcutTokensForRow,
  type DraftShortcutAction,
} from './terminal-quickbar-logic';

function action(id: string, row: 'top-scroll' | 'bottom-scroll', order: number, sequence = 'x'): DraftShortcutAction {
  return { id, label: id, sequence, row, order } as DraftShortcutAction;
}

describe('terminal-quickbar-logic', () => {
  it('sorts shortcut actions by row order then manual order', () => {
    const sorted = sortShortcutActions([action('b', 'bottom-scroll', 0), action('a', 'top-scroll', 1), action('c', 'top-scroll', 0)]);
    expect(sorted.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves an action within its row without disturbing other rows', () => {
    const before = [action('a', 'top-scroll', 0), action('b', 'top-scroll', 1), action('c', 'bottom-scroll', 0)];
    const after = moveShortcutActionWithinRow(before, 'top-scroll', 1, 0);
    expect(after.map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('infers the row for a single key as top-scroll and a chord as bottom-scroll', () => {
    expect(inferShortcutRow('Esc', '\x1b')).toBe('top-scroll');
    expect(validateShortcutTokensForRow('top-scroll', [{ label: 'Ctrl', sequence: '__CTRL__', kind: 'modifier' }], { error: '' } as never)).toBe('第二行只支持单按键，不支持 Ctrl / Shift 等组合。');
  });

  it('normalizes sequences for immediate send (trailing CR)', () => {
    expect(normalizeSequenceForImmediateSend('ls')).toBe('ls\r');
    expect(normalizeSequenceForImmediateSend('a\nb')).toBe('a\rb\r');
    expect(normalizeSequenceForImmediateSend('  ')).toBe('');
  });

  it('preserves the complete multiline goal payload after the command separator', () => {
    const body = '\n  需求：保持首行缩进\n```json\n{"输入":"值"}\n```\n末行';
    const plan = resolveGoalPastePlan(`/goal ${body}`);
    expect(plan).toEqual({
      typedPrefix: '/goal ',
      pastedText: body,
      submit: '\r',
    });
  });

  it('removes only one inline separator and keeps additional spacing', () => {
    expect(resolveGoalPastePlan('/goal    保留缩进')?.pastedText).toBe('   保留缩进');
  });

  it('builds visible row actions with sequence dedupe', () => {
    const visible = buildVisibleShortcutRowActions('top-scroll', [action('a', 'top-scroll', 0, 'x'), action('b', 'top-scroll', 1, 'x'), action('c', 'top-scroll', 2, 'y')]);
    expect(visible.map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('clamps bubble position within the viewport', () => {
    const pos = clampFloatingBubblePosition(0, 0, 48, 48, 0);
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
  });

  it('resolves overlay viewport metrics without a DOM', () => {
    const metrics = resolveOverlayViewportMetrics(0);
    expect(metrics.bottomInsetPx).toBe(0);
    expect(metrics.sheetHeightPx).toBeNull();
  });
});

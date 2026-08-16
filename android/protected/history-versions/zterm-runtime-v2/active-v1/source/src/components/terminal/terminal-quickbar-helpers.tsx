/**
 * TerminalQuickBar UI 辅助（client.input_runtime）：仅保留 JSX 渲染 helper 与 UI 布局常量。
 * 纯逻辑 / 存储已下沉：../../lib/terminal-quickbar-logic.ts、../../lib/terminal-quickbar-storage.ts。
 */
import {
  isSpaceShortcutLabel,
  resolveShortcutTokenDisplayLabel,
  resolveShortcutVisualLabel,
  shouldRenderShortcutKeycap,
} from '../../lib/terminal-quickbar-logic';
export * from '../../lib/terminal-quickbar-logic';
export * from '../../lib/terminal-quickbar-storage';

export const QUICK_BAR_SIDE_PADDING = 6;

export const QUICK_BAR_ROW_GAP = 4;

export const QUICK_BAR_FIXED_COLUMNS = 3;

export const FIXED_BUTTON_MIN_WIDTH = 48;

export const FIXED_CLUSTER_PADDING_X = 3;

export const REPEATABLE_ACTION_LONG_PRESS_MS = 420;

export const REPEATABLE_ACTION_REPEAT_MS = 90;

export type FloatingPanelTab = 'quick-actions' | 'clipboard';

export type ShortcutEditorTab = 'keyboard' | 'common';

export type ShortcutEditorMode = 'list' | 'form';

export function renderShortcutVisualNode(label: string, variant: 'button' | 'list' | 'token' = 'button') {
  if (!shouldRenderShortcutKeycap(label)) {
    return resolveShortcutVisualLabel(label);
  }

  const metrics = variant === 'list'
    ? { minWidth: '44px', height: '30px', padding: '0 12px', borderWidth: '2px', fontSize: '18px', fontWeight: 800, radius: '10px' }
    : variant === 'token'
      ? { minWidth: '34px', height: '24px', padding: '0 8px', borderWidth: '1.8px', fontSize: '13px', fontWeight: 800, radius: '8px' }
      : { minWidth: '30px', height: '22px', padding: '0 8px', borderWidth: '1.8px', fontSize: '13px', fontWeight: 800, radius: '8px' };

  if (isSpaceShortcutLabel(label)) {
    const spaceMetrics = variant === 'list'
      ? { width: '52px', height: '20px' }
      : variant === 'token'
        ? { width: '40px', height: '18px' }
        : { width: '38px', height: '16px' };

    return (
      <span data-shortcut-keycap="space" data-shortcut-space-visual="true" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: spaceMetrics.width, height: spaceMetrics.height, borderRadius: variant === 'list' ? '10px' : '8px', border: `${metrics.borderWidth} solid currentColor`, boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)' }}>
        <span style={{ display: 'block', width: variant === 'list' ? '28px' : variant === 'token' ? '22px' : '20px', height: variant === 'list' ? '3px' : '2.5px', borderRadius: '999px', backgroundColor: 'currentColor', opacity: 0.92 }} />
      </span>
    );
  }

  return (
    <span data-shortcut-keycap={resolveShortcutTokenDisplayLabel(label)} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: metrics.minWidth, height: metrics.height, padding: metrics.padding, borderRadius: metrics.radius, border: `${metrics.borderWidth} solid currentColor`, boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)', fontSize: metrics.fontSize, fontWeight: metrics.fontWeight, letterSpacing: resolveShortcutVisualLabel(label).length > 2 ? '-0.01em' : 0, lineHeight: 1, whiteSpace: 'nowrap' }}>
      {resolveShortcutVisualLabel(label)}
    </span>
  );
}

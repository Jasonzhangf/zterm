/**
 * TerminalSessionDrawer 常量/色调 helper 子模块（client.session_drawer_preview）。
 */
import type { TerminalSessionGroupSlotName } from '../../lib/session-group-viewport';
import type { TerminalSessionGroupLayoutAxis } from '../../lib/terminal-layout-profile';

export const DRAWER_WIDTH = '48vw';
export const DRAWER_MAX_WIDTH = '187px';
export const SWIPE_CLOSE_THRESHOLD_PX = 48;
export const SWIPE_CLOSE_VERTICAL_TOLERANCE_PX = 44;
export const UNSCOPED_HOST_GROUP_KEY = '__unscoped__';
export const UNSCOPED_HOST_GROUP_LABEL = '未绑定主机';

export function resolveSessionGroupSlotTone(
  slot: TerminalSessionGroupSlotName | null | undefined,
  axis: TerminalSessionGroupLayoutAxis = 'vertical',
) {
  const beforeLabel = axis === 'horizontal' ? '左侧' : '上方';
  const afterLabel = axis === 'horizontal' ? '右侧' : '下方';
  switch (slot) {
    case 'top':
      return {
        label: beforeLabel,
        color: 'var(--zterm-settings-accent)',
        background: 'var(--zterm-skeu-material-active)',
        border: 'var(--zterm-settings-accent-border)',
      };
    case 'center':
      return {
        label: '中间',
        color: 'var(--zterm-settings-accent)',
        background: 'var(--zterm-skeu-material-active)',
        border: 'var(--zterm-settings-accent-border)',
      };
    case 'bottom':
      return {
        label: afterLabel,
        color: 'var(--zterm-settings-text)',
        background: 'var(--zterm-settings-field)',
        border: 'var(--zterm-settings-border)',
      };
    default:
      return null;
  }
}

export function shortenFolderLabel(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === 'cwd 未知') {
    return trimmed === 'cwd 未知' ? '未知目录' : trimmed;
  }
  const normalized = trimmed.replace(/\/+$/, '');
  const lastSegment = normalized.split('/').filter(Boolean).pop();
  if (!lastSegment) {
    return normalized || '未知目录';
  }
  return lastSegment;
}

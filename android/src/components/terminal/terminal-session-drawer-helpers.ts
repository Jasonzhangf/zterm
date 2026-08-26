/**
 * TerminalSessionDrawer 常量/色调 helper 子模块（client.session_drawer_preview）。
 */
import type { TerminalSessionGroupSlotName } from '../../lib/session-group-viewport';
import type { TerminalSessionGroupLayoutAxis } from '../../lib/terminal-layout-profile';
import type { TerminalSessionDrawerItem } from '../../lib/plugin-session-drawer/session-drawer-contract';

export const DRAWER_WIDTH = '48vw';
export const DRAWER_MAX_WIDTH = '187px';
export const SWIPE_CLOSE_THRESHOLD_PX = 48;
export const SWIPE_CLOSE_VERTICAL_TOLERANCE_PX = 44;
export const UNSCOPED_HOST_GROUP_KEY = '__unscoped__';
export const UNSCOPED_HOST_GROUP_LABEL = '未绑定主机';

export function resolveStatusTone(status: TerminalSessionDrawerItem['status']) {
  switch (status) {
    case 'connected':
      return '#44e2a0';
    case 'connecting':
      return '#f5b659';
    case 'disconnected':
    case 'closed':
    case 'error':
      return '#ff727d';
    default:
      return 'var(--zterm-panel-muted)';
  }
}

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
        color: '#8bd5ff',
        background: 'rgba(139, 213, 255, 0.14)',
        border: 'rgba(139, 213, 255, 0.70)',
      };
    case 'center':
      return {
        label: '中间',
        color: '#44e2a0',
        background: 'rgba(68, 226, 160, 0.14)',
        border: 'rgba(68, 226, 160, 0.72)',
      };
    case 'bottom':
      return {
        label: afterLabel,
        color: '#f5b659',
        background: 'rgba(245, 182, 89, 0.14)',
        border: 'rgba(245, 182, 89, 0.72)',
      };
    default:
      return null;
  }
}

/**
 * TerminalSessionDrawer 常量/色调 helper 子模块（client.session_drawer_preview）。
 */
import type { TerminalSessionGroupSlotName } from '../../lib/session-group-viewport';
import type { TerminalSessionGroupLayoutAxis } from '../../lib/terminal-layout-profile';

export const DRAWER_WIDTH = '78vw';
export const DRAWER_MAX_WIDTH = '312px';
export const SWIPE_CLOSE_THRESHOLD_PX = 48;
export const SWIPE_CLOSE_VERTICAL_TOLERANCE_PX = 44;
export const UNSCOPED_HOST_GROUP_KEY = '__unscoped__';
export const UNSCOPED_HOST_GROUP_LABEL = '未绑定主机';

/** Minimum tap target for every interactive control in the drawer. */
export const DRAWER_TOUCH_TARGET_PX = 44;

export type DrawerSemanticTone =
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral'
  | 'unclassified';

export interface DrawerRoleDescription {
  label: string;
  tone: DrawerSemanticTone;
}

/**
 * Human-readable role label for the Collab projection. Only `ceo` and
 * `master` rank as masters. A session without a projection stays explicit as
 * "未识别" so it is never silently dropped or mislabelled.
 */
export function describeCollabRole(role: string | null | undefined): DrawerRoleDescription {
  switch (role) {
    case 'ceo':
      return { label: 'CEO', tone: 'accent' };
    case 'master':
      return { label: 'Master', tone: 'success' };
    case 'worker':
      return { label: 'Worker', tone: 'warning' };
    default:
      return { label: '未识别', tone: 'unclassified' };
  }
}

export interface DrawerAgentStateDescription {
  label: string;
  tone: DrawerSemanticTone;
}

const AGENT_STATE_LABELS: Record<string, string> = {
  idle: '空闲',
  working: '工作中',
  busy: '忙碌',
  running: '运行中',
  waiting: '等待',
  blocked: '受阻',
  offline: '离线',
  disconnected: '离线',
  error: '异常',
};

/**
 * Agent state is rendered as a status dot plus its own text. Unknown states
 * keep the raw daemon string instead of collapsing to a bare symbol.
 */
export function describeAgentState(agentState: string | null | undefined): DrawerAgentStateDescription | null {
  const raw = typeof agentState === 'string' ? agentState.trim() : '';
  if (!raw) {
    return null;
  }
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const label = AGENT_STATE_LABELS[key] ?? raw;
  if (key === 'error' || key === 'offline' || key === 'disconnected') {
    return { label, tone: 'danger' };
  }
  if (key === 'waiting' || key === 'blocked') {
    return { label, tone: 'warning' };
  }
  if (key === 'working' || key === 'busy' || key === 'running') {
    return { label, tone: 'accent' };
  }
  return { label, tone: 'neutral' };
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

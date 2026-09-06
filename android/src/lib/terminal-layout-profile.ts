export {
  TERMINAL_SESSION_GROUP_LAYOUT_OPTIONS,
  TERMINAL_SESSION_GROUP_WIDE_ASPECT_RATIO,
  normalizeTerminalSessionGroupLayoutMode,
  resolveTerminalLayoutProfile,
  resolveTerminalSessionGroupLayoutAxis,
  type TerminalLayoutProfile,
  type TerminalSessionGroupLayoutAxis,
  type TerminalSessionGroupLayoutMode,
} from '@zterm/shared';

import type { TerminalSessionGroupLayoutMode } from '@zterm/shared';

export function getTerminalSessionGroupLayoutLabel(mode: TerminalSessionGroupLayoutMode) {
  if (mode === 'horizontal') return '左右布局';
  if (mode === 'vertical') return '上下布局';
  return '自动';
}

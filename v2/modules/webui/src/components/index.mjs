// Barrel for the shared V2 WebUI components.
//
// Components receive typed props and emit typed intents via `data-action`
// attributes. They never own transport, terminal, storage, or business keys.

export {
  escapeHtml,
  normalizeTypedError,
  createLoading,
  createReady,
  createUnavailable,
  isLoadable,
  mapLoadable,
  renderLoadableBoundary,
} from './loadable.mjs';

export {
  normalizeStatusState,
  renderStatusBadge,
} from './status-badge.mjs';

export { renderErrorNotice } from './error-notice.mjs';
export { renderFormActions } from './form-actions.mjs';
export { renderWorkspaceTree } from './workspace-tree.mjs';
export { renderMemberPicker } from './member-picker.mjs';
export { renderMemberStatusList } from './member-status-list.mjs';
export { computeWindowHeaderLayout, renderWindowHeader } from './window-header.mjs';
export { RESIZE_DIRECTIONS, renderWindowFrame } from './window-frame.mjs';
export { renderPropertyPanel } from './property-panel.mjs';
export { renderGoalTicketList } from './goal-ticket-list.mjs';
export { renderTicketList } from './ticket-list.mjs';
export { renderTicketDetail } from './ticket-detail.mjs';
export {
  MESSAGE_RECEIPT_STATES,
  FILE_TRANSFER_STATES,
  renderDeliveryStatus,
} from './delivery-status.mjs';

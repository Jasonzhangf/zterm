import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  normalizeTypedError,
  createLoading,
  createReady,
  createUnavailable,
  isLoadable,
  mapLoadable,
  renderLoadableBoundary,
  normalizeStatusState,
  renderStatusBadge,
  renderErrorNotice,
  renderFormActions,
  renderWorkspaceTree,
  renderMemberPicker,
  renderMemberStatusList,
  computeWindowHeaderLayout,
  renderWindowHeader,
  RESIZE_DIRECTIONS,
  renderWindowFrame,
  renderPropertyPanel,
  renderGoalTicketList,
  renderTicketList,
  renderTicketDetail,
  MESSAGE_RECEIPT_STATES,
  FILE_TRANSFER_STATES,
  renderDeliveryStatus,
} from '../../src/components/index.mjs';

const count = (haystack, needle) => haystack.split(needle).length - 1;

function assertRenderShape(result) {
  assert.equal(typeof result.html, 'string', 'html must be a string');
  assert.equal(typeof result.model, 'object', 'model must be an object');
  assert.equal(typeof result.attrs, 'object', 'attrs must be an object');
}

// ---------------------------------------------------------------------------
// loadable
// ---------------------------------------------------------------------------

test('loadable: escapeHtml escapes all five characters', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});

test('loadable: normalizeTypedError handles null, string, Error and typed objects', () => {
  const fromNull = normalizeTypedError(null);
  assert.equal(fromNull.code, 'WEBUI_UNAVAILABLE');
  assert.equal(fromNull.category, 'unavailable');
  assert.equal(fromNull.retryable, false);
  assert.equal(fromNull.details, null);
  assert.equal(typeof fromNull.message, 'string');

  const fromString = normalizeTypedError('boom');
  assert.equal(fromString.message, 'boom');
  assert.equal(fromString.code, 'WEBUI_UNAVAILABLE');

  const err = Object.assign(new Error('bad token'), { code: 'AUTH_INVALID_TOKEN', retryable: false });
  const fromError = normalizeTypedError(err);
  assert.equal(fromError.code, 'AUTH_INVALID_TOKEN');
  assert.equal(fromError.category, 'auth');
  assert.equal(fromError.message, 'bad token');
  assert.equal(fromError.retryable, false);

  const fromTyped = normalizeTypedError({
    code: 'NETWORK_TIMEOUT',
    message: 'slow',
    retryable: true,
    details: { attempt: 2 },
  });
  assert.equal(fromTyped.category, 'transient');
  assert.equal(fromTyped.retryable, true);
  assert.deepEqual(fromTyped.details, { attempt: 2 });
});

test('loadable: createLoading/createReady/createUnavailable shapes', () => {
  const loading = createLoading({ note: 'x' });
  assert.equal(loading.status, 'loading');
  assert.equal(loading.freshness, 'loading');
  assert.equal(loading.value, null);
  assert.equal(loading.error, null);
  assert.equal(loading.note, 'x');

  const ready = createReady(42, { observedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.value, 42);
  assert.equal(ready.observedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(ready.freshness, 'fresh');
  assert.equal(ready.error, null);

  const stale = createReady('v', { freshness: 'stale' });
  assert.equal(stale.freshness, 'stale');

  const bad = createUnavailable('down');
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.freshness, 'unavailable');
  assert.equal(bad.error.message, 'down');
});

test('loadable: isLoadable and mapLoadable preserve metadata', () => {
  assert.equal(isLoadable(createLoading()), true);
  assert.equal(isLoadable(createReady([])), true);
  assert.equal(isLoadable(createUnavailable('x')), true);
  assert.equal(isLoadable({ status: 'bogus' }), false);
  assert.equal(isLoadable(null), false);

  const source = createReady([1, 2, 3], { observedAt: 'T0', freshness: 'stale' });
  const mapped = mapLoadable(source, (values) => values.map((v) => v * 2));
  assert.deepEqual(mapped.value, [2, 4, 6]);
  assert.equal(mapped.observedAt, 'T0');
  assert.equal(mapped.freshness, 'stale');
  assert.equal(mapped.status, 'ready');

  const loading = createLoading();
  assert.equal(mapLoadable(loading, () => 'nope'), loading);
});

test('loadable: renderLoadableBoundary dispatches by status', () => {
  const handlers = {
    renderReady: (value) => `ready:${value}`,
    renderLoading: () => 'loading',
    renderUnavailable: (error) => `unavailable:${error.code}`,
  };

  assert.equal(renderLoadableBoundary(createReady('x'), handlers), 'ready:x');
  assert.equal(renderLoadableBoundary(createLoading(), handlers), 'loading');
  assert.equal(
    renderLoadableBoundary(createUnavailable({ code: 'E_UNAVAILABLE' }), handlers),
    'unavailable:E_UNAVAILABLE'
  );
});

// ---------------------------------------------------------------------------
// status-badge
// ---------------------------------------------------------------------------

test('status-badge: normalizeStatusState honesty rules', () => {
  assert.equal(normalizeStatusState('online', 'fresh'), 'online');
  assert.equal(normalizeStatusState('online', 'stale'), 'stale');
  assert.equal(normalizeStatusState('online', 'expired'), 'stale');
  assert.equal(normalizeStatusState('busy', 'stale'), 'busy');
  assert.equal(normalizeStatusState(null), 'unknown');
  assert.equal(normalizeStatusState('nonsense'), 'unknown');
});

test('status-badge: stale online is never healthy', () => {
  const stale = renderStatusBadge({ state: 'online', freshness: 'stale' });
  assertRenderShape(stale);
  assert.equal(stale.model.effectiveState, 'stale');
  assert.equal(stale.model.isHealthyOnline, false);
  assert.ok(stale.html.includes('data-component="status-badge"'));
  assert.ok(stale.html.includes('data-status-state="stale"'));
  assert.ok(stale.html.includes('data-status-freshness="stale"'));
  assert.ok(stale.html.includes('data-healthy-online="false"'));

  const healthy = renderStatusBadge({ state: 'online', freshness: 'fresh' });
  assert.equal(healthy.model.effectiveState, 'online');
  assert.equal(healthy.model.isHealthyOnline, true);
  assert.ok(healthy.html.includes('data-healthy-online="true"'));

  const unknown = renderStatusBadge({ state: null });
  assert.equal(unknown.model.effectiveState, 'unknown');
  assert.equal(unknown.model.isHealthyOnline, false);
});

// ---------------------------------------------------------------------------
// error-notice
// ---------------------------------------------------------------------------

test('error-notice: retryable shows retry action, escapes message', () => {
  const result = renderErrorNotice({
    error: { code: 'NETWORK_TIMEOUT', message: '<script>x</script>', retryable: true },
    title: 'Failed',
    contextId: 'ctx-1',
  });
  assertRenderShape(result);
  assert.ok(result.html.includes('data-component="error-notice"'));
  assert.ok(result.html.includes('data-error-code="NETWORK_TIMEOUT"'));
  assert.ok(result.html.includes('data-error-category="transient"'));
  assert.ok(result.html.includes('data-error-retryable="true"'));
  assert.ok(result.html.includes('data-action="retry-error"'));
  assert.ok(result.html.includes('data-context-id="ctx-1"'));
  assert.ok(result.html.includes('&lt;script&gt;'));
  assert.ok(!result.html.includes('<script>'));
  assert.equal(result.model.retryable, true);
});

test('error-notice: non-retryable omits retry button', () => {
  const result = renderErrorNotice({ error: { code: 'VALIDATION_FAILED', message: 'bad', retryable: false } });
  assert.ok(result.html.includes('data-error-retryable="false"'));
  assert.equal(count(result.html, 'data-action="retry-error"'), 0);
});

// ---------------------------------------------------------------------------
// form-actions
// ---------------------------------------------------------------------------

test('form-actions: pending disables submit and prevents duplicate submission', () => {
  const pending = renderFormActions({ formId: 'f1', pending: true });
  assertRenderShape(pending);
  assert.equal(pending.model.submitDisabled, true);
  assert.equal(pending.model.hasError, false);
  assert.ok(pending.html.includes('data-submit-disabled="true"'));
  assert.ok(pending.html.includes('disabled'));

  const idle = renderFormActions({ formId: 'f1' });
  assert.equal(idle.model.submitDisabled, false);
});

test('form-actions: error embeds error notice', () => {
  const result = renderFormActions({
    formId: 'f2',
    error: { code: 'VALIDATION_FAILED', message: 'invalid', retryable: false },
  });
  assert.equal(result.model.hasError, true);
  assert.ok(result.html.includes('data-component="error-notice"'));
  assert.ok(result.html.includes('data-action="retry-form"'));
});

// ---------------------------------------------------------------------------
// workspace-tree
// ---------------------------------------------------------------------------

test('workspace-tree: loading / ready / empty / unavailable', () => {
  const loading = renderWorkspaceTree({ workspacesLoadable: createLoading() });
  assertRenderShape(loading);
  assert.equal(loading.model.status, 'loading');
  assert.deepEqual(loading.model.items, []);
  assert.ok(loading.html.includes('data-component="workspace-tree"'));

  const ready = renderWorkspaceTree({
    workspacesLoadable: createReady([
      { workspaceId: 'ws1', name: 'Alpha', memberCount: 3, unreadCount: 2, status: 'online' },
      { workspaceId: 'ws2', name: 'Beta', memberCount: 5, unreadCount: 0, status: 'busy' },
    ]),
    activeWorkspaceId: 'ws1',
  });
  assert.equal(ready.model.status, 'ready');
  assert.equal(ready.model.items.length, 2);
  assert.equal(ready.model.items[0].active, true);
  assert.equal(ready.model.items[1].active, false);
  assert.ok(ready.html.includes('data-workspace-id="ws1"'));
  assert.ok(ready.html.includes('data-workspace-id="ws2"'));
  assert.ok(ready.html.includes('data-active="true"'));

  const empty = renderWorkspaceTree({ workspacesLoadable: createReady([]) });
  assert.equal(empty.model.items.length, 0);
  assert.ok(empty.html.includes('workspace-tree-empty'));

  const unavailable = renderWorkspaceTree({
    workspacesLoadable: createUnavailable({ code: 'E_UNAVAILABLE', message: 'down' }),
  });
  assert.equal(unavailable.model.status, 'unavailable');
  assert.equal(unavailable.model.error.code, 'E_UNAVAILABLE');
  assert.ok(unavailable.html.includes('data-component="error-notice"'));
});

// ---------------------------------------------------------------------------
// member-picker
// ---------------------------------------------------------------------------

test('member-picker: unlimited by default supports 5+ peers', () => {
  const members = Array.from({ length: 6 }, (_, i) => ({ memberId: `m${i + 1}`, name: `M${i + 1}` }));
  const unlimited = renderMemberPicker({
    members,
    selectedMemberIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
  });
  assertRenderShape(unlimited);
  assert.equal(unlimited.model.selectedCount, 5);
  assert.ok(unlimited.model.items.every((item) => item.disabled === false));
  assert.ok(unlimited.html.includes('data-member-id="m6"'));
  assert.equal(count(unlimited.html, '<label class="v2-member-option"'), 6);
});

test('member-picker: maxSelection disables unselected at limit', () => {
  const members = [
    { memberId: 'a', name: 'A' },
    { memberId: 'b', name: 'B' },
    { memberId: 'c', name: 'C' },
  ];
  const result = renderMemberPicker({
    members,
    selectedMemberIds: ['a', 'b'],
    disabledMemberIds: ['c'],
    maxSelection: 2,
  });
  assert.equal(result.model.selectedCount, 2);
  const byId = Object.fromEntries(result.model.items.map((i) => [i.memberId, i]));
  assert.equal(byId.a.disabled, false);
  assert.equal(byId.b.disabled, false);
  assert.equal(byId.c.disabled, true);
  assert.ok(result.html.includes('data-at-max="true"'));
});

// ---------------------------------------------------------------------------
// member-status-list
// ---------------------------------------------------------------------------

test('member-status-list: stale/removed members are explicit, never silently dropped', () => {
  const result = renderMemberStatusList({
    membersLoadable: createReady([
      { memberId: 'm1', name: 'A', role: 'dev', machine: 'mac', status: 'online', freshness: 'fresh' },
      { memberId: 'm2', name: 'B', role: 'dev', machine: 'mac', status: 'online', freshness: 'stale' },
      { memberId: 'm3', name: 'C', role: 'ops', machine: 'pi', status: 'stale' },
      { memberId: 'm4', name: 'D', role: 'ops', machine: 'pi', status: 'online', freshness: 'fresh', removedFromWorkspace: true, staleReason: 'removed' },
    ]),
    selectedMemberId: 'm1',
  });
  assertRenderShape(result);
  assert.equal(result.model.status, 'ready');
  assert.equal(result.model.items.length, 4);
  assert.deepEqual(result.model.staleMemberIds, ['m2', 'm3', 'm4']);
  assert.equal(result.model.items[0].stale, false);
  assert.equal(result.model.items[0].selected, true);
  assert.equal(result.model.items[1].stale, true);
  assert.equal(result.model.items[3].removedFromWorkspace, true);
  assert.equal(result.model.items[3].stale, true);
  assert.ok(result.html.includes('data-action="remove-stale-member"'));
  assert.equal(count(result.html, 'data-action="remove-stale-member"'), 3);
});

// ---------------------------------------------------------------------------
// window-header
// ---------------------------------------------------------------------------

test('window-header: single-line layout base contract', () => {
  const layout = computeWindowHeaderLayout({
    windowId: 'w1',
    memberId: 'm1',
    title: 'agent-alpha',
    status: 'online',
    freshness: 'fresh',
    role: 'engineer',
    machine: 'iMac',
    availableWidth: 360,
  });
  assert.equal(layout.singleLine, true);
  assert.equal(layout.heightPx, 28);
  assert.ok(layout.heightPx <= 32);
  assert.equal(layout.whiteSpace, 'nowrap');
  assert.equal(layout.primaryActionVisible, true);
  assert.equal(layout.showStatus, true);
});

test('window-header: narrow-width priority hides machine then role', () => {
  const base = {
    title: 'agent-alpha',
    status: 'online',
    role: 'engineer',
    machine: 'iMac',
    primaryAction: { id: 'toggle-property', label: 'Props' },
    secondaryActions: [
      { id: 'pin', label: 'Pin' },
      { id: 'focus', label: 'Focus' },
    ],
  };

  const wide = computeWindowHeaderLayout({ ...base, availableWidth: 440 });
  assert.equal(wide.showRole, true);
  assert.equal(wide.showMachine, true);
  assert.equal(wide.inlineSecondaryActions.length, 2);
  assert.equal(wide.overflowActions.length, 0);
  assert.equal(wide.hasOverflowMenu, false);

  const medium = computeWindowHeaderLayout({ ...base, availableWidth: 320 });
  assert.equal(medium.inlineSecondaryActions.length, 1);
  assert.equal(medium.overflowActions.length, 1);
  assert.equal(medium.hasOverflowMenu, true);

  const narrowMachine = computeWindowHeaderLayout({ ...base, availableWidth: 240 });
  assert.equal(narrowMachine.showMachine, false);
  assert.equal(narrowMachine.showRole, true);
  assert.equal(narrowMachine.inlineSecondaryActions.length, 0);
  assert.equal(narrowMachine.overflowActions.length, 2);
  assert.equal(narrowMachine.primaryActionVisible, true);

  const narrowRole = computeWindowHeaderLayout({ ...base, availableWidth: 180 });
  assert.equal(narrowRole.showMachine, false);
  assert.equal(narrowRole.showRole, false);
  assert.equal(narrowRole.primaryActionVisible, true);
  assert.ok(narrowRole.titleMaxWidthPx > 0);
  assert.ok(narrowRole.titleMaxWidthPx < narrowRole.titleEstimatedWidth);
  assert.ok(narrowRole.estimatedInlineWidth <= narrowRole.availableWidth);
});

test('window-header: render keeps title/status/primary and overflow menu', () => {
  const result = renderWindowHeader({
    windowId: 'w9',
    memberId: 'm9',
    title: 'agent-alpha',
    status: 'online',
    freshness: 'fresh',
    role: 'engineer',
    machine: 'iMac',
    primaryAction: { id: 'toggle-property', label: 'Props' },
    secondaryActions: [
      { id: 'pin', label: 'Pin' },
      { id: 'focus', label: 'Focus' },
    ],
    availableWidth: 180,
    overflowOpen: true,
  });
  assertRenderShape(result);
  assert.equal(result.model.showRole, false);
  assert.equal(result.model.showMachine, false);
  assert.ok(result.html.includes('style="height:28px;max-height:32px;'));
  assert.ok(result.html.includes('data-role="window-title"'));
  assert.ok(result.html.includes('data-role="window-status"'));
  assert.ok(result.html.includes('data-role="window-primary-action"'));
  assert.ok(result.html.includes('data-role="window-overflow-trigger"'));
  assert.ok(result.html.includes('data-role="window-overflow-menu"'));
  assert.ok(result.html.includes('data-role="window-overflow-role"'));
  assert.ok(result.html.includes('data-role="window-overflow-machine"'));
  assert.ok(result.html.includes('data-action="pin"'));
  assert.ok(result.html.includes('data-action="focus"'));
  assert.equal(result.attrs['data-single-line'], 'true');
});

// ---------------------------------------------------------------------------
// window-frame
// ---------------------------------------------------------------------------

test('window-frame: renders header, 8 resize handles, body and property drawer', () => {
  assert.deepEqual([...RESIZE_DIRECTIONS], ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

  const result = renderWindowFrame({
    windowId: 'w1',
    memberId: 'm1',
    title: 'agent-alpha',
    status: 'online',
    freshness: 'fresh',
    role: 'engineer',
    machine: 'iMac',
    isPrimary: true,
    isFocused: true,
    isStale: false,
    propertyOpen: true,
    propertyPanelHtml: '<div data-component="property-panel">pp</div>',
    bodyHtml: '<canvas data-terminal-body="true"></canvas>',
  });
  assertRenderShape(result);
  assert.ok(result.html.includes('data-component="window-frame"'));
  assert.ok(result.html.includes('data-window-id="w1"'));
  assert.ok(result.html.includes('data-member-id="m1"'));
  assert.ok(result.html.includes('data-is-primary="true"'));
  assert.ok(result.html.includes('data-is-focused="true"'));
  assert.ok(result.html.includes('data-is-stale="false"'));
  assert.ok(result.html.includes('data-property-open="true"'));
  assert.equal(count(result.html, 'data-resize-handle='), 8);
  for (const dir of RESIZE_DIRECTIONS) {
    assert.ok(result.html.includes(`data-resize-handle="${dir}"`));
  }
  assert.ok(result.html.includes('data-role="window-body"'));
  assert.ok(result.html.includes('data-terminal-body="true"'));
  assert.ok(result.html.includes('data-role="window-property-drawer"'));
  assert.ok(result.html.includes('data-component="window-header"'));
  assert.equal(result.model.resizeDirections.length, 8);

  const noHandles = renderWindowFrame({
    windowId: 'w2',
    memberId: 'm2',
    title: 'x',
    enableResizeHandles: false,
  });
  assert.equal(count(noHandles.html, 'data-resize-handle='), 0);
});

// ---------------------------------------------------------------------------
// property-panel
// ---------------------------------------------------------------------------

test('property-panel: ready values bound to window and member, draft overrides', () => {
  const result = renderPropertyPanel({
    windowId: 'w1',
    memberId: 'm1',
    propertiesLoadable: createReady({
      role: 'engineer',
      description: 'base',
      cwd: '/tmp',
      envSummary: 'A=1',
      connectionRef: 'ref',
      workspaceBinding: 'ws1',
    }),
    draft: { description: 'override' },
  });
  assertRenderShape(result);
  assert.equal(result.model.status, 'ready');
  assert.equal(result.model.effectiveValues.description, 'override');
  assert.equal(result.model.effectiveValues.role, 'engineer');
  for (const key of ['role', 'description', 'cwd', 'envSummary', 'connectionRef', 'workspaceBinding']) {
    assert.ok(result.html.includes(`data-field="${key}"`), `${key} field rendered`);
  }
  assert.ok(result.html.includes('data-window-id="w1"'));
  assert.ok(result.html.includes('data-member-id="m1"'));
});

test('property-panel: saving and saveError surface through FormActions', () => {
  const result = renderPropertyPanel({
    windowId: 'w1',
    memberId: 'm1',
    propertiesLoadable: createReady({ role: 'engineer' }),
    saving: true,
    saveError: { code: 'VALIDATION_FAILED', message: 'bad', retryable: false },
  });
  assert.equal(result.model.saving, true);
  assert.equal(result.model.saveError.code, 'VALIDATION_FAILED');
  assert.ok(result.html.includes('data-component="form-actions"'));
  assert.ok(result.html.includes('data-pending="true"'));
  assert.ok(result.html.includes('data-component="error-notice"'));
});

test('property-panel: loading and unavailable states', () => {
  const loading = renderPropertyPanel({ windowId: 'w1', memberId: 'm1', propertiesLoadable: createLoading() });
  assert.equal(loading.model.status, 'loading');
  assert.equal(loading.model.effectiveValues, null);
  assert.ok(loading.html.includes('data-role="property-loading"'));

  const unavailable = renderPropertyPanel({
    windowId: 'w1',
    memberId: 'm1',
    propertiesLoadable: createUnavailable({ code: 'E_UNAVAILABLE', message: 'down' }),
  });
  assert.equal(unavailable.model.status, 'unavailable');
  assert.ok(unavailable.html.includes('data-component="error-notice"'));
});

// ---------------------------------------------------------------------------
// goal-ticket-list / ticket-list / ticket-detail
// ---------------------------------------------------------------------------

test('goal-ticket-list: renders goals and handles unavailable', () => {
  const ready = renderGoalTicketList({
    goalsLoadable: createReady([
      { goalId: 'g1', title: 'Ship', status: 'active', ownerMemberId: 'm1', ticketCount: 4, updatedAt: 'T1' },
      { goalId: 'g2', title: 'Audit', status: 'blocked', ownerMemberId: 'm2', ticketCount: 1, updatedAt: 'T2' },
    ]),
    selectedGoalId: 'g2',
  });
  assertRenderShape(ready);
  assert.equal(ready.model.items.length, 2);
  assert.equal(ready.model.items[1].selected, true);
  assert.ok(ready.html.includes('data-goal-id="g1"'));
  assert.ok(ready.html.includes('data-goal-id="g2"'));

  const unavailable = renderGoalTicketList({ goalsLoadable: createUnavailable({ code: 'E', message: 'x' }) });
  assert.equal(unavailable.model.status, 'unavailable');
  assert.equal(unavailable.model.error.code, 'E');
});

test('ticket-list: status filtering and selection', () => {
  const tickets = createReady([
    { ticketId: 't1', title: 'A', status: 'open', priority: 'P1', assigneeId: 'm1', reviewerId: 'm2', updatedAt: 'T1' },
    { ticketId: 't2', title: 'B', status: 'review', priority: 'P2', assigneeId: 'm1', reviewerId: 'm2', updatedAt: 'T2' },
    { ticketId: 't3', title: 'C', status: 'done', priority: 'P3', assigneeId: 'm1', reviewerId: 'm2', updatedAt: 'T3' },
  ]);

  const all = renderTicketList({ ticketsLoadable: tickets, activeStatusFilter: 'all', selectedTicketId: 't2' });
  assertRenderShape(all);
  assert.equal(all.model.totalCount, 3);
  assert.equal(all.model.filteredCount, 3);
  assert.equal(all.model.items.length, 3);
  assert.equal(all.model.items[1].selected, true);

  const open = renderTicketList({ ticketsLoadable: tickets, activeStatusFilter: 'open' });
  assert.equal(open.model.filteredCount, 1);
  assert.equal(open.model.items[0].ticketId, 't1');
  assert.ok(open.html.includes('data-active="true"'));
  assert.ok(open.html.includes('data-ticket-id="t1"'));
  const chipFilters = [...open.html.matchAll(/<button type="button" class="v2-ticket-filter"[^>]*data-filter="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(chipFilters, ['all', 'open', 'closed']);

  const unavailable = renderTicketList({ ticketsLoadable: createUnavailable({ code: 'E', message: 'x' }) });
  assert.equal(unavailable.model.status, 'unavailable');
});

test('ticket-detail: transitions and explicit invalid-transition error', () => {
  const ticket = createReady({
    ticketId: 't1',
    title: 'Fix it',
    description: 'desc',
    status: 'open',
    assigneeId: 'm1',
    reviewerId: 'm2',
    acceptanceCriteria: ['works'],
    deliveryEvidence: ['log'],
    reviewNotes: ['note'],
    allowedTransitions: ['review', { to: 'blocked', label: 'Block' }],
  });

  const ready = renderTicketDetail({ ticketLoadable: ticket });
  assertRenderShape(ready);
  assert.equal(ready.model.status, 'ready');
  assert.equal(ready.model.allowedTransitions.length, 2);
  assert.equal(ready.model.allowedTransitions[0].to, 'review');
  assert.equal(ready.model.allowedTransitions[1].label, 'Block');
  assert.ok(ready.html.includes('data-action="transition-ticket"'));
  assert.ok(ready.html.includes('data-transition="review"'));
  assert.ok(ready.html.includes('data-transition="blocked"'));

  const errored = renderTicketDetail({
    ticketLoadable: ticket,
    transitionPending: true,
    transitionError: { code: 'INVALID_TRANSITION', message: 'cannot', retryable: false },
  });
  assert.equal(errored.model.transitionPending, true);
  assert.equal(errored.model.transitionError.code, 'INVALID_TRANSITION');
  assert.ok(errored.html.includes('data-component="error-notice"'));
  assert.ok(errored.html.includes('disabled'));

  const unavailable = renderTicketDetail({ ticketLoadable: createUnavailable({ code: 'E', message: 'x' }) });
  assert.ok(unavailable.html.includes('data-component="error-notice"'));
});

// ---------------------------------------------------------------------------
// delivery-status
// ---------------------------------------------------------------------------

test('delivery-status: state constants are frozen and complete', () => {
  assert.equal(Object.isFrozen(MESSAGE_RECEIPT_STATES), true);
  assert.equal(Object.isFrozen(FILE_TRANSFER_STATES), true);
  for (const s of ['queued', 'sent', 'delivered', 'consumed', 'failed', 'expired']) {
    assert.ok(MESSAGE_RECEIPT_STATES.includes(s));
  }
  for (const s of ['offered', 'accepted', 'transferring', 'completed', 'failed', 'cancelled']) {
    assert.ok(FILE_TRANSFER_STATES.includes(s));
  }
});

test('delivery-status: receipts failures, retry, transfer progress and cancel', () => {
  const result = renderDeliveryStatus({
    receipts: [
      { deliveryRef: 'r1', state: 'consumed', observedAt: 'T1' },
      { deliveryRef: 'r2', state: 'failed', error: 'boom', retryable: true, observedAt: 'T2' },
    ],
    transfers: [
      { deliveryRef: 't1', fileName: 'a.bin', state: 'transferring', bytesTransferred: 50, totalBytes: 100 },
      { deliveryRef: 't2', fileName: 'b.bin', state: 'cancelled', error: 'user cancel', totalBytes: 200, bytesTransferred: 0 },
    ],
  });
  assertRenderShape(result);
  assert.equal(result.model.hasFailures, true);
  assert.equal(result.model.activeTransferCount, 1);
  assert.ok(result.html.includes('data-component="delivery-status"'));
  assert.ok(result.html.includes('data-has-failures="true"'));
  assert.ok(result.html.includes('data-receipt-state="failed"'));
  assert.ok(result.html.includes('data-transfer-state="transferring"'));
  assert.ok(result.html.includes('data-action="retry-delivery"'));
  assert.ok(result.html.includes('data-action="cancel-transfer"'));
  assert.ok(result.html.includes('data-progress="50"'));
  assert.ok(result.html.includes('boom'));
  assert.ok(result.html.includes('user cancel'));

  const empty = renderDeliveryStatus();
  assert.equal(empty.model.hasFailures, false);
  assert.equal(empty.model.activeTransferCount, 0);
});

test('delivery-status: top-level unavailable error is surfaced', () => {
  const result = renderDeliveryStatus({
    receipts: [],
    transfers: [],
    error: { code: 'E_DELIVERY', message: 'down', retryable: true },
  });
  assert.equal(result.model.error.code, 'E_DELIVERY');
  assert.ok(result.html.includes('data-component="error-notice"'));
});

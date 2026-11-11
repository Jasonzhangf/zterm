import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRIMARY_RATIO,
  DEFAULT_PREVIEW_VIEWPORT,
  MIN_PANE_WIDTH,
  MIN_PANE_HEIGHT,
  createDefaultSessionLayout,
  reconcileWorkspaceLayout,
  promotePrimaryMember,
  removeStaleMemberSlot,
  toggleWindowPropertyDrawer,
} from '../../src/state/session-layout.mjs';
import { createLayoutStore } from '../../src/state/layout-store.mjs';
import { applyBorderDrag, renderSplitLayout } from '../../src/features/sessions/split-layout.mjs';
import { renderSessionWorkbench } from '../../src/features/sessions/session-workbench.mjs';
import {
  shouldHijackTerminalGesture,
  applyPreviewGesture,
  renderSessionPreviewCanvas,
} from '../../src/features/sessions/session-preview-canvas.mjs';
import {
  getOrderedSessionMembers,
  stepFocusedMember,
  enterMemberFocus,
  exitMemberFocusToPreview,
  renderSessionFocusView,
} from '../../src/features/sessions/session-focus-view.mjs';
import { renderWorkspaceQuickSwitch } from '../../src/features/sessions/workspace-quick-switch.mjs';

test('default layout keeps primary plus all peers without a 4-peer cap', () => {
  const layout = createDefaultSessionLayout({
    accountId: 'acct-1',
    workspaceId: 'ws-1',
    members: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
  });
  assert.strictEqual(layout.accountId, 'acct-1');
  assert.strictEqual(layout.workspaceId, 'ws-1');
  assert.strictEqual(layout.primaryMemberId, 'm1');
  assert.deepEqual(layout.peerMemberIds, ['m2', 'm3', 'm4', 'm5', 'm6']);
  assert.strictEqual(layout.memberSlots.length, 6);
  assert.strictEqual(layout.primaryRatio, DEFAULT_PRIMARY_RATIO);
  assert.strictEqual(layout.peerColumnSplitRatio, 0.5);
  assert.strictEqual(layout.mobileMode, 'focus');
  assert.deepEqual(layout.previewViewport, DEFAULT_PREVIEW_VIEWPORT);
  assert.ok(layout.updatedAt);
});

test('reconcile appends 5th and 6th members from a legacy 4-slot config', () => {
  const saved = {
    accountId: 'acct-1',
    workspaceId: 'ws-1',
    primaryMemberId: 'm1',
    peerMemberIds: ['m2', 'm3', 'm4'],
    memberSlots: ['m1', 'm2', 'm3', 'm4'].map((memberId) => ({
      memberId,
      slotRole: memberId === 'm1' ? 'primary' : 'peer',
      stale: false,
      staleReason: null,
    })),
  };
  const reconciled = reconcileWorkspaceLayout(saved, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.deepEqual(reconciled.peerMemberIds, ['m2', 'm3', 'm4', 'm5', 'm6']);
  assert.strictEqual(reconciled.memberSlots.length, 6);
  assert.ok(reconciled.memberSlots.some((slot) => slot.memberId === 'm5' && !slot.stale));
  assert.ok(reconciled.memberSlots.some((slot) => slot.memberId === 'm6' && !slot.stale));
});

test('reconcile keeps removed members as stale slots instead of silently dropping them', () => {
  const saved = {
    accountId: 'acct-1',
    workspaceId: 'ws-1',
    primaryMemberId: 'm1',
    peerMemberIds: ['m2', 'm9'],
    memberSlots: ['m1', 'm2', 'm9'].map((memberId) => ({
      memberId,
      slotRole: memberId === 'm1' ? 'primary' : 'peer',
      stale: false,
      staleReason: null,
    })),
  };
  const current = [
    { memberId: 'm1' },
    { memberId: 'm2' },
    { memberId: 'm9', removedFromWorkspace: true },
  ];
  const reconciled = reconcileWorkspaceLayout(saved, current);
  assert.deepEqual(reconciled.peerMemberIds, ['m2']);
  const staleSlot = reconciled.memberSlots.find((slot) => slot.memberId === 'm9');
  assert.ok(staleSlot);
  assert.strictEqual(staleSlot.stale, true);
  assert.strictEqual(staleSlot.staleReason, 'Member removed from workspace');
});

test('promotePrimaryMember swaps primary while keeping all peers', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  const promoted = promotePrimaryMember(layout, 'm3');
  assert.strictEqual(promoted.primaryMemberId, 'm3');
  assert.deepEqual(promoted.peerMemberIds, ['m1', 'm2']);
  assert.deepEqual(promoted.memberSlots.map((slot) => slot.slotRole), ['peer', 'peer', 'primary']);
});

test('removeStaleMemberSlot promotes a healthy peer when the stale primary is removed', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  layout.memberSlots[0] = { ...layout.memberSlots[0], stale: true, staleReason: 'Member removed from workspace' };
  const removed = removeStaleMemberSlot(layout, 'm1');
  assert.strictEqual(removed.primaryMemberId, 'm2');
  assert.deepEqual(removed.peerMemberIds, ['m3']);
  assert.ok(!removed.memberSlots.some((slot) => slot.memberId === 'm1'));
  assert.strictEqual(removed.memberSlots.find((slot) => slot.memberId === 'm2').slotRole, 'primary');
});

test('removeStaleMemberSlot rejects non-stale members', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  assert.throws(() => removeStaleMemberSlot(layout, 'm2'), /stale/i);
});

test('toggleWindowPropertyDrawer is independent per window', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  const opened = toggleWindowPropertyDrawer(layout, 'window-primary', true);
  const closed = toggleWindowPropertyDrawer(opened, 'window-primary');
  const peerOpened = toggleWindowPropertyDrawer(opened, 'window-peer-m2', true);
  assert.strictEqual(opened.openPropertyByWindow['window-primary'], true);
  assert.strictEqual(closed.openPropertyByWindow['window-primary'], false);
  assert.strictEqual(peerOpened.openPropertyByWindow['window-peer-m2'], true);
  assert.strictEqual(peerOpened.openPropertyByWindow['window-primary'], true);
});

test('layout store persists, updates, and lists scoped keys', () => {
  const store = createLayoutStore();
  const layout = createDefaultSessionLayout({ accountId: 'a', workspaceId: 'w', members: ['m1', 'm2', 'm3'] });
  const saved = store.saveLayout('a', 'w', layout);
  assert.strictEqual(saved.primaryMemberId, 'm1');
  assert.deepEqual(store.listWorkspaceKeys(), ['a:w']);
  const loaded = store.loadLayout('a', 'w', ['m1', 'm2', 'm3']);
  assert.deepEqual(loaded.peerMemberIds, ['m2', 'm3']);
  const updated = store.updateLayout('a', 'w', (current) => ({ ...current, primaryRatio: 0.5 }), ['m1', 'm2', 'm3']);
  assert.strictEqual(updated.primaryRatio, 0.5);
  const reloaded = store.loadLayout('a', 'w', ['m1', 'm2', 'm3']);
  assert.strictEqual(reloaded.primaryRatio, 0.5);
});

test('layout store supports a Web Storage-compatible backend', () => {
  const backing = new Map();
  const storage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
    get length() { return backing.size; },
    key: (index) => Array.from(backing.keys())[index] ?? null,
  };
  const store = createLayoutStore({ storage });
  store.saveLayout('a', 'w1', createDefaultSessionLayout({ accountId: 'a', workspaceId: 'w1', members: ['m1'] }));
  store.saveLayout('a', 'w2', createDefaultSessionLayout({ accountId: 'a', workspaceId: 'w2', members: ['m1'] }));
  assert.deepEqual(store.listWorkspaceKeys(), ['a:w1', 'a:w2']);
  assert.strictEqual(store.loadLayout('a', 'w1', ['m1']).primaryMemberId, 'm1');
});

test('applyBorderDrag clamps primary ratio to minimum pane widths', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  const dragged = applyBorderDrag(layout, { kind: 'vertical-main', deltaX: 100, containerWidth: 1000 });
  assert.ok(Math.abs(dragged.primaryRatio - 0.52) < 1e-9);
  const maxed = applyBorderDrag(layout, { kind: 'vertical-main', deltaX: 1000, containerWidth: 1000 });
  assert.ok(Math.abs(maxed.primaryRatio - 0.64) < 1e-9);
  const minned = applyBorderDrag(layout, { kind: 'vertical-main', deltaX: -1000, containerWidth: 1000 });
  assert.strictEqual(minned.primaryRatio, 0.24);
});

test('applyBorderDrag clamps peer column and row sizes', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  const col = applyBorderDrag(layout, { kind: 'vertical-peer-col', deltaX: 200, containerWidth: 1000 });
  assert.ok(Math.abs(col.peerColumnSplitRatio - (1 - 180 / 580)) < 1e-9);
  const row = applyBorderDrag(layout, { kind: 'horizontal-peer-row', rowIndex: 1, deltaY: 100, containerWidth: 1000 });
  assert.strictEqual(row.peerRowHeights['1'], 320);
  const rowMin = applyBorderDrag(layout, { kind: 'horizontal-peer-row', rowIndex: 1, deltaY: -500, containerWidth: 1000 });
  assert.strictEqual(rowMin.peerRowHeights['1'], MIN_PANE_HEIGHT);
});

test('applyBorderDrag updates window sizes and matching ratios', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  const primaryResized = applyBorderDrag(layout, {
    kind: 'window-border',
    windowId: 'window-primary',
    edge: 'e',
    deltaX: 50,
    containerWidth: 1000,
    containerHeight: 760,
  });
  assert.ok(primaryResized.windowSizes['window-primary'].widthPx >= MIN_PANE_WIDTH);
  assert.ok(Math.abs(primaryResized.primaryRatio - 0.47) < 1e-9);
  const peerResized = applyBorderDrag(layout, {
    kind: 'window-border',
    windowId: 'window-peer-m2',
    edge: 'se',
    deltaX: 50,
    deltaY: -500,
    rowIndex: 0,
    containerWidth: 1000,
    containerHeight: 760,
  });
  assert.ok(peerResized.windowSizes['window-peer-m2'].widthPx >= MIN_PANE_WIDTH);
  assert.ok(peerResized.windowSizes['window-peer-m2'].heightPx >= MIN_PANE_HEIGHT);
  assert.ok(Math.abs(peerResized.peerColumnSplitRatio - (0.5 + 50 / 580)) < 1e-9);
  assert.strictEqual(peerResized.peerRowHeights['0'], MIN_PANE_HEIGHT);
});

test('renderSplitLayout emits both interactive border splitters', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  const result = renderSplitLayout({ layout, primaryHtml: '<div>primary</div>', peerGridHtml: '<div>peers</div>' });
  assert.ok(result.html.includes('data-component="split-layout"'));
  assert.ok(result.html.includes('data-primary-ratio="0.42"'));
  assert.ok(result.html.includes('data-peer-col-ratio="0.5"'));
  assert.ok(result.html.includes('data-splitter="vertical-main"'));
  assert.ok(result.html.includes('data-splitter="vertical-peer-col"'));
  assert.strictEqual(result.model.containerWidth, 1280);
  assert.strictEqual(result.model.primaryWidthPx, 538);
});

test('renderSessionWorkbench renders a 1+4 desktop grid and keeps remaining members in the switcher', () => {
  const members = Array.from({ length: 12 }, (_, index) => `m${index + 1}`);
  const layout = createDefaultSessionLayout({ members });
  const result = renderSessionWorkbench({
    layout,
    terminalBodiesByMember: { m2: '<div>TERM-BODY</div>' },
    containerWidth: 1280,
    containerHeight: 760,
  });
  assert.strictEqual(result.model.totalMemberCount, 12);
  assert.strictEqual(result.model.visiblePeerIds.length, 4);
  assert.strictEqual(result.model.hiddenPeerIds.length, 7);
  assert.strictEqual(result.model.peerWindows.length, 4);
  assert.strictEqual(result.model.rightGridScrollable, false);
  assert.ok(result.html.includes('data-role="peer-scroll-grid"'));
  assert.ok(result.html.includes('grid-template-columns:minmax(0,1fr) minmax(0,1fr)'));
  assert.ok(result.html.includes('grid-template-rows:minmax(0,1fr) minmax(0,1fr)'));
  assert.ok(result.html.includes('data-role="member-switcher"'));
  assert.ok(result.html.includes('data-member-id="m6"'));
  assert.ok(!result.html.includes('height:220px'));
  assert.ok(result.html.includes('data-resize-handle="n|s|e|w|ne|nw|se|sw"'));
  assert.ok(result.html.includes('data-member-id="m2"'));
  assert.ok(result.html.includes('data-component="window-header"'));
  assert.ok(result.html.includes('data-role="window-property-drawer"'));
  assert.ok(result.html.includes('data-terminal-body="true"'));
  assert.ok(result.html.includes('TERM-BODY'));
});

test('renderSessionWorkbench accepts a custom renderFrame', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  let calls = 0;
  const custom = (props) => {
    calls += 1;
    return `<div data-custom-frame="true" data-member-id="${props.memberId}">CUSTOM</div>`;
  };
  const result = renderSessionWorkbench({ layout, renderFrame: custom });
  assert.ok(calls > 1);
  assert.ok(result.html.includes('data-custom-frame="true"'));
});

test('terminal gestures inside terminal bodies never pan or zoom the preview', () => {
  assert.strictEqual(shouldHijackTerminalGesture({ insideTerminalBody: true }), false);
  assert.strictEqual(shouldHijackTerminalGesture({ dataset: { terminalBody: 'true' } }), false);
  assert.strictEqual(shouldHijackTerminalGesture({ closestTerminalViewport: true }), false);
  assert.strictEqual(shouldHijackTerminalGesture({}), true);
  const viewport = { zoom: 1, panX: 0, panY: 0 };
  const guarded = applyPreviewGesture(viewport, {
    type: 'pan',
    deltaX: 10,
    deltaY: 10,
    targetDescriptor: { insideTerminalBody: true },
  });
  assert.strictEqual(guarded, viewport);
});

test('applyPreviewGesture updates pan, zoom, and reset', () => {
  const viewport = { zoom: 1, panX: 0, panY: 0 };
  const panned = applyPreviewGesture(viewport, { type: 'pan', deltaX: 10, deltaY: -5 });
  assert.deepEqual(panned, { zoom: 1, panX: 10, panY: -5 });
  const zoomed = applyPreviewGesture(viewport, { type: 'zoom', zoomFactor: 3 });
  assert.strictEqual(zoomed.zoom, 2.2);
  const zoomedDown = applyPreviewGesture(viewport, { type: 'zoom', zoomFactor: 0.1 });
  assert.strictEqual(zoomedDown.zoom, 0.5);
  assert.deepEqual(applyPreviewGesture(viewport, { type: 'reset' }), { zoom: 1, panX: 0, panY: 0 });
});

test('renderSessionPreviewCanvas exposes zoom/pan controls and enter focus for all members', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] });
  const result = renderSessionPreviewCanvas({ layout });
  assert.ok(result.html.includes('data-component="session-preview-canvas"'));
  assert.ok(result.html.includes('data-zoom="1"'));
  assert.ok(result.html.includes('data-pan-x="0"'));
  assert.ok(result.html.includes('data-action="preview-zoom-in"'));
  assert.ok(result.html.includes('data-action="preview-zoom-out"'));
  assert.ok(result.html.includes('data-action="preview-zoom-reset"'));
  assert.ok(result.html.includes('data-action="enter-member-focus"'));
  assert.ok(result.html.includes('data-member-id="m6"'));
  assert.strictEqual(result.model.memberIds.length, 6);
});

test('focus view orders members and steps with terminal gesture isolation', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  assert.deepEqual(getOrderedSessionMembers(layout), ['m1', 'm2', 'm3']);
  const next = stepFocusedMember(layout, 'next');
  assert.strictEqual(next.focusedMemberId, 'm2');
  assert.strictEqual(next.mobileMode, 'focus');
  assert.strictEqual(next.switched, true);
  const prev = stepFocusedMember(layout, 'prev');
  assert.strictEqual(prev.focusedMemberId, 'm3');
  assert.strictEqual(prev.mobileMode, 'focus');
  const guarded = stepFocusedMember(layout, 'next', { targetDescriptor: { insideTerminalBody: true } });
  assert.strictEqual(guarded.focusedMemberId, 'm1');
  assert.strictEqual(guarded.switched, false);
  assert.strictEqual(guarded.mobileMode, layout.mobileMode);
});

test('focus enter/exit preserves preview viewport', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  layout.previewViewport = { zoom: 1.5, panX: 12, panY: -8 };
  const entered = enterMemberFocus(layout, 'm3');
  assert.strictEqual(entered.mobileMode, 'focus');
  assert.strictEqual(entered.focusedMemberId, 'm3');
  assert.strictEqual(entered.previewViewport, layout.previewViewport);
  const exited = exitMemberFocusToPreview(entered);
  assert.strictEqual(exited.mobileMode, 'preview');
  assert.strictEqual(exited.focusedMemberId, 'm3');
  assert.strictEqual(exited.previewViewport, layout.previewViewport);
});

test('renderSessionFocusView renders one focused window and explicit controls', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2', 'm3'] });
  const focused = enterMemberFocus(layout, 'm2');
  const result = renderSessionFocusView({ layout: focused });
  assert.ok(result.html.includes('data-component="session-focus-view"'));
  assert.ok(result.html.includes('data-focused-member-id="m2"'));
  assert.strictEqual((result.html.match(/data-component="window-frame"/g) || []).length, 1);
  assert.ok(result.html.includes('data-action="focus-prev-member"'));
  assert.ok(result.html.includes('data-action="focus-next-member"'));
  assert.ok(result.html.includes('data-action="return-to-preview"'));
  // Focus frame height is CSS-driven; a hardcoded pixel height clipped mobile viewports.
  assert.ok(result.html.includes('v2-focus-window'));
  assert.ok(!/height:\s*720px/.test(result.html));
  assert.strictEqual(result.model.index, 1);
  assert.strictEqual(result.model.total, 3);
});

test('focus view forwards the real header width so mobile layout matches the rendered frame', () => {
  const layout = createDefaultSessionLayout({ members: ['m1', 'm2'] });
  const focused = enterMemberFocus(layout, 'm1');
  const rendered = [];
  renderSessionFocusView({
    layout: focused,
    renderFrame: (props) => {
      rendered.push(props);
      return { html: '<section class="v2-window-frame"></section>' };
    },
    availableWidth: 372,
  });
  assert.strictEqual(rendered.length, 1);
  assert.strictEqual(rendered[0].availableWidth, 372);
});

test('workspace quick switch keeps active pill and overflows the rest', () => {
  const workspaces = ['ws1', 'ws2', 'ws3', 'ws4', 'ws5'].map((workspaceId) => ({ workspaceId, name: workspaceId.toUpperCase() }));
  const result = renderWorkspaceQuickSwitch({
    workspaces,
    activeWorkspaceId: 'ws3',
    maxVisiblePills: 3,
    overflowOpen: true,
  });
  assert.strictEqual(result.model.visiblePills.length, 3);
  assert.ok(result.model.visiblePills.some((workspace) => workspace.workspaceId === 'ws3'));
  assert.strictEqual(result.model.overflowWorkspaces.length, 2);
  assert.ok(result.html.includes('data-action="toggle-workspace-overflow"'));
  assert.ok(result.html.includes('+2'));
  assert.ok(result.html.includes('data-role="workspace-overflow-popover"'));
});

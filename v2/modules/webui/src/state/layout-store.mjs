import {
  createDefaultSessionLayout,
  reconcileWorkspaceLayout,
  removeStaleMemberSlot,
} from './session-layout.mjs';

export const STORAGE_KEY_PREFIX = 'zterm:v2:session-layout';

function storageKey(accountId, workspaceId) {
  return `${STORAGE_KEY_PREFIX}:${accountId}:${workspaceId}`;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createLayoutStore({ storage = null } = {}) {
  const memoryMap = new Map();

  const readItem = (key) => {
    if (storage && typeof storage.getItem === 'function') {
      const raw = storage.getItem(key);
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    }
    const raw = memoryMap.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  };

  const writeItem = (key, value) => {
    const serialized = JSON.stringify(value);
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(key, serialized);
    } else {
      memoryMap.set(key, serialized);
    }
  };

  const removeItem = (key) => {
    if (storage && typeof storage.removeItem === 'function') {
      storage.removeItem(key);
    } else {
      memoryMap.delete(key);
    }
  };

  const loadLayout = (accountId, workspaceId, currentMembers = []) => {
    const key = storageKey(accountId, workspaceId);
    const saved = readItem(key);
    if (!saved) {
      const created = {
        ...createDefaultSessionLayout({ accountId, workspaceId, members: currentMembers }),
        updatedAt: new Date().toISOString(),
      };
      if (Array.isArray(currentMembers) && currentMembers.some((m) => m && typeof m === 'object')) {
        created.members = currentMembers.map((m) => ({ ...m }));
      }
      return created;
    }
    const reconciled = reconcileWorkspaceLayout({ ...saved, accountId, workspaceId }, currentMembers);
    if (Array.isArray(currentMembers) && currentMembers.some((m) => m && typeof m === 'object')) {
      reconciled.members = currentMembers.map((m) => ({ ...m }));
    }
    return reconciled;
  };

  const saveLayout = (accountIdOrLayout, workspaceId, layoutState) => {
    let resolvedAccountId = accountIdOrLayout;
    let resolvedWorkspaceId = workspaceId;
    let resolvedLayout = layoutState;
    if (accountIdOrLayout && typeof accountIdOrLayout === 'object' && layoutState === undefined) {
      resolvedLayout = accountIdOrLayout;
      resolvedAccountId = resolvedLayout.accountId || 'acc-default';
      resolvedWorkspaceId = resolvedLayout.workspaceId || 'ws-default';
    }
    const layout = cloneJson(resolvedLayout);
    layout.accountId = resolvedAccountId;
    layout.workspaceId = resolvedWorkspaceId;
    layout.updatedAt = new Date().toISOString();
    const key = storageKey(resolvedAccountId, resolvedWorkspaceId);
    writeItem(key, layout);
    return cloneJson(layout);
  };

  const updateLayout = (accountId, workspaceId, updater, currentMembers = []) => {
    if (typeof updater !== 'function') {
      throw new Error('updater must be a function');
    }
    const current = loadLayout(accountId, workspaceId, currentMembers);
    const updated = updater(cloneJson(current));
    if (!updated || typeof updated !== 'object') {
      throw new Error('updater must return a layout object');
    }
    return saveLayout(accountId, workspaceId, updated);
  };

  const removeStaleMember = (accountId, workspaceId, memberId, currentMembers = []) => {
    const current = loadLayout(accountId, workspaceId, currentMembers);
    const updated = removeStaleMemberSlot(current, memberId);
    return saveLayout(accountId, workspaceId, updated);
  };

  const listWorkspaceKeys = () => {
    if (
      storage &&
      typeof storage.length === 'number' &&
      typeof storage.key === 'function'
    ) {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(`${STORAGE_KEY_PREFIX}:`)) {
          keys.push(key.slice(`${STORAGE_KEY_PREFIX}:`.length));
        }
      }
      return keys.sort();
    }
    return Array.from(memoryMap.keys())
      .filter((key) => key.startsWith(`${STORAGE_KEY_PREFIX}:`))
      .map((key) => key.slice(`${STORAGE_KEY_PREFIX}:`.length))
      .sort();
  };

  return {
    loadLayout,
    saveLayout,
    updateLayout,
    removeStaleMember,
    listWorkspaceKeys,
  };
}

export { removeStaleMemberSlot };

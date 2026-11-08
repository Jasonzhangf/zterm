const PROPERTY_KEYS = Object.freeze([
  'role',
  'description',
  'cwd',
  'envSummary',
  'connectionRef',
  'workspaceBinding',
])

function nowIso() {
  return new Date().toISOString()
}

function normalizeTypedError(error, fallbackCode = 'PROPERTY_UNAVAILABLE') {
  if (error && typeof error === 'object') {
    return {
      code: String(error.code || fallbackCode),
      category: String(error.category || 'unavailable'),
      message: String(error.message || 'Property service is unavailable'),
      retryable: error.retryable === true,
      details: error.details ?? null,
    }
  }
  return {
    code: fallbackCode,
    category: 'unavailable',
    message: String(error || 'Property service is unavailable'),
    retryable: false,
    details: null,
  }
}

function loading() {
  return {
    status: 'loading',
    value: null,
    observedAt: null,
    freshness: 'loading',
    error: null,
  }
}

function ready(value) {
  return {
    status: 'ready',
    value,
    observedAt: nowIso(),
    freshness: 'fresh',
    error: null,
  }
}

function unavailable(error) {
  return {
    status: 'unavailable',
    value: null,
    observedAt: nowIso(),
    freshness: 'unavailable',
    error: normalizeTypedError(error),
  }
}

function memberState(memberId) {
  return {
    memberId,
    loadable: loading(),
    draft: null,
    saving: false,
    saveError: null,
    requestSeq: 0,
  }
}

function copyProperties(value) {
  if (!value || typeof value !== 'object') return null
  const result = {}
  for (const key of PROPERTY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key]
  }
  return result
}

export function createPropertyController({ daemonApi = null } = {}) {
  const byMemberId = new Map()
  const openWindowMemberMap = new Map()

  function ensureMember(memberId) {
    if (!byMemberId.has(memberId)) byMemberId.set(memberId, memberState(memberId))
    return byMemberId.get(memberId)
  }

  function snapshotFor(memberId) {
    const state = ensureMember(memberId)
    return {
      memberId,
      loadable: state.loadable,
      propertiesLoadable: state.loadable,
      draft: state.draft ? { ...state.draft } : null,
      saving: state.saving,
      saveError: state.saveError,
      requestSeq: state.requestSeq,
    }
  }

  function openWindowProperties(windowId, memberId) {
    openWindowMemberMap.set(windowId, memberId)
    return getWindowPropertyState(windowId, memberId)
  }

  function closeWindowProperties(windowId) {
    openWindowMemberMap.delete(windowId)
    return { windowId, closed: true }
  }

  async function loadMemberProperties(memberId) {
    const state = ensureMember(memberId)
    state.loadable = loading()
    state.saveError = null
    if (!daemonApi || typeof daemonApi.getMemberProperties !== 'function') {
      state.loadable = unavailable({
        code: 'DAEMON_API_UNAVAILABLE',
        category: 'connection',
        message: 'Daemon API port is not configured.',
        retryable: true,
      })
      return snapshotFor(memberId)
    }
    try {
      const result = await daemonApi.getMemberProperties({ memberId })
      const value = result?.value ?? result?.properties ?? result ?? {}
      state.loadable = ready(value)
      state.draft = copyProperties(value)
    } catch (error) {
      state.loadable = unavailable(error)
    }
    return snapshotFor(memberId)
  }

  function updateDraft(memberId, patch = {}) {
    const state = ensureMember(memberId)
    const next = { ...(state.draft || {}) }
    for (const key of PROPERTY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
    }
    state.draft = next
    state.saveError = null
    return { ...next }
  }

  async function saveMemberProperties(memberId, patch = null) {
    const targetMemberId = memberId
    const state = ensureMember(targetMemberId)
    const effectivePatch = patch == null
      ? { ...(state.draft || {}) }
      : { ...(state.draft || {}), ...patch }
    const requestSeq = state.requestSeq + 1
    state.requestSeq = requestSeq

    if (!daemonApi || typeof daemonApi.updateMemberProperties !== 'function') {
      const typedError = normalizeTypedError({
        code: 'DAEMON_API_UNAVAILABLE',
        category: 'connection',
        message: 'Daemon API port is not configured.',
        retryable: true,
      }, 'DAEMON_API_UNAVAILABLE')
      state.saving = false
      state.saveError = typedError
      state.lastSaveErrorRequestSeq = requestSeq
      return { ...snapshotFor(targetMemberId), ok: false, saved: false, error: typedError }
    }

    state.saving = true
    state.saveError = null

    try {
      const result = await daemonApi.updateMemberProperties({
        memberId: targetMemberId,
        patch: effectivePatch,
      })
      const savedValue = result?.value ?? result?.properties ?? result ?? effectivePatch
      state.loadable = ready(savedValue)
      state.draft = copyProperties(savedValue) || { ...effectivePatch }
      state.saving = false
      state.lastSavedRequestSeq = requestSeq
      return { ...snapshotFor(targetMemberId), ok: true, saved: true }
    } catch (error) {
      const typedError = normalizeTypedError(error, 'PROPERTY_SAVE_FAILED')
      state.saving = false
      state.saveError = typedError
      state.lastSaveErrorRequestSeq = requestSeq
      return { ...snapshotFor(targetMemberId), ok: false, saved: false, error: typedError }
    }
  }

  function getWindowPropertyState(windowId, memberId) {
    const state = ensureMember(memberId)
    return {
      windowId,
      memberId,
      isOpen: openWindowMemberMap.get(windowId) === memberId,
      propertiesLoadable: state.loadable,
      loadable: state.loadable,
      draft: state.draft ? { ...state.draft } : null,
      saving: state.saving,
      saveError: state.saveError,
    }
  }

  function getMemberState(memberId) {
    return snapshotFor(memberId)
  }

  function getOpenWindowMemberId(windowId) {
    return openWindowMemberMap.get(windowId) ?? null
  }

  return {
    byMemberId,
    openWindowMemberMap,
    openWindowProperties,
    closeWindowProperties,
    loadMemberProperties,
    updateDraft,
    saveMemberProperties,
    getWindowPropertyState,
    getMemberState,
    getOpenWindowMemberId,
  }
}

export { PROPERTY_KEYS, normalizeTypedError }

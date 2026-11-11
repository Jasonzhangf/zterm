export const GLOBAL_ROUTES = Object.freeze(['setup', 'connections', 'workspaces'])
export const WORKSPACE_ROUTES = Object.freeze(['sessions', 'board', 'tickets'])
export const ROUTES = Object.freeze([...GLOBAL_ROUTES, ...WORKSPACE_ROUTES])

function stripHash(path) {
  if (typeof path !== 'string') return ''
  const hashIndex = path.indexOf('#')
  return hashIndex >= 0 ? path.slice(hashIndex + 1) : path
}

function normalizeSegment(segment) {
  return String(segment || '').replace(/^\/+|\/+$/g, '')
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch {
    return String(value || '')
  }
}

export function isWorkspaceScopedRoute(route) {
  return WORKSPACE_ROUTES.includes(route)
}

export function isGlobalRoute(route) {
  return GLOBAL_ROUTES.includes(route)
}

export function parseNavigationTarget(
  hashOrPath,
  { fallbackRoute = 'setup', fallbackWorkspaceId = null } = {},
) {
  const raw = stripHash(hashOrPath)
  const [rawPath = '', rawQuery = ''] = raw.split('?')
  const normalizedPath = normalizeSegment(rawPath)
  const queryParams = new URLSearchParams(rawQuery)
  const queryWorkspaceId = queryParams.get('workspaceId') || queryParams.get('workspace') || null

  if (!normalizedPath) {
    const scope = isWorkspaceScopedRoute(fallbackRoute) ? 'workspace' : 'global'
    return {
      route: fallbackRoute,
      workspaceId: queryWorkspaceId ?? fallbackWorkspaceId,
      scope,
      explicitWorkspace: Boolean(queryWorkspaceId),
    }
  }

  const parts = normalizedPath.split('/').filter(Boolean).map(safeDecode)

  // Pattern 1: /workspaces/<workspaceId>/<workspaceRoute> or /workspaces/<workspaceId>
  if (parts[0] === 'workspaces' && parts.length >= 2) {
    const workspaceId = parts[1] || null
    const subRoute = parts[2] || 'sessions'
    if (WORKSPACE_ROUTES.includes(subRoute)) {
      return {
        route: subRoute,
        workspaceId,
        scope: 'workspace',
        explicitWorkspace: Boolean(workspaceId),
      }
    }
    if (parts.length === 2 && workspaceId) {
      return {
        route: 'sessions',
        workspaceId,
        scope: 'workspace',
        explicitWorkspace: true,
      }
    }
  }

  // Pattern 2: /<workspaceRoute>/<workspaceId>
  if (WORKSPACE_ROUTES.includes(parts[0]) && parts.length >= 2) {
    const workspaceId = parts[1] || queryWorkspaceId || fallbackWorkspaceId
    return {
      route: parts[0],
      workspaceId,
      scope: 'workspace',
      explicitWorkspace: Boolean(parts[1] || queryWorkspaceId),
    }
  }

  // Pattern 3: /<route>
  if (ROUTES.includes(parts[0])) {
    const route = parts[0]
    const scope = isWorkspaceScopedRoute(route) ? 'workspace' : 'global'
    return {
      route,
      workspaceId: queryWorkspaceId ?? fallbackWorkspaceId,
      scope,
      explicitWorkspace: Boolean(queryWorkspaceId),
    }
  }

  const fallbackScope = isWorkspaceScopedRoute(fallbackRoute) ? 'workspace' : 'global'
  return {
    route: fallbackRoute,
    workspaceId: queryWorkspaceId ?? fallbackWorkspaceId,
    scope: fallbackScope,
    explicitWorkspace: Boolean(queryWorkspaceId),
  }
}

export function resolveRoute(hashOrPath, fallbackRoute = 'setup') {
  return parseNavigationTarget(hashOrPath, { fallbackRoute }).route
}

export function routeUrl(route, workspaceId = null) {
  const normalizedRoute = ROUTES.includes(route) ? route : 'setup'
  if (isWorkspaceScopedRoute(normalizedRoute) && workspaceId) {
    return `#/workspaces/${encodeURIComponent(String(workspaceId))}/${normalizedRoute}`
  }
  return `#/${normalizedRoute}`
}

export function isPublicRoute(route) {
  return ROUTES.includes(route)
}

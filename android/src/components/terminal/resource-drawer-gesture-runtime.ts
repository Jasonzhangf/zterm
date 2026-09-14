export const RESOURCE_DRAWER_GESTURE_ATTRS = {
  page: 'data-resource-drawer-page',
  scope: 'data-resource-drawer-scope',
  handle: 'data-resource-drawer-handle',
} as const;

export const RESOURCE_DRAWER_GESTURE_PAGE_IDS = {
  backdrop: 'drawer.backdrop',
  shell: 'drawer.shell',
  files: 'drawer.files',
  web: 'drawer.web',
  stream: 'drawer.stream',
  toolbar: 'drawer.toolbar',
} as const;

export const RESOURCE_DRAWER_GESTURE_SCOPE_IDS = {
  drawerShell: 'drawer-shell',
  drawerContentPage: 'drawer-content-page',
  remoteWindowSurface: 'remote-window',
  toolbar: 'drawer-toolbar',
} as const;

export const RESOURCE_DRAWER_GESTURE_THRESHOLD_PX = 64;

export type ResourceDrawerGesturePageId =
  (typeof RESOURCE_DRAWER_GESTURE_PAGE_IDS)[keyof typeof RESOURCE_DRAWER_GESTURE_PAGE_IDS];

export type ResourceDrawerGestureScopeId =
  (typeof RESOURCE_DRAWER_GESTURE_SCOPE_IDS)[keyof typeof RESOURCE_DRAWER_GESTURE_SCOPE_IDS];

export type ResourceDrawerGestureCapability = 'drag' | 'consume';

export interface ResourceDrawerGestureContext {
  pageId: ResourceDrawerGesturePageId;
  scopeId: ResourceDrawerGestureScopeId;
  isHandle: boolean;
  capability: ResourceDrawerGestureCapability;
}

export type ResourceDrawerGestureStartOutcome =
  | { kind: 'ignored' }
  | { kind: 'accepted' }
  | { kind: 'consumed' };

export type ResourceDrawerGestureEndAction = 'close' | 'expand' | 'none';

function toElement(target: EventTarget | null): Element | null {
  return typeof Element !== 'undefined' && target instanceof Element ? target : null;
}

export function resolveResourceDrawerGestureContext(target: EventTarget | null): ResourceDrawerGestureContext | null {
  const element = toElement(target);
  if (!element) {
    return null;
  }

  const scoped = element.closest<HTMLElement>(
    `[${RESOURCE_DRAWER_GESTURE_ATTRS.page}][${RESOURCE_DRAWER_GESTURE_ATTRS.scope}]`,
  );
  if (!scoped) {
    return null;
  }

  const pageId = scoped.getAttribute(RESOURCE_DRAWER_GESTURE_ATTRS.page) as ResourceDrawerGesturePageId | null;
  const scopeId = scoped.getAttribute(RESOURCE_DRAWER_GESTURE_ATTRS.scope) as ResourceDrawerGestureScopeId | null;
  if (!pageId || !scopeId) {
    return null;
  }

  const isHandle = element.closest(`[${RESOURCE_DRAWER_GESTURE_ATTRS.handle}="true"]`) !== null;

  return {
    pageId,
    scopeId,
    isHandle,
    capability: scopeId === RESOURCE_DRAWER_GESTURE_SCOPE_IDS.drawerShell && isHandle ? 'drag' : 'consume',
  };
}

export function resolveResourceDrawerGestureEndAction(
  deltaY: number,
): ResourceDrawerGestureEndAction {
  if (deltaY > RESOURCE_DRAWER_GESTURE_THRESHOLD_PX) {
    return 'close';
  }
  if (deltaY < -RESOURCE_DRAWER_GESTURE_THRESHOLD_PX) {
    return 'expand';
  }
  return 'none';
}

export function createResourceDrawerGestureRuntime() {
  let active: {
    key: string;
    context: ResourceDrawerGestureContext;
    startY: number;
  } | null = null;

  return {
    start(
      key: string,
      context: ResourceDrawerGestureContext | null,
      clientY: number,
    ): ResourceDrawerGestureStartOutcome {
      if (!context || (active !== null && active.key !== key)) {
        return { kind: 'ignored' };
      }

      active = { key, context, startY: clientY };
      return context.capability === 'drag' ? { kind: 'accepted' } : { kind: 'consumed' };
    },

    end(key: string, clientY: number): ResourceDrawerGestureEndAction {
      if (!active || active.key !== key || active.context.capability !== 'drag') {
        active = active?.key === key ? null : active;
        return 'none';
      }

      const action = resolveResourceDrawerGestureEndAction(clientY - active.startY);
      active = null;
      return action;
    },

    cancel(key: string) {
      if (active?.key === key) {
        active = null;
      }
    },

    clear() {
      active = null;
    },

    isActive(key?: string) {
      return active !== null && (key === undefined || active.key === key);
    },
  };
}

export type ResourceDrawerGestureRuntime = ReturnType<typeof createResourceDrawerGestureRuntime>;

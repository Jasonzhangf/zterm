export type SessionGroupBoundarySlotName = 'before' | 'center' | 'after';

export interface SessionGroupBoundarySlots<T> {
  before: T | null;
  center: T | null;
  after: T | null;
}

export interface SessionGroupBoundaryProjection<T> {
  slots: SessionGroupBoundarySlots<T>;
  visible: {
    before: boolean;
    after: boolean;
  };
}

export function resolveSessionGroupBoundaryProjection<T>(
  current: SessionGroupBoundarySlots<T>,
  focusSlot: SessionGroupBoundarySlotName,
): SessionGroupBoundaryProjection<T> {
  switch (focusSlot) {
    case 'before':
      return {
        slots: {
          before: null,
          center: current.before,
          after: current.center,
        },
        visible: {
          before: false,
          after: true,
        },
      };
    case 'after':
      return {
        slots: {
          before: current.center,
          center: current.after,
          after: null,
        },
        visible: {
          before: true,
          after: false,
        },
      };
    case 'center':
    default:
      return {
        slots: current,
        visible: {
          before: true,
          after: true,
        },
      };
  }
}

export type TerminalSessionGroupSlotName = 'top' | 'center' | 'bottom';

export interface TerminalSessionGroupSlotIds<T = string> {
  top: T | null;
  center: T | null;
  bottom: T | null;
}

export interface TerminalSessionGroupViewportProjection<T> {
  slots: TerminalSessionGroupSlotIds<T>;
  visible: {
    top: boolean;
    bottom: boolean;
  };
}

function toBoundarySlotName(slot: TerminalSessionGroupSlotName): SessionGroupBoundarySlotName {
  switch (slot) {
    case 'top':
      return 'before';
    case 'bottom':
      return 'after';
    case 'center':
    default:
      return 'center';
  }
}

function fromBoundarySlots<T>(slots: SessionGroupBoundarySlots<T>): TerminalSessionGroupSlotIds<T> {
  return {
    top: slots.before,
    center: slots.center,
    bottom: slots.after,
  };
}

export function resolveTerminalSessionGroupViewportProjection<T>(
  current: TerminalSessionGroupSlotIds<T>,
  focusSlot: TerminalSessionGroupSlotName,
): TerminalSessionGroupViewportProjection<T> {
  const projection = resolveSessionGroupBoundaryProjection(
    {
      before: current.top,
      center: current.center,
      after: current.bottom,
    },
    toBoundarySlotName(focusSlot),
  );

  return {
    slots: fromBoundarySlots(projection.slots),
    visible: {
      top: projection.visible.before,
      bottom: projection.visible.after,
    },
  };
}

export function resolveTerminalSessionGroupViewportSlots<T>(
  current: TerminalSessionGroupSlotIds<T>,
  focusSlot: TerminalSessionGroupSlotName,
): TerminalSessionGroupSlotIds<T> {
  return resolveTerminalSessionGroupViewportProjection(current, focusSlot).slots;
}

export function resolveTerminalSessionGroupSlotReplacement<T extends string>(
  current: TerminalSessionGroupSlotIds<T>,
  sessionId: T,
  targetSlot: TerminalSessionGroupSlotName,
): TerminalSessionGroupSlotIds<T> {
  const next: TerminalSessionGroupSlotIds<T> = {
    top: current.top === sessionId ? null : current.top,
    center: current.center === sessionId ? null : current.center,
    bottom: current.bottom === sessionId ? null : current.bottom,
  };
  next[targetSlot] = sessionId;
  return next;
}

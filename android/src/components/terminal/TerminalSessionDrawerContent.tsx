import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  DRAWER_WIDTH,
  DRAWER_MAX_WIDTH,
  SWIPE_CLOSE_THRESHOLD_PX,
  SWIPE_CLOSE_VERTICAL_TOLERANCE_PX,
  DRAWER_TOUCH_TARGET_PX,
  UNSCOPED_HOST_GROUP_KEY,
  UNSCOPED_HOST_GROUP_LABEL,
  describeAgentState,
  describeCollabRole,
  resolveSessionGroupSlotTone,
  shortenFolderLabel,
} from './terminal-session-drawer-helpers';
import { TerminalSessionDrawerFolderMenu } from './TerminalSessionDrawerFolderMenu';
import {
  DrawerCloseIcon,
  DrawerChevronIcon,
  DrawerFolderIcon,
  DrawerMoreIcon,
  DrawerRestoreIcon,
} from './TerminalSessionDrawerIcons';
import { TerminalSessionDrawerNewSessionDialog } from './TerminalSessionDrawerNewSessionDialog';
import { TerminalSessionDrawerSlotMenu } from './TerminalSessionDrawerSlotMenu';
import { getServerIdentityTone } from '../../lib/server-identity';
import { AmbientButton } from '../ambient';
import type {
  TerminalSessionDrawerItem,
  TerminalSessionDrawerProps,
} from '../../lib/plugin-session-drawer/session-drawer-contract';
import {
  classifySessionDrawerVisibility,
  SESSION_DRAWER_FILTER_LABELS,
  SESSION_DRAWER_FILTER_MODES,
} from '../../lib/plugin-session-drawer/session-drawer-visibility';
export const TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX = 56;
export const TERMINAL_SESSION_DRAWER_ROW_TITLE_FONT_SIZE_PX = 13;
export const TERMINAL_SESSION_DRAWER_ROW_SUBTITLE_FONT_SIZE_PX = 11;

type DrawerToneStyle = { color: string; background: string; border: string };

const DRAWER_TONE_STYLES: Record<string, DrawerToneStyle> = {
  success: {
    color: 'var(--zterm-settings-success)',
    background: 'var(--zterm-settings-success-soft)',
    border: 'var(--zterm-settings-success)',
  },
  warning: {
    color: 'var(--zterm-settings-warning)',
    background: 'var(--zterm-settings-warning-soft)',
    border: 'var(--zterm-settings-warning)',
  },
  accent: {
    color: 'var(--zterm-panel-accent)',
    background: 'var(--zterm-panel-accent-soft)',
    border: 'var(--zterm-panel-accent-border)',
  },
  danger: {
    color: 'var(--zterm-panel-danger)',
    background: 'var(--zterm-panel-danger-soft)',
    border: 'var(--zterm-panel-danger-border)',
  },
  neutral: {
    color: 'var(--zterm-panel-muted)',
    background: 'var(--zterm-panel-surface)',
    border: 'var(--zterm-panel-border)',
  },
  unclassified: {
    color: 'var(--zterm-panel-muted)',
    background: 'transparent',
    border: 'var(--zterm-panel-border)',
  },
};

function drawerToneStyle(tone: string): DrawerToneStyle {
  return DRAWER_TONE_STYLES[tone] ?? DRAWER_TONE_STYLES.neutral;
}
export function terminalSessionDrawerHiddenRestoreTestId(sessionName: string): string {
  const safeName = sessionName
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'session';
  return `terminal-session-drawer-restore-hidden-${safeName}`;
}
export type {
  TerminalSessionDrawerHost,
  TerminalSessionDrawerItem,
  TerminalSessionDrawerProps,
  TerminalSessionGroupLayoutAxis,
  TerminalSessionGroupSlotName,
} from '../../lib/plugin-session-drawer/session-drawer-contract';
function TerminalSessionDrawerComponent({
  open,
  topInsetPx = 0,
  bottomInsetPx = 0,
  sessions,
  unfilteredSessions = [],
  hosts = [],
  onClose,
  onSelectSession,
  onCloseSession,
  onAssignSessionGroupSlot,
  sessionGroupLayoutAxis = 'vertical',
  onOpenQuickTabPicker,
  onDebugAddEvent,
  onHideSession,
  onRestoreAllHiddenSessions,
  hostSummaries = [],
  hiddenSessionCount = 0,
  hiddenSessionNames = [],
  onRestoreHiddenSession,
  unfilteredSessionCount,
  filterMode,
  onFilterModeChange,
  terminalShellSkin = 'light',
}: TerminalSessionDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const folderPointerGestureRef = useRef(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnTargetRef = useRef<HTMLElement | null>(null);
  const suppressNextClickRef = useRef(false);
  const selectionPressRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const [slotMenu, setSlotMenu] = useState<{
    sessionId: string;
    title: string;
    x: number;
    y: number;
    anchorTop?: number;
  } | null>(null);
  const [newSessionDraft, setNewSessionDraft] = useState<{
    hostKey?: string;
    sessionName: string;
    cwd: string;
    terminalBackend: 'tmux' | 'herdr';
  } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ cwd: string; x: number; y: number } | null>(null);
  const [hiddenTrayExpanded, setHiddenTrayExpanded] = useState(false);
  const isDrawerChromeElement = (element: Element | null) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    return Boolean(drawerRef.current?.contains(element) || overlayRef.current === element);
  };
  const restoreFocusOutsideDrawer = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !isDrawerChromeElement(activeElement)) {
      return;
    }
    const returnTarget = focusReturnTargetRef.current;
    const canRestore = (
      returnTarget?.isConnected
      && !isDrawerChromeElement(returnTarget)
      && !returnTarget.closest('[inert], [aria-hidden="true"]')
    );
    if (canRestore) {
      returnTarget.focus({ preventScroll: true });
      if (!isDrawerChromeElement(document.activeElement)) {
        return;
      }
    }
    activeElement.blur();
  };
  const requestCloseDrawer = () => {
    restoreFocusOutsideDrawer();
    onClose();
  };
  useEffect(() => {
    if (open) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && !isDrawerChromeElement(activeElement)) {
        focusReturnTargetRef.current = activeElement;
      }
      closeButtonRef.current?.focus({ preventScroll: true });
    }
  }, [open]);
  const buildDefaultSessionName = () => {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    return `zterm-${stamp}`;
  };
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const activateCloseSession = (sessionId: string) => {
    clearLongPressTimer();
    restoreFocusOutsideDrawer();
    onCloseSession(sessionId);
  };
  const openSlotMenu = (session: TerminalSessionDrawerItem, x: number, y: number, anchorTop?: number) => {
    if (!onAssignSessionGroupSlot && !onHideSession && !onCloseSession) {
      return;
    }
    setSlotMenu({
      sessionId: session.id,
      title: session.title,
      x,
      y,
      anchorTop,
    });
  };
  const describeEventTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return 'unknown';
    }
    const testIdOwner = target.closest('[data-testid]') as HTMLElement | null;
    if (testIdOwner?.dataset.testid) {
      return testIdOwner.dataset.testid;
    }
    if (target.dataset.testid) {
      return target.dataset.testid;
    }
    return target.tagName.toLowerCase();
  };
  const hostGroups = useMemo(() => {
    const groups = new Map<
      string,
      { groupKey: string; hostKey?: string; hostLabel: string; connected?: boolean; sessions: TerminalSessionDrawerItem[] }
    >();
    for (const host of hosts) {
      const hostKey = host.hostKey.trim();
      if (!hostKey) {
        continue;
      }
      groups.set(hostKey, {
        groupKey: hostKey,
        hostKey,
        hostLabel: host.hostLabel.trim() || hostKey,
        connected: host.connected,
        sessions: [],
      });
    }
    for (const session of unfilteredSessions) {
      const hostKey = session.hostKey;
      if (!hostKey) {
        if (!groups.has(UNSCOPED_HOST_GROUP_KEY)) {
          groups.set(UNSCOPED_HOST_GROUP_KEY, {
            groupKey: UNSCOPED_HOST_GROUP_KEY,
            hostLabel: session.hostLabel?.trim() || UNSCOPED_HOST_GROUP_LABEL,
            sessions: [],
          });
        }
        continue;
      }
      if (!groups.has(hostKey)) {
        groups.set(hostKey, {
          groupKey: hostKey,
          hostKey,
          hostLabel: session.hostLabel || hostKey,
          sessions: [],
        });
      }
    }
    for (const session of sessions) {
      const hostKey = session.hostKey;
      if (!hostKey) {
        let group = groups.get(UNSCOPED_HOST_GROUP_KEY);
        if (!group) {
          group = {
            groupKey: UNSCOPED_HOST_GROUP_KEY,
            hostLabel: session.hostLabel?.trim() || UNSCOPED_HOST_GROUP_LABEL,
            sessions: [],
          };
          groups.set(UNSCOPED_HOST_GROUP_KEY, group);
        }
        group.sessions.push(session);
        continue;
      }
      const hostLabel = session.hostLabel || hostKey;
      let group = groups.get(hostKey);
      if (!group) {
        group = { groupKey: hostKey, hostKey, hostLabel, sessions: [] };
        groups.set(hostKey, group);
      }
      group.sessions.push(session);
    }
    return Array.from(groups.values());
  }, [hosts, sessions, unfilteredSessions]);
  const showHostRail = hostGroups.length > 0;
  const multiHost = hostGroups.length > 1;
  const [selectedHostKey, setSelectedHostKey] = useState<string | null>(null);
  const effectiveHostKey = useMemo(() => {
    if (selectedHostKey && hostGroups.some((g) => g.groupKey === selectedHostKey)) {
      return selectedHostKey;
    }
    const activeConnectedGroup = hostGroups.find((g) => (
      g.connected !== false && g.sessions.some((s) => s.active)
    ));
    if (activeConnectedGroup) {
      return activeConnectedGroup.groupKey;
    }
    const activeUnfilteredConnectedGroup = hostGroups.find((g) => (
      g.connected !== false
      && unfilteredSessions.some((s) => s.active && (s.hostKey || UNSCOPED_HOST_GROUP_KEY) === g.groupKey)
    ));
    if (activeUnfilteredConnectedGroup) {
      return activeUnfilteredConnectedGroup.groupKey;
    }
    const connectedGroup = hostGroups.find((g) => g.connected === true);
    if (connectedGroup) {
      return connectedGroup.groupKey;
    }
    const activeGroup = hostGroups.find((g) => g.sessions.some((s) => s.active))
      || hostGroups.find((g) => unfilteredSessions.some((s) => s.active && (s.hostKey || UNSCOPED_HOST_GROUP_KEY) === g.groupKey));
    return activeGroup?.groupKey || hostGroups[0]?.groupKey || null;
  }, [hostGroups, selectedHostKey, unfilteredSessions]);
  const selectedHostSummary = useMemo(() => {
    if (!effectiveHostKey) {
      return null;
    }
    return hostSummaries?.find((summary) => summary.hostKey === effectiveHostKey) ?? null;
  }, [effectiveHostKey, hostSummaries]);
  const visibleSessions = useMemo(() => {
    if (!effectiveHostKey) {
      return sessions;
    }
    const group = hostGroups.find((g) => g.groupKey === effectiveHostKey);
    return group?.sessions || [];
  }, [effectiveHostKey, hostGroups, sessions]);
  const visibleUnfilteredSessions = useMemo(() => {
    if (!unfilteredSessions || unfilteredSessions.length === 0) {
      return [];
    }
    if (!effectiveHostKey) {
      return unfilteredSessions;
    }
    return unfilteredSessions.filter((session) => (session.hostKey || UNSCOPED_HOST_GROUP_KEY) === effectiveHostKey);
  }, [effectiveHostKey, unfilteredSessions]);
  const activeFilterMode = filterMode ?? 'all';
  // Total sessions before drawer filtering. When the prop is absent, fall back
  // to the rows we have plus hidden ones so states stay truthful.
  const totalSessionCount = unfilteredSessionCount ?? sessions.length + hiddenSessionCount;
  // Truthful per-mode counts for the segmented control. Counts are scoped to
  // the selected host's non-hidden sessions and fall back to the visible rows
  // when the caller does not project an unfiltered list. A session without a
  // Collab projection counts as visible outside "仅 Master" and is never
  // silently dropped.
  const segmentCounts = useMemo(() => {
    const scope = visibleUnfilteredSessions.length > 0 ? visibleUnfilteredSessions : visibleSessions;
    let master = 0;
    let nonWorker = 0;
    for (const session of scope) {
      const sessionClass = classifySessionDrawerVisibility(session.collab);
      if (sessionClass === 'master') {
        master += 1;
      }
      if (sessionClass !== 'worker') {
        nonWorker += 1;
      }
    }
    return {
      all: scope.length,
      'only-master': master,
      'hide-worker': nonWorker,
    } satisfies Record<(typeof SESSION_DRAWER_FILTER_MODES)[number], number>;
  }, [visibleSessions, visibleUnfilteredSessions]);
  const hasHostScopedSummaries = hostSummaries.length > 0;
  // Empty-state truth belongs to the selected host. A persisted hidden name on
  // another host is still restorable from the tray, but it is never a live
  // session and never an all-hidden claim for this host.
  const hasKnownSessions = hasHostScopedSummaries
    ? (selectedHostSummary?.unfilteredSessionCount ?? 0) > 0
    : unfilteredSessionCount !== undefined
      ? unfilteredSessionCount > 0
      : sessions.length > 0 || hiddenSessionCount > 0;
  const hostHiddenCount = hasHostScopedSummaries
    ? (selectedHostSummary?.hiddenSessionCount ?? 0)
    : hiddenSessionCount;
  const cwdGroups = useMemo(() => {
    interface DrawerFolder {
      cwd: string;
      /** Primary rows rendered by default for this project folder. */
      items: TerminalSessionDrawerItem[];
      /** Unclassified sessions kept visible (with an explicit 未识别 marker). */
      unclassifiedItems: TerminalSessionDrawerItem[];
      /** Role-filtered sessions revealed on demand behind "+N 窗口". */
      otherItems: TerminalSessionDrawerItem[];
    }
    const groups = new Map<string, DrawerFolder>();
    const ensureFolder = (cwd: string): DrawerFolder => {
      let folder = groups.get(cwd);
      if (!folder) {
        folder = { cwd, items: [], unclassifiedItems: [], otherItems: [] };
        groups.set(cwd, folder);
      }
      return folder;
    };
    for (const session of visibleSessions) {
      ensureFolder(session.cwd?.trim() || 'cwd 未知').items.push(session);
    }
    if (activeFilterMode === 'only-master' && visibleUnfilteredSessions.length > 0) {
      const visibleIds = new Set(visibleSessions.map((session) => session.id));
      const othersByCwd = new Map<string, TerminalSessionDrawerItem[]>();
      for (const session of visibleUnfilteredSessions) {
        if (visibleIds.has(session.id)) {
          continue;
        }
        const cwd = session.cwd?.trim() || 'cwd 未知';
        const folder = ensureFolder(cwd);
        if (classifySessionDrawerVisibility(session.collab) === 'unclassified') {
          folder.unclassifiedItems.push(session);
        } else {
          const others = othersByCwd.get(cwd) || [];
          others.push(session);
          othersByCwd.set(cwd, others);
        }
      }
      for (const [cwd, others] of othersByCwd) {
        ensureFolder(cwd).otherItems.push(...others);
      }
    }
    const roleRank = (role?: string) => (role === 'ceo' ? 0 : role === 'master' ? 1 : 2);
    const entries = Array.from(groups.values()).map((folder) => ({
      ...folder,
      items: [...folder.items].sort((a, b) => roleRank(a.collab?.role) - roleRank(b.collab?.role)),
      otherItems: [...folder.otherItems].sort((a, b) => roleRank(a.collab?.role) - roleRank(b.collab?.role)),
      unclassifiedItems: [...folder.unclassifiedItems].sort((a, b) => a.title.localeCompare(b.title)),
    }));
    return entries.sort((a, b) => {
      const folderHasCeo = (folder: typeof a) => (
        folder.items.some((s) => s.collab?.role === 'ceo')
        || folder.otherItems.some((s) => s.collab?.role === 'ceo')
        || folder.unclassifiedItems.some((s) => s.collab?.role === 'ceo')
      );
      const folderHasActive = (folder: typeof a) => (
        folder.items.some((s) => s.active)
        || folder.otherItems.some((s) => s.active)
        || folder.unclassifiedItems.some((s) => s.active)
      );
      const folderHasMaster = (folder: typeof a) => (
        folder.items.some((s) => s.collab?.role === 'master')
        || folder.otherItems.some((s) => s.collab?.role === 'master')
      );
      const aCeo = folderHasCeo(a) ? 0 : 1;
      const bCeo = folderHasCeo(b) ? 0 : 1;
      if (aCeo !== bCeo) {
        return aCeo - bCeo;
      }
      const aActive = folderHasActive(a) ? 0 : 1;
      const bActive = folderHasActive(b) ? 0 : 1;
      if (aActive !== bActive) {
        return aActive - bActive;
      }
      const aUnknown = a.cwd === 'cwd 未知' ? 1 : 0;
      const bUnknown = b.cwd === 'cwd 未知' ? 1 : 0;
      if (aUnknown !== bUnknown) {
        return aUnknown - bUnknown;
      }
      const aMaster = folderHasMaster(a) ? 0 : 1;
      const bMaster = folderHasMaster(b) ? 0 : 1;
      if (aMaster !== bMaster) {
        return aMaster - bMaster;
      }
      return shortenFolderLabel(a.cwd).localeCompare(shortenFolderLabel(b.cwd), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [activeFilterMode, visibleSessions, visibleUnfilteredSessions]);
  const activeFolderCwd = cwdGroups.find((group) => (
    group.items.some((session) => session.active)
    || group.otherItems.some((session) => session.active)
    || group.unclassifiedItems.some((session) => session.active)
  ))?.cwd
    || cwdGroups[0]?.cwd
    || null;
  const [expandedFolderCwd, setExpandedFolderCwd] = useState<string | null>(activeFolderCwd);
  const [collapsedMasterFolders, setCollapsedMasterFolders] = useState<Set<string>>(() => new Set());
  const [expandedOtherFoldersInMasterMode, setExpandedOtherFoldersInMasterMode] = useState<Set<string>>(() => new Set());
  // Rows the list actually paints: primary rows plus explicit unclassified
  // rows. Role-filtered rows count only after the user opens "+N 窗口".
  const displayedSessionCount = useMemo(
    () => cwdGroups.reduce((total, folder) => {
      const showsOthers = activeFilterMode === 'only-master'
        && expandedOtherFoldersInMasterMode.has(folder.cwd);
      return total
        + folder.items.length
        + folder.unclassifiedItems.length
        + (showsOthers ? folder.otherItems.length : 0);
    }, 0),
    [activeFilterMode, cwdGroups, expandedOtherFoldersInMasterMode],
  );

  useEffect(() => {
    setExpandedFolderCwd((current) => (
      current && cwdGroups.some((group) => group.cwd === current)
        ? current
        : activeFolderCwd
    ));
  }, [activeFolderCwd, cwdGroups]);
  useEffect(() => {
    if (activeFilterMode !== 'only-master') {
      setCollapsedMasterFolders((current) => (current.size === 0 ? current : new Set()));
      setExpandedOtherFoldersInMasterMode((current) => (current.size === 0 ? current : new Set()));
    }
  }, [activeFilterMode]);
  const currentHostGroup = useMemo(() => {
    if (!multiHost) {
      return hostGroups[0] || null;
    }
    return hostGroups.find((g) => g.groupKey === effectiveHostKey) || hostGroups[0] || null;
  }, [effectiveHostKey, hostGroups, multiHost]);
  useEffect(() => {
    selectionPressRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!folderMenu && !slotMenu) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFolderMenu(null);
        setSlotMenu(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [folderMenu, slotMenu]);

  const openNewSessionDialog = () => {
    const hostBackend = currentHostGroup?.sessions.find((s) => s.terminalBackend)?.terminalBackend;
    setNewSessionDraft({
      hostKey: currentHostGroup?.hostKey,
      sessionName: buildDefaultSessionName(),
      cwd: '~/',
      terminalBackend: hostBackend ?? 'tmux',
    });
  };

  const confirmNewSession = () => {
    const sessionName = newSessionDraft?.sessionName.trim() || '';
    const cwd = newSessionDraft?.cwd.trim() || '~/';
    if (!newSessionDraft || !sessionName) {
      return;
    }
    onOpenQuickTabPicker(newSessionDraft.hostKey, { sessionName, cwd, terminalBackend: newSessionDraft.terminalBackend });
    setNewSessionDraft(null);
  };

  const renderSessionRow = (session: TerminalSessionDrawerItem) => {
    const slotTone = resolveSessionGroupSlotTone(session.sessionGroupSlot, sessionGroupLayoutAxis);
    const role = describeCollabRole(session.collab?.role);
    const roleTone = drawerToneStyle(role.tone);
    const agent = describeAgentState(session.collab?.agentState);
    const agentTone = agent ? drawerToneStyle(agent.tone) : null;
    return (
      <div
        key={session.stableKey}
        role="treeitem"
        aria-level={3}
        data-tree-level="3"
        data-active={session.active ? 'true' : 'false'}
        data-testid={`terminal-session-drawer-row-${session.id}`}
        data-terminal-backend={session.terminalBackend ?? 'tmux'}
        onContextMenu={(event) => {
          event.preventDefault();
          setFolderMenu(null);
          suppressNextClickRef.current = true;
          openSlotMenu(session, event.clientX, event.clientY);
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (!touch) {
            return;
          }
          clearLongPressTimer();
          longPressTimerRef.current = window.setTimeout(() => {
            longPressTimerRef.current = null;
            setFolderMenu(null);
            suppressNextClickRef.current = true;
            openSlotMenu(session, touch.clientX, touch.clientY);
          }, 420);
        }}
        onTouchMove={clearLongPressTimer}
        onTouchEnd={clearLongPressTimer}
        onTouchCancel={clearLongPressTimer}
        style={{
          minHeight: `${TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX}px`,
          width: '100%',
          padding: 0,
          margin: '1px 0',
          borderRadius: '10px',
          border: slotTone ? `1px solid ${slotTone.border}` : '1px solid transparent',
          background: slotTone
            ? slotTone.background
            : session.active
              ? 'var(--zterm-panel-active)'
              : 'transparent',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          alignItems: 'stretch',
          columnGap: '2px',
          color: 'var(--zterm-panel-text)',
          opacity: 1,
          overflow: 'visible',
          position: 'relative',
          boxShadow: session.active && !slotTone
            ? 'inset 3px 0 0 var(--zterm-panel-accent)'
            : 'none',
        }}
      >
        <AmbientButton
          type="button"
          data-amb-flat="true"
          data-testid={`terminal-session-drawer-select-${session.id}`}
          onMouseDown={(event) => {
            selectionPressRef.current = {
              sessionId: session.id,
              x: event.clientX,
              y: event.clientY,
            };
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            if (!touch) {
              selectionPressRef.current = null;
              return;
            }
            selectionPressRef.current = {
              sessionId: session.id,
              x: touch.clientX,
              y: touch.clientY,
            };
          }}
          onTouchMove={(event) => {
            const press = selectionPressRef.current;
            const touch = event.touches[0];
            if (
              !press
              || press.sessionId !== session.id
              || !touch
              || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 8
            ) {
              selectionPressRef.current = null;
            }
          }}
          onTouchCancel={() => {
            if (selectionPressRef.current?.sessionId === session.id) {
              selectionPressRef.current = null;
            }
          }}
          onClick={(event) => {
            event.stopPropagation();
            const pointerClick = event.detail > 0;
            const pressStartedOnThisRow = selectionPressRef.current?.sessionId === session.id;
            selectionPressRef.current = null;
            if (pointerClick && !pressStartedOnThisRow) {
              event.preventDefault();
              return;
            }
            if (suppressNextClickRef.current) {
              event.preventDefault();
              suppressNextClickRef.current = false;
              return;
            }
            onSelectSession(session.id);
          }}
          style={{
            height: '100%',
            minHeight: `${TERMINAL_SESSION_DRAWER_ROW_MIN_HEIGHT_PX}px`,
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            padding: '9px 4px 9px 14px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'stretch',
            gap: '3px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span
              title={session.title}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: `${TERMINAL_SESSION_DRAWER_ROW_TITLE_FONT_SIZE_PX}px`,
                fontWeight: 700,
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {session.title}
            </span>
            {slotTone ? (
              <span
                data-testid={`terminal-session-drawer-slot-${session.id}`}
                title={`布局位置：${slotTone.label}`}
                style={{
                  flexShrink: 0,
                  padding: '1px 7px',
                  borderRadius: '999px',
                  background: slotTone.background,
                  color: slotTone.color,
                  textAlign: 'center',
                  fontSize: '12px',
                  fontWeight: 800,
                  border: `1px solid ${slotTone.border}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {slotTone.label}
              </span>
            ) : null}
          </div>
          <div
            title={session.subtitle}
            style={{
              minWidth: 0,
              fontSize: `${TERMINAL_SESSION_DRAWER_ROW_SUBTITLE_FONT_SIZE_PX}px`,
              lineHeight: 1.25,
              color: 'var(--zterm-panel-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {session.subtitle}
          </div>
          <div
            data-testid={`terminal-session-drawer-row-chip-${session.id}`}
            style={{
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '8px',
              minWidth: 0,
              padding: '2px 0 0',
              borderRadius: 0,
              border: 'none',
              background: 'transparent',
            }}
          >
            <span
              data-testid={`terminal-session-drawer-collab-${session.id}`}
              title={session.collab?.displayName
                ? `${role.label} · ${session.collab.displayName}`
                : `角色：${role.label}`}
              aria-label={`角色：${role.label}`}
              style={{
                flexShrink: 0,
                padding: '1px 8px',
                borderRadius: '999px',
                border: `1px ${role.tone === 'unclassified' ? 'dashed' : 'solid'} ${roleTone.border}`,
                background: roleTone.background,
                color: roleTone.color,
                fontSize: '12px',
                fontWeight: 800,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
              }}
            >
              {role.label}
            </span>
            {agent && agentTone ? (
              <span
                data-testid={`terminal-session-drawer-agent-${session.id}`}
                title={`Agent 状态：${agent.label}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  flexShrink: 0,
                  fontSize: '12px',
                  fontWeight: 600,
                  color: agentTone.color,
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '999px',
                    background: agentTone.color,
                    flexShrink: 0,
                  }}
                />
                {agent.label}
              </span>
            ) : null}
            {session.paneLabel ? (
              <span
                title={`Pane ${session.paneLabel}`}
                style={{
                  flexShrink: 0,
                  padding: '1px 7px',
                  borderRadius: '999px',
                  border: '1px solid var(--zterm-panel-accent-border)',
                  background: 'var(--zterm-panel-accent-soft)',
                  color: 'var(--zterm-panel-accent)',
                  textAlign: 'center',
                  fontSize: '12px',
                  fontWeight: 800,
                  whiteSpace: 'nowrap',
                }}
              >
                {session.paneLabel}
              </span>
            ) : null}
          </div>
        </AmbientButton>
        <AmbientButton
          type="button"
          data-amb-flat="true"
          aria-label={`更多操作 ${session.title}`}
          data-testid={`terminal-session-drawer-more-${session.id}`}
          onTouchStart={(event) => {
            event.stopPropagation();
            clearLongPressTimer();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openSlotMenu(session, rect.left, rect.bottom, rect.top);
          }}
          style={{
            alignSelf: 'center',
            justifySelf: 'end',
            width: `${DRAWER_TOUCH_TARGET_PX}px`,
            minWidth: `${DRAWER_TOUCH_TARGET_PX}px`,
            height: `${DRAWER_TOUCH_TARGET_PX}px`,
            minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
            margin: '0 4px',
            padding: 0,
            borderRadius: '10px',
            border: 'none',
            background: 'transparent',
            color: 'var(--zterm-panel-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          className="zterm-session-drawer-icon-button"
        >
          <DrawerMoreIcon />
        </AmbientButton>
      </div>
    );
  };

  return (
    <>
      <AmbientButton
        type="button"
        data-amb-flat="true"
        aria-label="关闭 session 抽屉"
        aria-hidden={!open}
        inert={!open}
        data-testid="terminal-session-drawer-overlay"
        disabled={!open}
        tabIndex={open ? 0 : -1}
        ref={overlayRef}
        onClick={requestCloseDrawer}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            requestCloseDrawer();
          }
        }}
        style={{
          position: 'absolute',
          inset: 0,
          height: 'auto',
          minHeight: 0,
          border: 'none',
          background: 'color-mix(in srgb, #16191f 22%, transparent)',
          zIndex: 149,
          padding: 0,
          margin: 0,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 150ms ease',
        }}
      />
      <aside
        ref={drawerRef}
        aria-hidden={!open}
        inert={!open}
        className="zterm-neo-drawer"
        data-terminal-shell-skin={terminalShellSkin}
        data-testid="terminal-session-drawer"
        data-state={open ? 'open' : 'closed'}
        onTouchStartCapture={(event) => {
          onDebugAddEvent?.(`cap:start:${describeEventTarget(event.target)}`);
          onDebugAddEvent?.('drawer:touchstart');
          const touch = event.touches[0];
          if (!touch) {
            touchStartRef.current = null;
            return;
          }
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchMoveCapture={(event) => {
          const start = touchStartRef.current;
          const touch = event.touches[0];
          if (!start || !touch) {
            return;
          }
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (dx > -SWIPE_CLOSE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) {
            return;
          }
          touchStartRef.current = null;
          clearLongPressTimer();
          selectionPressRef.current = null;
          requestCloseDrawer();
        }}
        onTouchEndCapture={(event) => {
          onDebugAddEvent?.(`cap:end:${describeEventTarget(event.target)}`);
          onDebugAddEvent?.('drawer:touchend');
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) {
            return;
          }
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (
            dx > -SWIPE_CLOSE_THRESHOLD_PX
            || Math.abs(dx) <= Math.abs(dy)
            || Math.abs(dy) > SWIPE_CLOSE_VERTICAL_TOLERANCE_PX
          ) {
            return;
          }
          requestCloseDrawer();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            requestCloseDrawer();
          }
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          maxWidth: DRAWER_MAX_WIDTH,
          // Android WebView retains stale row text when the open drawer keeps
          // a translateX layer over the live terminal surface.
          transform: open ? 'none' : 'translateX(calc(-100% - 12px))',
          transition: open ? 'none' : 'transform 180ms ease',
          zIndex: 150,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--zterm-panel-bg)',
          color: 'var(--zterm-panel-text)',
          borderRight: '1px solid var(--zterm-panel-border)',
          // Android WebView 对 backdrop-filter 支持差：抽屉背景已是不透明色，
          // 每次底层 terminal 内容更新都会触发模糊层重算 → 用户感知的抽屉闪烁。
          // 移除 backdropFilter 与动态 boxShadow（消除合成层伪影）。
          boxShadow: 'none',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div
          data-testid="terminal-session-drawer-header"
          style={{
            padding: `${Math.max(8, topInsetPx + 4)}px 12px 8px`,
            borderBottom: '1px solid var(--zterm-panel-border)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={{ minWidth: 0, fontSize: '17px', fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.01em', color: 'var(--zterm-panel-text)' }}>
                会话
              </span>
              <div
                data-testid="terminal-session-drawer-count"
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  lineHeight: 1.3,
                  color: 'var(--zterm-panel-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                显示 {displayedSessionCount} / {totalSessionCount} 个会话
              </div>
            </div>
            <AmbientButton
              type="button"
              data-amb-flat="true"
              aria-label="关闭 session 抽屉"
              data-testid="terminal-session-drawer-close"
              ref={closeButtonRef}
              onClick={requestCloseDrawer}
              style={{
                width: `${DRAWER_TOUCH_TARGET_PX}px`,
                minWidth: `${DRAWER_TOUCH_TARGET_PX}px`,
                height: `${DRAWER_TOUCH_TARGET_PX}px`,
                minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                padding: 0,
                borderRadius: '10px',
                border: 'none',
                background: 'transparent',
                color: 'var(--zterm-panel-text)',
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              className="zterm-session-drawer-icon-button"
            >
              <DrawerCloseIcon size={20} />
            </AmbientButton>
          </div>
          <div
            data-testid="terminal-session-drawer-filter"
            role="group"
            aria-label="按 Collab 角色筛选会话；未识别会话单独标记"
            style={{
              display: 'flex',
              gap: '4px',
              minWidth: 0,
              padding: '4px',
              borderRadius: '11px',
              background: 'var(--zterm-panel-surface)',
              border: '1px solid var(--zterm-panel-border)',
            }}
          >
            {SESSION_DRAWER_FILTER_MODES.map((mode) => {
              const selected = (filterMode ?? 'all') === mode;
              const count = segmentCounts[mode];
              return (
                <AmbientButton
                  key={mode}
                  type="button"
                  data-amb-flat="true"
                  aria-pressed={selected}
                  aria-label={`${SESSION_DRAWER_FILTER_LABELS[mode]}，${count} 个会话`}
                  data-testid={`terminal-session-drawer-filter-${mode}`}
                  onClick={() => onFilterModeChange?.(mode)}
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                    height: `${DRAWER_TOUCH_TARGET_PX}px`,
                    padding: '0 6px',
                    borderRadius: '8px',
                    border: selected
                      ? '1px solid var(--zterm-panel-accent-border)'
                      : '1px solid transparent',
                    background: selected ? 'var(--zterm-panel-active)' : 'transparent',
                    color: selected ? 'var(--zterm-panel-active-text)' : 'var(--zterm-panel-muted)',
                    fontSize: '12px',
                    fontWeight: selected ? 800 : 600,
                    display: 'inline-flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '2px',
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.15,
                    }}
                  >
                    {SESSION_DRAWER_FILTER_LABELS[mode]}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      minWidth: 0,
                      color: selected ? 'var(--zterm-panel-accent)' : 'var(--zterm-panel-muted)',
                      fontSize: '10px',
                      fontWeight: 700,
                      lineHeight: 1,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {count}
                  </span>
                </AmbientButton>
              );
            })}
          </div>
        </div>

        <div
          data-testid="terminal-session-drawer-tree"
          role="tree"
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
          style={{
            flex: '0 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            touchAction: 'pan-y',
            WebkitOverflowScrolling: 'touch',
            padding: '4px 8px 8px',
          }}
        >
          {showHostRail ? (
            <div
              data-testid="terminal-session-drawer-host-rail"
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: '4px',
                padding: '0 0 8px',
                borderBottom: '1px solid var(--zterm-panel-border)',
                flexShrink: 0,
                overflowX: 'auto',
                scrollbarWidth: 'none',
              }}
            >
              {hostGroups.map((group) => {
                const isActive = group.groupKey === effectiveHostKey;
                const tone = group.hostKey
                  ? getServerIdentityTone({ daemonHostId: group.hostKey, connectionName: group.hostLabel })
                  : {
                      accent: 'var(--zterm-settings-accent)',
                      accentSoft: 'var(--zterm-settings-accent-soft)',
                      lightCardBorder: 'var(--zterm-settings-border)',
                      tabActiveBackground: 'var(--zterm-settings-field)',
                      previewText: 'var(--zterm-settings-text)',
                    };
                const statusColor = group.connected === false
                  ? 'var(--zterm-settings-danger)'
                  : group.connected
                    ? 'var(--zterm-settings-success)'
                    : 'var(--zterm-panel-muted)';
                return (
                  <AmbientButton
                    key={group.groupKey}
                    type="button"
                    data-amb-flat="true"
                    role="treeitem"
                    aria-level={1}
                    aria-selected={isActive}
                    data-tree-level="1"
                    data-testid={`terminal-session-drawer-host-${group.groupKey}`}
                    onClick={() => setSelectedHostKey(group.groupKey)}
                    style={{
                      width: 'auto',
                      minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                      flexShrink: 0,
                      padding: '0 10px',
                      border: isActive
                        ? '1px solid var(--zterm-panel-accent-border)'
                        : '1px solid transparent',
                      borderRadius: '10px',
                      background: isActive ? 'var(--zterm-panel-active)' : 'transparent',
                      color: isActive ? 'var(--zterm-panel-active-text)' : 'var(--zterm-panel-text)',
                      fontSize: '12px',
                      fontWeight: isActive ? 800 : 600,
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: '7px',
                          height: '7px',
                          borderRadius: '999px',
                          background: statusColor,
                          boxShadow: `0 0 0 2px ${tone.accentSoft}`,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {group.hostLabel}
                      </span>
                      <span
                        style={{
                          flexShrink: 0,
                          padding: '1px 7px',
                          borderRadius: '999px',
                          background: 'var(--zterm-panel-surface)',
                          color: 'var(--zterm-panel-muted)',
                          fontSize: '11px',
                          fontWeight: 700,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {group.sessions.length}
                      </span>
                    </div>
                  </AmbientButton>
                );
              })}
            </div>
          ) : null}

          <div
            data-testid="terminal-session-drawer-list"
            style={{
              paddingTop: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
          {cwdGroups.map((folder) => {
            const isFolderExpanded = activeFilterMode === 'only-master'
              ? !collapsedMasterFolders.has(folder.cwd)
              : expandedFolderCwd === folder.cwd;
            const othersExpanded = activeFilterMode === 'only-master'
              && expandedOtherFoldersInMasterMode.has(folder.cwd);
            const displayedItems = othersExpanded
              ? [...folder.items, ...folder.otherItems]
              : folder.items;
            return (
            <div
              key={folder.cwd}
              data-testid={`terminal-session-drawer-folder-${folder.cwd}`}
              role="group"
              style={{
                borderBottom: '1px solid color-mix(in srgb, var(--zterm-panel-border) 68%, transparent)',
                paddingBottom: '2px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                <AmbientButton
                  type="button"
                  data-amb-flat="true"
                  role="treeitem"
                  aria-level={2}
                  data-tree-level="2"
                  data-testid={`terminal-session-drawer-folder-button-${folder.cwd}`}
                  title={folder.cwd}
                  aria-label={`${isFolderExpanded ? '折叠' : '展开'}目录 ${shortenFolderLabel(folder.cwd)}`}
                  onClick={(event) => {
                    if (suppressNextClickRef.current) {
                      event.preventDefault();
                      suppressNextClickRef.current = false;
                      return;
                    }
                    if (activeFilterMode === 'only-master') {
                      setCollapsedMasterFolders((current) => {
                        const next = new Set(current);
                        if (next.has(folder.cwd)) {
                          next.delete(folder.cwd);
                        } else {
                          next.add(folder.cwd);
                        }
                        return next;
                      });
                      return;
                    }
                    setExpandedFolderCwd((current) => current === folder.cwd ? null : folder.cwd);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSlotMenu(null);
                    setFolderMenu({ cwd: folder.cwd, x: event.clientX, y: event.clientY });
                  }}
                  onPointerDown={() => {
                    folderPointerGestureRef.current = true;
                    clearLongPressTimer();
                    longPressTimerRef.current = window.setTimeout(() => {
                      longPressTimerRef.current = null;
                      suppressNextClickRef.current = true;
                      setSlotMenu(null);
                    }, 420);
                  }}
                  onPointerUp={() => {
                    folderPointerGestureRef.current = false;
                    clearLongPressTimer();
                  }}
                  onPointerCancel={() => {
                    folderPointerGestureRef.current = false;
                    clearLongPressTimer();
                  }}
                  onPointerMove={() => {
                    folderPointerGestureRef.current = false;
                    clearLongPressTimer();
                  }}
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                    padding: '0 8px',
                    borderRadius: '10px',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--zterm-panel-text)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    textAlign: 'left',
                    fontSize: '13px',
                    fontWeight: 700,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-flex',
                      color: 'var(--zterm-panel-muted)',
                      transform: isFolderExpanded ? 'rotate(90deg)' : 'none',
                      transition: 'transform 160ms cubic-bezier(0.2, 0, 0, 1)',
                    }}
                  >
                    <DrawerChevronIcon size={14} />
                  </span>
                  <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--zterm-settings-accent)' }}>
                    <DrawerFolderIcon size={15} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {shortenFolderLabel(folder.cwd)}
                  </span>
                  <span
                    style={{
                      color: 'var(--zterm-panel-muted)',
                      fontSize: '11px',
                      fontVariantNumeric: 'tabular-nums',
                      flexShrink: 0,
                    }}
                  >
                    {folder.items.length + folder.unclassifiedItems.length + folder.otherItems.length}
                  </span>
                </AmbientButton>
                {activeFilterMode === 'only-master' && folder.otherItems.length > 0 ? (
                  <AmbientButton
                    type="button"
                    data-amb-flat="true"
                    aria-pressed={othersExpanded}
                    aria-label={`${othersExpanded ? '收起' : '展开'} ${shortenFolderLabel(folder.cwd)} 其余 ${folder.otherItems.length} 个窗口`}
                    data-testid={`terminal-session-drawer-folder-expand-others-${folder.cwd}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCollapsedMasterFolders((current) => {
                        if (!current.has(folder.cwd)) {
                          return current;
                        }
                        const next = new Set(current);
                        next.delete(folder.cwd);
                        return next;
                      });
                      setExpandedOtherFoldersInMasterMode((current) => {
                        const next = new Set(current);
                        if (next.has(folder.cwd)) {
                          next.delete(folder.cwd);
                        } else {
                          next.add(folder.cwd);
                        }
                        return next;
                      });
                    }}
                    style={{
                      flexShrink: 0,
                      minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                      padding: '0 10px',
                      borderRadius: '10px',
                      border: othersExpanded
                        ? '1px solid var(--zterm-panel-accent-border)'
                        : '1px solid var(--zterm-panel-border)',
                      background: othersExpanded
                        ? 'var(--zterm-panel-active)'
                        : 'var(--zterm-panel-surface)',
                      color: othersExpanded
                        ? 'var(--zterm-panel-active-text)'
                        : 'var(--zterm-panel-muted)',
                      fontSize: '12px',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {othersExpanded ? `收起 (${folder.otherItems.length})` : `+${folder.otherItems.length} 窗口`}
                  </AmbientButton>
                ) : null}
              </div>
              {isFolderExpanded ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '2px' }}>
                  {activeFilterMode === 'only-master' && folder.items.length === 0 ? (
                    <div
                      data-testid={`terminal-session-drawer-folder-no-master-${folder.cwd}`}
                      style={{
                        margin: '2px 0',
                        padding: '8px 12px',
                        borderRadius: '10px',
                        border: '1px dashed var(--zterm-panel-border)',
                        background: 'var(--zterm-panel-surface)',
                        color: 'var(--zterm-panel-muted)',
                        fontSize: '12px',
                        lineHeight: 1.4,
                      }}
                    >
                      该项目无 master
                    </div>
                  ) : null}
                  {displayedItems.map(renderSessionRow)}
                  {folder.unclassifiedItems.length > 0 ? (
                    <>
                      <div
                        data-testid={`terminal-session-drawer-folder-unclassified-${folder.cwd}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '8px 8px 0',
                          color: 'var(--zterm-panel-muted)',
                          fontSize: '11px',
                          fontWeight: 700,
                        }}
                      >
                        未识别（无 Collab 身份）
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {folder.unclassifiedItems.length}
                        </span>
                      </div>
                      {folder.unclassifiedItems.map(renderSessionRow)}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            );
          })}
          {cwdGroups.length === 0 && (
            (activeFilterMode !== 'all' && hasKnownSessions) ? (
              <div
                data-testid="terminal-session-drawer-empty-filter"
                style={{
                  margin: '8px 2px',
                  padding: '14px',
                  borderRadius: '14px',
                  border: '1px dashed var(--zterm-panel-border)',
                  color: 'var(--zterm-panel-muted)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '8px',
                }}
              >
                <span>当前筛选没有匹配的 session。</span>
                <span>
                  {activeFilterMode === 'only-master'
                    ? '未识别 Collab 身份的会话仍会单独标记；切换到“全部”可查看 worker 会话。'
                    : '切换到“全部”可查看被隐藏的 worker 会话。'}
                </span>
                <AmbientButton
                  type="button"
                  data-amb-flat="true"
                  data-testid="terminal-session-drawer-empty-filter-reset"
                  onClick={() => onFilterModeChange?.('all')}
                  style={{
                    minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                    padding: '0 14px',
                    borderRadius: '10px',
                    border: '1px solid var(--zterm-panel-accent-border)',
                    background: 'var(--zterm-panel-active)',
                    color: 'var(--zterm-panel-active-text)',
                    fontSize: '12px',
                    fontWeight: 800,
                    whiteSpace: 'nowrap',
                  }}
                >
                  显示全部
                </AmbientButton>
              </div>
            ) : hostHiddenCount > 0 ? (
              <div
                data-testid="terminal-session-drawer-empty-hidden"
                style={{
                  margin: '8px 2px',
                  padding: '14px',
                  borderRadius: '14px',
                  border: '1px dashed var(--zterm-panel-border)',
                  color: 'var(--zterm-panel-muted)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '8px',
                }}
              >
                <span>所有 session 已隐藏。</span>
                <AmbientButton
                  type="button"
                  data-amb-flat="true"
                  data-testid="terminal-session-drawer-empty-hidden-restore"
                  onClick={onRestoreAllHiddenSessions}
                  style={{
                    minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                    padding: '0 14px',
                    borderRadius: '10px',
                    border: '1px solid var(--zterm-panel-accent-border)',
                    background: 'var(--zterm-panel-active)',
                    color: 'var(--zterm-panel-active-text)',
                    fontSize: '12px',
                    fontWeight: 800,
                    whiteSpace: 'nowrap',
                  }}
                >
                  恢复全部
                </AmbientButton>
              </div>
            ) : (
              <div
                data-testid="terminal-session-drawer-empty-host"
                style={{
                  margin: '8px 2px',
                  padding: '14px',
                  borderRadius: '14px',
                  border: '1px dashed var(--zterm-panel-border)',
                  color: 'var(--zterm-panel-muted)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                }}
              >
                当前机器没有活跃 session。点击底部 New Session 会在这台机器上创建一个空白 session。
              </div>
            )
          )}
        </div>
        </div>
        {hiddenSessionCount > 0 ? (
          <div
            data-testid="terminal-session-drawer-hidden-tray"
            style={{
              flexShrink: 0,
              borderTop: '1px solid var(--zterm-panel-border)',
              background: 'var(--zterm-panel-surface)',
              display: 'flex',
              flexDirection: 'column',
              maxHeight: '40vh',
              minHeight: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px' }}>
              <AmbientButton
                type="button"
                data-amb-flat="true"
                aria-expanded={hiddenTrayExpanded}
                aria-label={`${hiddenTrayExpanded ? '收起' : '展开'}已隐藏会话`}
                data-testid="terminal-session-drawer-hidden-tray-toggle"
                onClick={() => setHiddenTrayExpanded((current) => !current)}
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                  padding: '0 4px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--zterm-panel-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  textAlign: 'left',
                  fontSize: '12px',
                  fontWeight: 800,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    transform: hiddenTrayExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 160ms cubic-bezier(0.2, 0, 0, 1)',
                  }}
                >
                  <DrawerChevronIcon size={14} />
                </span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  已隐藏 {hiddenSessionCount}
                </span>
              </AmbientButton>
              <AmbientButton
                type="button"
                data-amb-flat="true"
                aria-label="恢复全部隐藏"
                data-testid="terminal-session-drawer-restore-hidden"
                onClick={onRestoreAllHiddenSessions}
                style={{
                  flexShrink: 0,
                  minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                  padding: '0 12px',
                  borderRadius: '10px',
                  border: '1px solid var(--zterm-panel-border)',
                  background: 'var(--zterm-panel-bg)',
                  color: 'var(--zterm-panel-text)',
                  fontSize: '12px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                恢复全部
              </AmbientButton>
            </div>
            {hiddenTrayExpanded ? (
              <div
                style={{
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '0 8px 8px',
                }}
              >
                {hiddenSessionNames.map((hiddenName) => (
                  <div
                    key={hiddenName}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: `${DRAWER_TOUCH_TARGET_PX}px` }}
                  >
                    <span
                      title={hiddenName}
                      style={{
                        flex: '1 1 0',
                        minWidth: 0,
                        fontSize: '12px',
                        color: 'var(--zterm-panel-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {hiddenName}
                    </span>
                    <AmbientButton
                      type="button"
                      data-amb-flat="true"
                      aria-label={`恢复 ${hiddenName}`}
                      data-testid={terminalSessionDrawerHiddenRestoreTestId(hiddenName)}
                      onClick={() => onRestoreHiddenSession?.(hiddenName)}
                      style={{
                        flexShrink: 0,
                        minHeight: `${DRAWER_TOUCH_TARGET_PX}px`,
                        minWidth: `${DRAWER_TOUCH_TARGET_PX}px`,
                        padding: '0 12px',
                        borderRadius: '10px',
                        border: '1px solid var(--zterm-panel-border)',
                        background: 'var(--zterm-panel-bg)',
                        color: 'var(--zterm-panel-text)',
                        fontSize: '12px',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      <DrawerRestoreIcon size={14} />
                      <span>恢复</span>
                    </AmbientButton>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {folderMenu ? (
          <TerminalSessionDrawerFolderMenu
            cwd={folderMenu.cwd}
            x={folderMenu.x}
            y={folderMenu.y}
            onClose={() => setFolderMenu(null)}
          />
        ) : null}
        {slotMenu ? (
          <TerminalSessionDrawerSlotMenu
            sessionId={slotMenu.sessionId}
            title={slotMenu.title}
            x={slotMenu.x}
            y={slotMenu.y}
            anchorTop={slotMenu.anchorTop}
            axis={sessionGroupLayoutAxis}
            onAssign={(sessionId, slot) => {
              onAssignSessionGroupSlot?.(sessionId, slot);
            }}
            onHide={(sessionId) => {
              onHideSession?.(sessionId);
            }}
            onCloseSession={(sessionId) => {
              activateCloseSession(sessionId);
            }}
            onClose={() => setSlotMenu(null)}
          />
        ) : null}

        {newSessionDraft ? (
          <TerminalSessionDrawerNewSessionDialog
            draft={newSessionDraft}
            setDraft={setNewSessionDraft}
            onCancel={() => setNewSessionDraft(null)}
            onConfirm={confirmNewSession}
          />
        ) : null}

        {!newSessionDraft ? (
          <AmbientButton
            data-testid="terminal-session-drawer-add"
            data-amb-flat="true"
            aria-label="新建 session"
            type="button"
            onTouchStartCapture={(event) => {
              onDebugAddEvent?.(`add:capstart:${describeEventTarget(event.target)}`);
            }}
            onTouchEndCapture={(event) => {
              onDebugAddEvent?.(`add:capend:${describeEventTarget(event.target)}`);
            }}
            onTouchStart={() => {
              onDebugAddEvent?.('add:touchstart');
            }}
            onTouchEnd={(event) => {
              onDebugAddEvent?.('add:touchend');
              event.preventDefault();
              event.stopPropagation();
              onDebugAddEvent?.('add:callback');
              openNewSessionDialog();
            }}
            onPointerDown={() => {
              onDebugAddEvent?.('add:pointerdown');
            }}
            onPointerUp={() => {
              onDebugAddEvent?.('add:pointerup');
            }}
            onClick={() => {
              onDebugAddEvent?.('add:click');
              openNewSessionDialog();
            }}
            style={{
              width: '100%',
              height: 'auto',
              minHeight: '56px',
              marginTop: 'auto',
              borderRadius: 0,
              padding: `8px 10px ${Math.max(12, Math.round(bottomInsetPx) + 12)}px`,
              borderTop: '1px solid var(--zterm-panel-border)',
              borderLeft: 'none',
              borderRight: 'none',
              borderBottom: 'none',
              background: 'var(--zterm-panel-bg)',
              color: 'var(--zterm-panel-text)',
              appearance: 'none',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: '100%',
                minHeight: '40px',
                borderRadius: '7px',
                border: '1px solid var(--zterm-panel-border)',
                background: 'var(--zterm-panel-surface)',
                color: 'var(--zterm-panel-text)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '13px',
                fontWeight: 700,
                touchAction: 'manipulation',
              }}
            >
              <span
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '999px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--zterm-panel-active)',
                  color: 'var(--zterm-panel-accent)',
                  fontSize: '15px',
                }}
              >
                +
              </span>
              <span>New Session</span>
            </div>
          </AmbientButton>
        ) : null}
      </aside>
    </>
  );
}
function terminalSessionDrawerPropsEqual(
  prev: TerminalSessionDrawerProps,
  next: TerminalSessionDrawerProps,
) {
  const mismatchFields: string[] = [];
  if (prev.open !== next.open) mismatchFields.push('open');
  if (prev.topInsetPx !== next.topInsetPx) mismatchFields.push('topInsetPx');
  if (prev.bottomInsetPx !== next.bottomInsetPx) mismatchFields.push('bottomInsetPx');
  if (prev.sessionGroupLayoutAxis !== next.sessionGroupLayoutAxis) mismatchFields.push('sessionGroupLayoutAxis');
  if (prev.terminalShellSkin !== next.terminalShellSkin) mismatchFields.push('terminalShellSkin');
  if (prev.onClose !== next.onClose) mismatchFields.push('onClose');
  if (prev.onSelectSession !== next.onSelectSession) mismatchFields.push('onSelectSession');
  if (prev.onCloseSession !== next.onCloseSession) mismatchFields.push('onCloseSession');
  if (prev.onAssignSessionGroupSlot !== next.onAssignSessionGroupSlot) mismatchFields.push('onAssignSessionGroupSlot');
  if (prev.onHideSession !== next.onHideSession) mismatchFields.push('onHideSession');
  if (prev.onRestoreAllHiddenSessions !== next.onRestoreAllHiddenSessions) mismatchFields.push('onRestoreAllHiddenSessions');
  if (prev.onRestoreHiddenSession !== next.onRestoreHiddenSession) mismatchFields.push('onRestoreHiddenSession');
  if (prev.hiddenSessionCount !== next.hiddenSessionCount) mismatchFields.push('hiddenSessionCount');
  if (prev.unfilteredSessionCount !== next.unfilteredSessionCount) mismatchFields.push('unfilteredSessionCount');
  const prevHostSummaries = prev.hostSummaries ?? [];
  const nextHostSummaries = next.hostSummaries ?? [];
  if (prevHostSummaries.length !== nextHostSummaries.length) mismatchFields.push('hostSummaries.length');
  const summaryCount = Math.min(prevHostSummaries.length, nextHostSummaries.length);
  for (let i = 0; i < summaryCount; i += 1) {
    const previous = prevHostSummaries[i]!;
    const current = nextHostSummaries[i]!;
    if (previous.hostKey !== current.hostKey) mismatchFields.push(`hostSummaries[${i}].hostKey`);
    if (previous.unfilteredSessionCount !== current.unfilteredSessionCount) {
      mismatchFields.push(`hostSummaries[${i}].unfilteredSessionCount`);
    }
    if (previous.hiddenSessionCount !== current.hiddenSessionCount) {
      mismatchFields.push(`hostSummaries[${i}].hiddenSessionCount`);
    }
    if (previous.roleFilteredSessionCount !== current.roleFilteredSessionCount) {
      mismatchFields.push(`hostSummaries[${i}].roleFilteredSessionCount`);
    }
  }
  if ((prev.filterMode ?? 'all') !== (next.filterMode ?? 'all')) mismatchFields.push('filterMode');
  if (prev.onFilterModeChange !== next.onFilterModeChange) mismatchFields.push('onFilterModeChange');
  const prevHiddenNames = prev.hiddenSessionNames ?? [];
  const nextHiddenNames = next.hiddenSessionNames ?? [];
  if (prevHiddenNames.length !== nextHiddenNames.length) mismatchFields.push('hiddenSessionNames.length');
  for (let i = 0; i < Math.min(prevHiddenNames.length, nextHiddenNames.length); i += 1) {
    if (prevHiddenNames[i] !== nextHiddenNames[i]) mismatchFields.push(`hiddenSessionNames[${i}]`);
  }
  if (prev.onOpenQuickTabPicker !== next.onOpenQuickTabPicker) mismatchFields.push('onOpenQuickTabPicker');
  if (prev.onDebugAddEvent !== next.onDebugAddEvent) mismatchFields.push('onDebugAddEvent');
  if (prev.sessions.length !== next.sessions.length) mismatchFields.push('sessions.length');
  const sessionCount = Math.min(prev.sessions.length, next.sessions.length);
  for (let i = 0; i < sessionCount; i += 1) {
    const p = prev.sessions[i]!;
    const n = next.sessions[i]!;
    if ((p.stableKey ?? p.id) !== (n.stableKey ?? n.id)) mismatchFields.push(`sessions[${i}].stableKey`);
    if ((p.title ?? '') !== (n.title ?? '')) mismatchFields.push(`sessions[${i}].title`);
    if ((p.subtitle ?? '') !== (n.subtitle ?? '')) mismatchFields.push(`sessions[${i}].subtitle`);
    if ((p.paneLabel ?? '') !== (n.paneLabel ?? '')) mismatchFields.push(`sessions[${i}].paneLabel`);
    if ((p.hostKey ?? '') !== (n.hostKey ?? '')) mismatchFields.push(`sessions[${i}].hostKey`);
    if ((p.hostLabel ?? '') !== (n.hostLabel ?? '')) mismatchFields.push(`sessions[${i}].hostLabel`);
    if ((p.terminalBackend ?? '') !== (n.terminalBackend ?? '')) mismatchFields.push(`sessions[${i}].terminalBackend`);
    if ((p.sessionGroupSlot ?? '') !== (n.sessionGroupSlot ?? '')) mismatchFields.push(`sessions[${i}].sessionGroupSlot`);
    if ((p.collab?.role ?? '') !== (n.collab?.role ?? '')) mismatchFields.push(`sessions[${i}].collab.role`);
    if ((p.collab?.displayName ?? '') !== (n.collab?.displayName ?? '')) mismatchFields.push(`sessions[${i}].collab.displayName`);
    if ((p.collab?.agentState ?? '') !== (n.collab?.agentState ?? '')) mismatchFields.push(`sessions[${i}].collab.agentState`);
    if (Boolean(p.active) !== Boolean(n.active)) mismatchFields.push(`sessions[${i}].active`);
  }
  const prevUnfiltered = prev.unfilteredSessions ?? [];
  const nextUnfiltered = next.unfilteredSessions ?? [];
  if (prevUnfiltered.length !== nextUnfiltered.length) mismatchFields.push('unfilteredSessions.length');
  const unfilteredCount = Math.min(prevUnfiltered.length, nextUnfiltered.length);
  for (let i = 0; i < unfilteredCount; i += 1) {
    const p = prevUnfiltered[i]!;
    const n = nextUnfiltered[i]!;
    if ((p.stableKey ?? p.id) !== (n.stableKey ?? n.id)) mismatchFields.push(`unfilteredSessions[${i}].stableKey`);
    if ((p.title ?? '') !== (n.title ?? '')) mismatchFields.push(`unfilteredSessions[${i}].title`);
    if ((p.collab?.role ?? '') !== (n.collab?.role ?? '')) mismatchFields.push(`unfilteredSessions[${i}].collab.role`);
    if (Boolean(p.active) !== Boolean(n.active)) mismatchFields.push(`unfilteredSessions[${i}].active`);
  }
  const prevHosts = prev.hosts ?? [];
  const nextHosts = next.hosts ?? [];
  if (prevHosts.length !== nextHosts.length) mismatchFields.push('hosts.length');
  const hostCount = Math.min(prevHosts.length, nextHosts.length);
  for (let i = 0; i < hostCount; i += 1) {
    const a = prevHosts[i]!;
    const b = nextHosts[i]!;
    if (a.hostKey !== b.hostKey) mismatchFields.push(`hosts[${i}].hostKey`);
    if (a.hostLabel !== b.hostLabel) mismatchFields.push(`hosts[${i}].hostLabel`);
  }
  return mismatchFields.length === 0;
}

export const TerminalSessionDrawer = memo(
  TerminalSessionDrawerComponent,
  terminalSessionDrawerPropsEqual,
);

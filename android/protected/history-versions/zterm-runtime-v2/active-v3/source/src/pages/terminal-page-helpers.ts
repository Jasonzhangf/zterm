/**
 * TerminalPage 纯 helper 子模块（client.app_shell）。
 * 从 TerminalPage.tsx 拆出：drawer 状态归一、ui key 派生、session 分组投影；不含组件状态与 JSX。
 */
import type { Session, TraversalRelayDeviceSnapshot } from '../lib/types';
import type { ServerIdentityInput } from '../lib/server-identity';
import type { TerminalSessionDrawerItem } from '../components/terminal/TerminalSessionDrawer';
import {
  resolveTerminalSessionGroupSlotReplacement,
  type TerminalSessionGroupSlotIds,
  type TerminalSessionGroupSlotName,
} from '../lib/session-group-viewport';

export interface TerminalTabChromeItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: Session['resolvedPath'];
  resolvedRelayTransport?: Session['resolvedRelayTransport'];
}

export function normalizeDrawerStatus(state: Session['state'] | undefined): TerminalSessionDrawerItem['status'] {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'closed':
      return 'closed';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

export function terminalPageHeaderSessionUiKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || '',
    session.resolvedPath || '',
    session.resolvedRelayTransport || '',
    session.selectedIcePair?.local?.candidateType || '',
    session.selectedIcePair?.local?.address || '',
    String(session.selectedIcePair?.local?.port || ''),
    session.selectedIcePair?.remote?.candidateType || '',
    session.selectedIcePair?.remote?.address || '',
    String(session.selectedIcePair?.remote?.port || ''),
  ].join('::');
}

export function terminalPageHeaderSessionsUiKey(sessions: Session[]) {
  return sessions.map((session) => terminalPageHeaderSessionUiKey(session)).join('||');
}

export function terminalPageActiveRuntimeStatusKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.state,
    session.lastError || '',
  ].join('::');
}

export function terminalPageRelayDevicesUiKey(relayDevices: readonly TraversalRelayDeviceSnapshot[] | undefined) {
  return (relayDevices || []).map((device) => [
    device.deviceId,
    device.deviceName,
    device.daemon.hostId,
    device.daemon.connected ? '1' : '0',
    (device.daemon.endpoints || []).map((endpoint) => [
      endpoint.id,
      endpoint.kind,
      endpoint.host || '',
      endpoint.wsUrl || '',
      endpoint.relayHostId || '',
      String(endpoint.port || ''),
    ].join('~')).join(','),
    (device.daemon.sessions || []).map((session) => [
      session.name || '',
      session.updatedAt || '',
    ].join('~')).join(','),
  ].join('|')).join('||');
}

export function terminalPageServerIdentityAliasInputsUiKey(inputs: readonly ServerIdentityInput[] | undefined) {
  return (inputs || []).map((input) => [
    input.bridgeHost || '',
    String(input.bridgePort || ''),
    input.daemonHostId || '',
    input.connectionName || '',
  ].join('|')).join('||');
}

export function resolveSessionInputEpoch(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return -1;
  }
  return inputResetEpochBySession?.[sessionId] || 0;
}

export function toTerminalTabChromeItem(session: Session): TerminalTabChromeItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
    resolvedRelayTransport: session.resolvedRelayTransport,
  };
}
export function resolveTerminalSessionGroupSlotIds(options: {
  slots: TerminalSessionGroupSlotIds;
  sessions: Session[];
  centerSessionId: string | null;
}): TerminalSessionGroupSlotIds {
  const sessionIds = new Set(options.sessions.map((session) => session.id));
  const center = (
    options.slots.center && sessionIds.has(options.slots.center)
      ? options.slots.center
      : options.centerSessionId && sessionIds.has(options.centerSessionId)
        ? options.centerSessionId
        : null
  );
  const top = (
    options.slots.top && sessionIds.has(options.slots.top) && options.slots.top !== center
      ? options.slots.top
      : null
  );
  const bottom = (
    options.slots.bottom &&
      sessionIds.has(options.slots.bottom) &&
      options.slots.bottom !== center &&
      options.slots.bottom !== top
      ? options.slots.bottom
      : null
  );

  return { top, center, bottom };
}

export function terminalSessionGroupSlotIdsEqual(
  left: TerminalSessionGroupSlotIds,
  right: TerminalSessionGroupSlotIds,
) {
  return left.top === right.top && left.center === right.center && left.bottom === right.bottom;
}

export function resolveTerminalSessionGroupActiveSessionProjection(options: {
  slots: TerminalSessionGroupSlotIds;
  sessions: Session[];
  activeSessionId: string | null;
}): { slots: TerminalSessionGroupSlotIds; focusSlot: TerminalSessionGroupSlotName } | null {
  if (!options.activeSessionId) {
    return null;
  }
  const sessionIds = new Set(options.sessions.map((session) => session.id));
  if (!sessionIds.has(options.activeSessionId)) {
    return null;
  }
  const normalizedSlots = resolveTerminalSessionGroupSlotIds({
    slots: options.slots,
    sessions: options.sessions,
    centerSessionId: options.activeSessionId,
  });
  if (normalizedSlots.top === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'top' };
  }
  if (normalizedSlots.center === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'center' };
  }
  if (normalizedSlots.bottom === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'bottom' };
  }
  return {
    slots: resolveTerminalSessionGroupSlotIds({
      slots: resolveTerminalSessionGroupSlotReplacement(normalizedSlots, options.activeSessionId, 'center'),
      sessions: options.sessions,
      centerSessionId: options.activeSessionId,
    }),
    focusSlot: 'center',
  };
}

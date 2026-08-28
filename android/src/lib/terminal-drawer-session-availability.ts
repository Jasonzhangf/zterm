/**
 * Client session drawer availability reason resolver (client.session_drawer_preview).
 *
 * The drawer owns a single typed truth for whether a row should be selectable:
 *   - `available`: row is selectable; nothing blocks the close/open affordances.
 *   - `remote-missing`: daemon catalog marked this session as gone and no live
 *     session state has reopened it; drawer must keep the row disabled and
 *     surface an explicit retry affordance so the user can refetch the catalog.
 *   - `closed`: a previously opened session is now `state === 'closed'`; the
 *     drawer must NOT silently treat this as a transport failure because the
 *     physical transport is still owned by `resource.session_transport` and
 *     may still be reusable.
 *
 * Identity mixing (e.g. tmux catalog row receiving a Herdr-only session) stays
 * in `resolveSessionRemoteMissing`; we keep this resolver separate so the
 * drawer can evolve the availability surface without touching the daemon
 * catalog truth or any transport owner.
 */
import type { Session, SessionGroupHistory } from './types';
import { resolveSessionRemoteMissing } from './terminal-drawer-remote-missing';
import type {
  TerminalSessionDrawerAvailabilityReason,
  TerminalSessionDrawerItem,
} from './plugin-session-drawer/session-drawer-contract';

export type DrawerSessionAvailabilityReason = TerminalSessionDrawerAvailabilityReason;

export function resolveDrawerSessionAvailability(
  session: Pick<Session, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'remoteMissing' | 'state'>,
  sessionGroups: SessionGroupHistory[],
): DrawerSessionAvailabilityReason {
  if (resolveSessionRemoteMissing(session, sessionGroups)) {
    return 'remote-missing';
  }
  if (session.state === 'closed') {
    return 'closed';
  }
  return 'available';
}

export function isDrawerSessionUnavailable(reason: DrawerSessionAvailabilityReason | undefined): boolean {
  return reason === 'remote-missing' || reason === 'closed';
}

export function resolveDrawerSessionAvailabilityForItem(
  item: Pick<TerminalSessionDrawerItem, 'id' | 'status' | 'remoteMissing'>,
): DrawerSessionAvailabilityReason {
  if (item.remoteMissing) {
    return 'remote-missing';
  }
  if (item.status === 'closed') {
    return 'closed';
  }
  return 'available';
}

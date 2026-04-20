import { type Session } from './types';

export {
  buildStoredHost,
  formatBridgeEndpoint,
  formatBridgeSessionTarget,
  getResolvedSessionName,
  normalizeHost,
} from '@zterm/shared';

export function getSessionConnectionLabel(session: Pick<Session, 'customName' | 'connectionName'>) {
  return session.customName?.trim() || session.connectionName;
}

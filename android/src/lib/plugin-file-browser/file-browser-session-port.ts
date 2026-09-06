import type { Session } from '../types';
import type { FileBrowserCommand, FileBrowserSessionPort } from './file-browser-contract';

export function createFileBrowserSessionPort(input: {
  session: Pick<Session, 'id' | 'daemonHostId' | 'bridgeHost' | 'bridgePort'> | undefined;
  send: (sessionId: string, message: FileBrowserCommand) => void;
  subscribe: FileBrowserSessionPort['onFileTransferMessage'];
}): FileBrowserSessionPort {
  if (!input.session?.id.trim()) throw new Error('file browser session is required');
  if (typeof input.send !== 'function') throw new Error('file browser send capability is required');
  if (typeof input.subscribe !== 'function') throw new Error('file browser subscription capability is required');
  const { id, daemonHostId, bridgeHost, bridgePort } = input.session;
  const { send, subscribe } = input;
  return {
    daemonFileScopeId: daemonHostId ? `daemon:${daemonHostId}` : `endpoint:${bridgeHost}:${bridgePort}`,
    sendJson: (message) => send(id, message),
    onFileTransferMessage: subscribe,
  };
}

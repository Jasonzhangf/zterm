import type { BridgeSettings } from './bridge-settings';
import type { ClientMessage } from './types';
import { TraversalSocket } from './traversal/socket';
import type { TraversalTargetSource } from './traversal/types';

export interface BridgeTarget {
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  authToken?: string;
  relayHostId?: string;
  relayDeviceId?: string;
  tailscaleHost?: string;
  ipv6Host?: string;
  ipv4Host?: string;
  signalUrl?: string;
  transportMode?: 'auto' | 'websocket' | 'webrtc';
}

function sendTmuxRequest(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  message: ClientMessage,
  overrideUrl?: string,
) {
  return new Promise<string[]>((resolve, reject) => {
    const ws = new TraversalSocket(target satisfies TraversalTargetSource, traversalSettings, { overrideUrl });

    const cleanup = () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      ws.send(JSON.stringify(message));
    };

    ws.onmessage = (event) => {
      try {
        const response = JSON.parse(String(event.data)) as
          | { type: 'sessions'; payload: { sessions: string[] } }
          | { type: 'error'; payload: { message?: string } };

        if (response.type === 'sessions') {
          cleanup();
          ws.close();
          resolve(response.payload.sessions || []);
          return;
        }

        if (response.type === 'error') {
          cleanup();
          ws.close();
          reject(new Error(response.payload.message || 'Failed to manage tmux sessions'));
        }
      } catch (error) {
        cleanup();
        ws.close();
        reject(error);
      }
    };

    ws.onerror = () => {
      cleanup();
      const diagnostics = ws.getDiagnostics();
      reject(new Error(diagnostics.reason || 'Transport error while managing tmux sessions'));
    };

    ws.onclose = () => {
      cleanup();
    };
  });
}

export function fetchTmuxSessions(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  overrideUrl?: string,
) {
  return sendTmuxRequest(target, traversalSettings, { type: 'list-sessions' }, overrideUrl);
}

export function createTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(target, traversalSettings, { type: 'tmux-create-session', payload: { sessionName } }, overrideUrl);
}

export function renameTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  nextSessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(
    target,
    traversalSettings,
    { type: 'tmux-rename-session', payload: { sessionName, nextSessionName } },
    overrideUrl,
  );
}

export function killTmuxSession(
  target: BridgeTarget,
  traversalSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  sessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(target, traversalSettings, { type: 'tmux-kill-session', payload: { sessionName } }, overrideUrl);
}

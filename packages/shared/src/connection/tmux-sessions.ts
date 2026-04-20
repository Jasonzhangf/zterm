import { buildBridgeUrlFromTarget } from './bridge-url';

interface TmuxRequest {
  type: 'list-sessions' | 'tmux-create-session' | 'tmux-rename-session' | 'tmux-kill-session';
  payload?: Record<string, string>;
}

export interface BridgeTarget {
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
}

function sendTmuxRequest(target: BridgeTarget, message: TmuxRequest, overrideUrl?: string) {
  return new Promise<string[]>((resolve, reject) => {
    const ws = new WebSocket(buildBridgeUrlFromTarget(target, overrideUrl));

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
      reject(new Error('WebSocket error while managing tmux sessions'));
    };

    ws.onclose = () => {
      cleanup();
    };
  });
}

export function fetchTmuxSessions(target: BridgeTarget, overrideUrl?: string) {
  return sendTmuxRequest(target, { type: 'list-sessions' }, overrideUrl);
}

export function createTmuxSession(target: BridgeTarget, sessionName: string, overrideUrl?: string) {
  return sendTmuxRequest(target, { type: 'tmux-create-session', payload: { sessionName } }, overrideUrl);
}

export function renameTmuxSession(
  target: BridgeTarget,
  sessionName: string,
  nextSessionName: string,
  overrideUrl?: string,
) {
  return sendTmuxRequest(
    target,
    { type: 'tmux-rename-session', payload: { sessionName, nextSessionName } },
    overrideUrl,
  );
}

export function killTmuxSession(target: BridgeTarget, sessionName: string, overrideUrl?: string) {
  return sendTmuxRequest(target, { type: 'tmux-kill-session', payload: { sessionName } }, overrideUrl);
}

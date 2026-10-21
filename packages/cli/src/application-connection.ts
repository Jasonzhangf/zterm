import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import wrtc from '@roamhq/wrtc';
import type { AuthenticatedAccount } from './account-client.js';
import {
  SessionConnection,
  type SessionConnectionServer,
  type SessionConnectionRouteOptions,
} from './connection.js';
import { createNodeTraversalFactory } from './node-platform.js';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws') as {
  WebSocket: new (url: string) => unknown;
};

function abortError() {
  return new DOMException('application connection was aborted', 'AbortError');
}

export async function createApplicationConnection(
  account: AuthenticatedAccount,
  server: SessionConnectionServer,
  signal?: AbortSignal,
  options: SessionConnectionRouteOptions = {},
): Promise<SessionConnection> {
  if (signal?.aborted) {
    throw abortError();
  }

  const clientInstanceId = randomUUID();
  const traversalFactory = createNodeTraversalFactory({
    WebSocket,
    RTCPeerConnection: wrtc.RTCPeerConnection,
    RTCSessionDescription: wrtc.RTCSessionDescription,
    RTCIceCandidate: wrtc.RTCIceCandidate,
  });
  const connection = new SessionConnection({
    account,
    server,
    routeHealthScope: {
      accountId: account.user.id,
      daemonHostId: server.daemonHostId,
    },
    traversalFactory,
    clientInstanceId,
    rtcIceTransportPolicy: options.rtcIceTransportPolicy,
  });

  try {
    if (!signal) {
      await connection.ready();
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          connection.close('application-aborted');
          reject(abortError());
        };
        const settle = (action: () => void) => {
          signal.removeEventListener('abort', onAbort);
          action();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        connection.ready().then(
          () => settle(resolve),
          (error) => settle(() => reject(error)),
        );
      });
    }
  } catch (error) {
    connection.close('application-connection-failed');
    throw error;
  }

  return connection;
}

import type { Host } from '../types';
import type { Transport, createTransport } from '../transport/TransportManager';
import type { SessionStore } from './SessionStore';
import { TraversalSocket } from '../traversal/socket';
import type { BridgeTransportSocket } from '../traversal/types';

export class SessionConnector {
  constructor(
    private sessionStore: SessionStore,
    private getWsUrl: () => string,
    private bridgeSettings: any,
    private transportFactory: typeof createTransport
  ) {}

  async connectControl(
    sessionId: string,
    host: Host
  ): Promise<BridgeTransportSocket> {
    const baseUrl = this.getWsUrl();
    const controlUrl = new URL(baseUrl);
    controlUrl.searchParams.set('ztermTransport', 'control');
    const transport = this.transportFactory({
      url: controlUrl.toString(),
      heartbeat: false,
      reconnect: false,
      transportFactory: (url) => new TraversalSocket(url, { target: host, settings: this.bridgeSettings }),
    });
    const socket = this.transportToBridgeSocket(transport);
    return socket;
  }

  private transportToBridgeSocket(transport: Transport): BridgeTransportSocket {
    const socket = {
      send: (data: string | ArrayBuffer) => transport.send(data),
      close: (code?: number, reason?: string) => transport.close(code, reason),
      getDiagnostics: () => transport.getDiagnostics(),
      get readyState() { return transport.readyState; },
      set onopen(handler) { transport.onopen = handler; },
      get onopen() { return transport.onopen; },
      set onmessage(handler) { transport.onmessage = handler; },
      get onmessage() { return transport.onmessage; },
      set onclose(handler) { transport.onclose = handler; },
      get onclose() { return transport.onclose; },
      set onerror(handler) { transport.onerror = handler; },
      get onerror() { return transport.onerror; },
      get binaryType() { return 'arraybuffer'; },
      set binaryType(_value) {},
    };
    return socket as BridgeTransportSocket;
  }
}

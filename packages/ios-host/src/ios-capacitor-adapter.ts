import type { RuntimeEvent } from '@zterm/runtime-contracts';
import {
  IosHostGateway,
  IOS_COMMAND_CHANNEL,
  IOS_EVENT_CHANNEL,
  type IosCommandWire,
  type IosHostTransport,
  type IosLifecycleSignal,
  decodeIosEvent,
  isIosLifecycleSignal,
} from './ios-host-contract.ts';

export interface IosWebViewBridge {
  postMessage(channel: string, body: string): void;
  onMessage?(channel: string, listener: (body: string) => void): void;
  offMessage?(channel: string, listener: (body: string) => void): void;
}

export function createIosCapacitorAdapter(bridge: IosWebViewBridge) {
  return {
    projectLifecycle(signal: unknown): IosLifecycleSignal {
      if (!isIosLifecycleSignal(signal)) throw new TypeError(`unsupported lifecycle signal: ${String(signal)}`);
      return signal;
    },
    gateway(transport: IosHostTransport): IosHostGateway {
      const typedTransport: IosHostTransport = {
        ...transport,
        execute: async (wire: IosCommandWire) => {
          bridge.postMessage(IOS_COMMAND_CHANNEL, JSON.stringify(wire));
          return transport.execute(wire);
        },
      };
      return new IosHostGateway(typedTransport);
    },
    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      if (!bridge.onMessage || !bridge.offMessage) throw new Error('iOS event listener bridge is not configured');
      const handler = (body: string) => listener(decodeIosEvent(body));
      bridge.onMessage(IOS_EVENT_CHANNEL, handler);
      return () => bridge.offMessage?.(IOS_EVENT_CHANNEL, handler);
    },
  };
}

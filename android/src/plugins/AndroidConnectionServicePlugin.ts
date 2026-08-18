import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  parseAndroidConnectionCommand,
  type AndroidConnectionCommand,
} from '../lib/android-connection-service-commands';
import type {
  AndroidConnectionServiceRoutePolicy,
  AndroidConnectionServiceTarget,
} from '../lib/android-connection-service-commands';
import type { AndroidConnectionServiceSnapshot } from '../lib/android-connection-service-snapshot';

export interface AndroidConnectionServiceServerFrame {
  type: 'mux-ready' | 'mux-target-message' | 'mux-pong' | 'mux-error';
  generation: string;
  receivedAt: number;
  payload: Record<string, unknown>;
}

export interface AndroidConnectionServiceChannelMessage {
  generation: string;
  channelId: string;
  message: Record<string, unknown>;
}

export interface AndroidConnectionServiceErrorEvent {
  kind: 'command-rejected' | 'physical-error';
  errorCode: string;
  errorMessage: string;
  command?: Record<string, unknown>;
}

export interface AndroidConnectionServiceChannelOpenedEvent {
  kind: 'channel-opened';
  channelId: string;
  snapshot: AndroidConnectionServiceSnapshot;
}

export interface AndroidConnectionServiceChannelClosedEvent {
  kind: 'channel-closed';
  channelId: string;
}

export type AndroidConnectionServiceListenerMap = {
  androidConnectionSnapshot: AndroidConnectionServiceSnapshot;
  androidConnectionServerFrame: AndroidConnectionServiceServerFrame;
  androidConnectionChannelMessage: AndroidConnectionServiceChannelMessage;
  androidConnectionChannelOpened: AndroidConnectionServiceChannelOpenedEvent;
  androidConnectionChannelClosed: AndroidConnectionServiceChannelClosedEvent;
  androidConnectionError: AndroidConnectionServiceErrorEvent;
};

interface AndroidConnectionServiceNativePlugin {
  setManualRoutePolicy(options: { policy: AndroidConnectionServiceRoutePolicy }): Promise<{ ok: boolean }>;
  bindTarget(options: { target: AndroidConnectionServiceTarget }): Promise<{ ok: boolean }>;
  releaseTarget(options: { reason: string }): Promise<{ ok: boolean }>;
  openChannel(options: { channelId: string; sessionName: string; options?: Record<string, unknown> }): Promise<{ ok: boolean }>;
  sendChannelMessage(options: { channelId: string; message: Record<string, unknown> }): Promise<{ ok: boolean }>;
  sendChannelBinary(options: { channelId: string; dataBase64: string }): Promise<{ ok: boolean }>;
  closeChannel(options: { channelId: string; reason: string }): Promise<{ ok: boolean }>;
  readSnapshot(): Promise<AndroidConnectionServiceSnapshot>;
  addListener<EventName extends keyof AndroidConnectionServiceListenerMap>(
    eventName: EventName,
    listenerFunc: (event: AndroidConnectionServiceListenerMap[EventName]) => void,
  ): Promise<PluginListenerHandle>;
}

const AndroidConnectionService = registerPlugin<AndroidConnectionServiceNativePlugin>(
  'AndroidConnectionService',
  {
    web: () => ({
      setManualRoutePolicy: async () => ({ ok: false }),
      bindTarget: async () => ({ ok: false }),
      releaseTarget: async () => ({ ok: false }),
      openChannel: async () => ({ ok: false }),
      sendChannelMessage: async () => ({ ok: false }),
      sendChannelBinary: async () => ({ ok: false }),
      closeChannel: async () => ({ ok: false }),
      readSnapshot: async () => ({
        state: 'idle',
        generation: null,
        target: null,
        route: null,
        channels: [],
        lastHeartbeatAt: null,
        lastActivityAt: null,
        nextRetryAt: null,
        error: null,
      }),
      addListener: async () => ({ remove: async () => undefined }),
    }),
  },
);

export function sendAndroidConnectionCommand(command: AndroidConnectionCommand): Promise<{ ok: boolean }> {
  const parsed = parseAndroidConnectionCommand(command);
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return Promise.resolve({ ok: false });
  }
  switch (parsed.type) {
    case 'set-manual-route-policy':
      return AndroidConnectionService.setManualRoutePolicy({ policy: parsed.policy });
    case 'bind-target':
      return AndroidConnectionService.bindTarget({ target: parsed.target });
    case 'release-target':
      return AndroidConnectionService.releaseTarget({ reason: parsed.reason });
    case 'open-channel':
      return AndroidConnectionService.openChannel(parsed);
    case 'channel-message':
      return AndroidConnectionService.sendChannelMessage(parsed);
    case 'channel-binary':
      return AndroidConnectionService.sendChannelBinary(parsed);
    case 'close-channel':
      return AndroidConnectionService.closeChannel(parsed);
  }
}

export const AndroidConnectionServicePlugin = AndroidConnectionService;

export async function readAndroidConnectionServiceSnapshot(): Promise<AndroidConnectionServiceSnapshot> {
  return AndroidConnectionService.readSnapshot();
}

export function addAndroidConnectionServiceListener<EventName extends keyof AndroidConnectionServiceListenerMap>(
  eventName: EventName,
  listener: (event: AndroidConnectionServiceListenerMap[EventName]) => void,
): Promise<PluginListenerHandle> {
  return AndroidConnectionService.addListener(eventName, listener);
}

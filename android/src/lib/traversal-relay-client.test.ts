// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTraversalRelayDevicesStream,
  getDefaultTraversalRelayBaseUrl,
  normalizeTraversalRelayBaseUrl,
  readTraversalRelayAccountState,
  resolveTraversalRelayBaseUrl,
  traversalRelayLogin,
  writeTraversalRelayAccountState,
} from './traversal-relay-client';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

const directoryPayload = {
  schemaVersion: 1,
  user: {
    id: 'u1',
    username: 'jason',
  },
  updatedAt: '2026-06-28T10:00:00.000Z',
  devices: [
    {
      deviceId: 'daemon-device',
      deviceName: 'Jason Mac',
      platform: 'darwin',
      appVersion: '0.1.3',
      client: {
        connected: false,
        lastSeenAt: '',
      },
      daemon: {
        hostId: 'daemon-host',
        version: '0.1.3-daemon',
        presence: {
          connected: true,
          lastSeenAt: '2026-06-28T10:00:00.000Z',
        },
        endpoints: [
          {
            id: 'relay-rtc:daemon-host',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:00:00.000Z',
          },
        ],
        sessions: [
          {
            name: 'main',
            updatedAt: '2026-06-28T10:00:00.000Z',
          },
        ],
        lastPublishedAt: '2026-06-28T10:00:00.000Z',
      },
    },
  ],
};

describe('traversal relay client truth', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('normalizes relay base url to canonical /relay/ root', () => {
    expect(normalizeTraversalRelayBaseUrl('https://coder2.codewhisper.cc')).toBe(
      'https://coder2.codewhisper.cc/relay/',
    );
    expect(normalizeTraversalRelayBaseUrl('https://coder2.codewhisper.cc/relay/devices')).toBe(
      'https://coder2.codewhisper.cc/relay/',
    );
  });

  it('resolves empty relay base url to the built-in default login server', () => {
    expect(getDefaultTraversalRelayBaseUrl()).toBe('https://relay.codewhisper.cc/relay/');
    expect(resolveTraversalRelayBaseUrl('')).toBe(getDefaultTraversalRelayBaseUrl());
    expect(resolveTraversalRelayBaseUrl('   ')).toBe(getDefaultTraversalRelayBaseUrl());
    expect(resolveTraversalRelayBaseUrl('https://relay.example.com')).toBe('https://relay.example.com/relay/');
  });

  it('logs and returns null when stored relay account payload is invalid json', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.localStorage.setItem('zterm:traversal-relay-account', '{bad-json');

    expect(readTraversalRelayAccountState()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[traversal-relay-client] Failed to read account state:',
      expect.any(SyntaxError),
    );

    errorSpy.mockRestore();
  });

  it('stores account directory returned by relay login', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        accessToken: 'token-1',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        devices: [],
        directory: directoryPayload,
        relayBaseUrl: 'https://relay.example.com/relay/',
        ws: {
          devices: 'wss://relay.example.com/relay/ws/devices',
          host: 'wss://relay.example.com/relay/ws/host',
          client: 'wss://relay.example.com/relay/ws/client',
        },
      }),
    } as Response);

    const account = await traversalRelayLogin({
      relayBaseUrl: 'https://relay.example.com',
      username: 'jason',
      password: 'pw',
    });

    expect(account.directory?.devices[0]?.daemon?.hostId).toBe('daemon-host');
    expect(readTraversalRelayAccountState()?.directory?.devices[0]?.daemon?.sessions[0]?.name).toBe('main');
    expect(account.password).toBe('');
    expect(readTraversalRelayAccountState()?.password).toBe('');
  });

  it('rejects relay login responses that do not include a valid account directory', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        accessToken: 'token-1',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        devices: [],
        relayBaseUrl: 'https://relay.example.com/relay/',
        ws: {
          devices: 'wss://relay.example.com/relay/ws/devices',
          host: 'wss://relay.example.com/relay/ws/host',
          client: 'wss://relay.example.com/relay/ws/client',
        },
      }),
    } as Response);

    await expect(traversalRelayLogin({
      relayBaseUrl: 'https://relay.example.com',
      username: 'jason',
      password: 'pw',
    })).rejects.toThrow('relay account directory missing or invalid');
    expect(readTraversalRelayAccountState()).toBeNull();
  });

  it('persists directory snapshots from relay device stream without rewriting devices truth', () => {
    writeTraversalRelayAccountState({
      username: 'jason',
      password: 'pw',
      relayBaseUrl: 'https://relay.example.com/relay/',
      accessToken: 'token-1',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'android-1',
      deviceName: 'ZTerm Android',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: {
        relayBaseUrl: 'https://relay.example.com/relay/',
        accessToken: 'token-1',
        userId: 'u1',
        username: 'jason',
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
        wsHostUrl: 'wss://relay.example.com/relay/ws/host',
        wsClientUrl: 'wss://relay.example.com/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    });
    const onDevices = vi.fn();
    const onDirectory = vi.fn();
    const onError = vi.fn();
    const socket = connectTraversalRelayDevicesStream({
      account: readTraversalRelayAccountState()!,
      onDevices,
      onDirectory,
      onError,
    }) as unknown as MockWebSocket;

    socket.emitMessage({
      type: 'directory-snapshot',
      payload: { directory: directoryPayload },
    });

    expect(onDevices).not.toHaveBeenCalled();
    expect(onDirectory).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      user: { id: 'u1', username: 'jason' },
    }));
    expect(onError).not.toHaveBeenCalled();
    expect(readTraversalRelayAccountState()?.directory?.devices[0]?.daemon?.endpoints[0]?.kind).toBe('relay-rtc');
  });
});

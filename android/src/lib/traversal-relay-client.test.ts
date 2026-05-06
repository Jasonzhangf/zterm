// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readTraversalRelayAccountState,
  traversalRelayLogin,
  traversalRelayRefreshMe,
} from './traversal-relay-client';

vi.stubGlobal('__APP_VERSION__', '0.1.1-test');
vi.stubGlobal('__APP_VERSION_CODE__', '101');

describe('traversal relay client url truth', () => {
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
        clear: () => {
          storage.clear();
        },
      },
    });
    vi.restoreAllMocks();
  });

  it('normalizes bare base host into /relay/ and preserves trailing slash for requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          accessToken: 'token-1',
          user: { id: 'u1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
          devices: [],
          relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
          ws: {
            devices: 'wss://coder2.codewhisper.cc/relay/ws/devices',
            host: 'wss://coder2.codewhisper.cc/relay/ws/host',
            client: 'wss://coder2.codewhisper.cc/relay/ws/client',
          },
          turn: {
            url: 'turn:154.40.36.9:3479?transport=udp',
            username: 'ztermturn',
            credential: 'pw',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          user: { id: 'u1', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
          devices: [],
          relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
          ws: {
            devices: 'wss://coder2.codewhisper.cc/relay/ws/devices',
            host: 'wss://coder2.codewhisper.cc/relay/ws/host',
            client: 'wss://coder2.codewhisper.cc/relay/ws/client',
          },
          turn: {
            url: 'turn:154.40.36.9:3479?transport=udp',
            username: 'ztermturn',
            credential: 'pw',
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const account = await traversalRelayLogin({
      relayBaseUrl: 'https://coder2.codewhisper.cc',
      username: 'jason',
      password: 'pw',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://coder2.codewhisper.cc/relay/api/auth/login');
    expect(account.relayBaseUrl).toBe('https://coder2.codewhisper.cc/relay/');
    expect(readTraversalRelayAccountState()?.relayBaseUrl).toBe('https://coder2.codewhisper.cc/relay/');

    await traversalRelayRefreshMe(account);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://coder2.codewhisper.cc/relay/api/auth/me');
  });

  it('accepts full relay paths like /relay/login and still targets the relay api root', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        accessToken: 'token-2',
        user: { id: 'u2', username: 'jason', createdAt: '2026-05-06T00:00:00Z' },
        devices: [],
        relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
        ws: {
          devices: 'wss://coder2.codewhisper.cc/relay/ws/devices',
          host: 'wss://coder2.codewhisper.cc/relay/ws/host',
          client: 'wss://coder2.codewhisper.cc/relay/ws/client',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await traversalRelayLogin({
      relayBaseUrl: 'https://coder2.codewhisper.cc/relay/login',
      username: 'jason',
      password: 'pw',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://coder2.codewhisper.cc/relay/api/auth/login');
  });
});

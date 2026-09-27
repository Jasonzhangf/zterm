// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/traversal-relay-client', async () => {
  const actual = await vi.importActual<typeof import('../lib/traversal-relay-client')>('../lib/traversal-relay-client');
  return {
    ...actual,
    readTraversalRelayAccountState: vi.fn(() => ({
      username: 'jason',
      password: 'pw',
      relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
      accessToken: 'token',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: {
        relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
        accessToken: 'token',
        userId: 'u1',
        username: 'jason',
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        wsDevicesUrl: 'wss://coder2.codewhisper.cc/relay/ws/devices',
        wsHostUrl: 'wss://coder2.codewhisper.cc/relay/ws/host',
        wsClientUrl: 'wss://coder2.codewhisper.cc/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    })),
    traversalRelayRegister: vi.fn(),
    traversalRelayLogin: vi.fn(),
    traversalRelayRefreshMe: vi.fn(),
    writeTraversalRelayAccountState: vi.fn(),
  };
});

import * as relayClient from '../lib/traversal-relay-client';
import { useTraversalRelayAccount } from './useTraversalRelayAccount';

describe('useTraversalRelayAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps relay account hook as pure account state owner and does not open device streams itself', () => {
    const connectSpy = vi.spyOn(relayClient, 'connectTraversalRelayDevicesStream');
    renderHook(() => useTraversalRelayAccount());
    expect(relayClient.traversalRelayRefreshMe).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('projects global relay runtime account changes without refreshing or opening a stream itself', async () => {
    const connectSpy = vi.spyOn(relayClient, 'connectTraversalRelayDevicesStream');
    const { result } = renderHook(() => useTraversalRelayAccount());
    expect(result.current.relayDevices).toEqual([]);

    vi.mocked(relayClient.readTraversalRelayAccountState).mockReturnValue({
      username: 'jason',
      password: '',
      relayBaseUrl: 'https://coder2.codewhisper.cc/relay/',
      accessToken: 'token',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android',
      devices: [{
        deviceId: 'daemon-online',
        deviceName: 'Mac Studio',
        platform: 'mac',
        appVersion: '0.1.3',
        updatedAt: new Date().toISOString(),
        client: { connected: false, lastSeenAt: new Date().toISOString() },
        daemon: {
          connected: true,
          lastSeenAt: new Date().toISOString(),
          hostId: 'daemon-host-online',
          version: '0.1.3',
        },
      }],
      directory: null,
      updatedAt: 2,
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('traversal-relay-account-change'));
    });

    expect(result.current.account?.updatedAt).toBe(2);
    expect(result.current.relayDevices).toEqual([
      expect.objectContaining({
        deviceId: 'daemon-online',
        daemon: expect.objectContaining({ hostId: 'daemon-host-online' }),
      }),
    ]);
    expect(relayClient.traversalRelayRefreshMe).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('uses the built-in relay login server when the user leaves Relay Base URL empty', async () => {
    vi.mocked(relayClient.traversalRelayLogin).mockResolvedValueOnce({
      username: 'jason',
      password: 'pw',
      relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
      accessToken: 'token',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: {
        relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
        accessToken: 'token',
        userId: 'u1',
        username: 'jason',
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
        wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
        wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    });

    const { result } = renderHook(() => useTraversalRelayAccount());
    await act(async () => {
      await result.current.syncRelay('login', {
        relayBaseUrl: '',
        username: 'jason',
        password: 'pw',
      });
    });

    expect(relayClient.traversalRelayLogin).toHaveBeenCalledWith({
      relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
      username: 'jason',
      password: 'pw',
    });
  });

  it('keeps fixed relay login on the built-in server even when upgraded settings still contain the old URL', async () => {
    vi.mocked(relayClient.traversalRelayLogin).mockResolvedValueOnce({
      username: 'jason',
      password: 'pw',
      relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
      accessToken: 'token',
      user: { id: 'u1', username: 'jason', createdAt: 'now' },
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android',
      devices: [],
      directory: null,
      updatedAt: 1,
      relaySettings: {
        relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
        accessToken: 'token',
        userId: 'u1',
        username: 'jason',
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
        wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
        wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    });

    const { result } = renderHook(() => useTraversalRelayAccount({
      relayBaseUrl: 'https://relay.codewhisper.cc/relay/',
      accessToken: 'old-token',
      userId: 'u1',
      username: 'jason',
      deviceId: 'tablet-1',
      deviceName: 'Jason Tablet',
      platform: 'android',
      wsDevicesUrl: 'wss://relay.codewhisper.cc/relay/ws/devices',
      wsHostUrl: 'wss://relay.codewhisper.cc/relay/ws/host',
      wsClientUrl: 'wss://relay.codewhisper.cc/relay/ws/client',
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
      updatedAt: 1,
    }));

    await act(async () => {
      await result.current.syncRelay('login', {
        relayBaseUrl: '',
        username: 'jason',
        password: 'pw',
      }, {
        relayBaseUrl: 'https://relay.codewhisper.cc/relay/',
        accessToken: 'old-token',
        userId: 'u1',
        username: 'jason',
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.codewhisper.cc/relay/ws/devices',
        wsHostUrl: 'wss://relay.codewhisper.cc/relay/ws/host',
        wsClientUrl: 'wss://relay.codewhisper.cc/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      });
    });

    expect(relayClient.traversalRelayLogin).toHaveBeenCalledWith({
      relayBaseUrl: relayClient.getDefaultTraversalRelayBaseUrl(),
      username: 'jason',
      password: 'pw',
    });
  });

  it('clears relay account truth and local account projection on logout', () => {
    const { result } = renderHook(() => useTraversalRelayAccount());
    act(() => result.current.logoutRelay());
    expect(relayClient.writeTraversalRelayAccountState).toHaveBeenCalledWith(null);
    expect(result.current.account).toBeNull();
    expect(result.current.relayDevices).toEqual([]);
  });
});

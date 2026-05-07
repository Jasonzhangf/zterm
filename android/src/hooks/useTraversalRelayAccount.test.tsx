// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
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
    connectTraversalRelayDevicesStream: vi.fn(() => ({
      close: vi.fn(() => {
        throw new Error('close failed');
      }),
    })),
    traversalRelayRegister: vi.fn(),
    traversalRelayLogin: vi.fn(),
    traversalRelayRefreshMe: vi.fn(),
    writeTraversalRelayAccountState: vi.fn(),
  };
});

import { useTraversalRelayAccount } from './useTraversalRelayAccount';

describe('useTraversalRelayAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs relay device stream close failures instead of silently swallowing them', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useTraversalRelayAccount());

    unmount();

    expect(errorSpy).toHaveBeenCalledWith(
      '[useTraversalRelayAccount] Failed to close relay device stream:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

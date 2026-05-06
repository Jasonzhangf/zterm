import { useCallback, useEffect, useState } from 'react';
import type { TraversalRelayClientSettings } from '../lib/bridge-settings';
import {
  connectTraversalRelayDevicesStream,
  readTraversalRelayAccountState,
  traversalRelayLogin,
  traversalRelayRefreshMe,
  traversalRelayRegister,
  writeTraversalRelayAccountState,
  type TraversalRelayAccountState,
} from '../lib/traversal-relay-client';
import type { TraversalRelayDeviceSnapshot } from '../lib/types';

interface RelayDraftAccount {
  username: string;
  password: string;
  relayBaseUrl: string;
}

function buildFallbackRefreshAccount(
  draft: RelayDraftAccount,
  relaySettings?: TraversalRelayClientSettings,
): TraversalRelayAccountState {
  return {
    username: draft.username.trim(),
    password: draft.password,
    relayBaseUrl: draft.relayBaseUrl.trim(),
    accessToken: relaySettings?.accessToken || '',
    user: null,
    deviceId: relaySettings?.deviceId || 'zterm-android',
    deviceName: relaySettings?.deviceName || 'ZTerm Android',
    platform: relaySettings?.platform || 'android',
    devices: [],
    updatedAt: Date.now(),
    relaySettings,
  };
}

export function useTraversalRelayAccount(initialRelaySettings?: TraversalRelayClientSettings) {
  const [account, setAccount] = useState<TraversalRelayAccountState | null>(() => readTraversalRelayAccountState());
  const [relayStatus, setRelayStatus] = useState('');
  const [relayBusy, setRelayBusy] = useState<'login' | 'register' | 'refresh' | null>(null);
  const [relayDevices, setRelayDevices] = useState<TraversalRelayDeviceSnapshot[]>(() => account?.devices || []);

  const refreshLocalAccount = useCallback(() => {
    const nextAccount = readTraversalRelayAccountState();
    setAccount(nextAccount);
    setRelayDevices(nextAccount?.devices || []);
    return nextAccount;
  }, []);

  useEffect(() => {
    refreshLocalAccount();
  }, [refreshLocalAccount, initialRelaySettings?.accessToken, initialRelaySettings?.relayBaseUrl]);

  useEffect(() => {
    if (!account?.accessToken || !account.relayBaseUrl) {
      return;
    }
    let cancelled = false;
    let socket: WebSocket | null = null;
    try {
      socket = connectTraversalRelayDevicesStream({
        account,
        onDevices: (devices) => {
          if (cancelled) {
            return;
          }
          setRelayDevices(devices);
          setAccount((current) => current ? { ...current, devices, updatedAt: Date.now() } : current);
        },
        onError: (message) => {
          if (!cancelled) {
            setRelayStatus(message);
          }
        },
      });
    } catch (error) {
      setRelayStatus(error instanceof Error ? error.message : String(error));
    }
    return () => {
      cancelled = true;
      try {
        socket?.close(1000, 'settings disposed');
      } catch {}
    };
  }, [account]);

  const syncRelay = useCallback(async (
    mode: 'login' | 'register' | 'refresh',
    draft: RelayDraftAccount,
    relaySettings?: TraversalRelayClientSettings,
  ) => {
    const baseUrl = draft.relayBaseUrl.trim();
    if (!baseUrl) {
      setRelayStatus('先填写 Relay Base URL');
      return null;
    }
    setRelayBusy(mode);
    setRelayStatus(mode === 'register' ? '注册中…' : mode === 'login' ? '登录中…' : '刷新中…');
    try {
      if (mode === 'register') {
        if (!draft.username.trim() || !draft.password.trim()) {
          throw new Error('先填写用户名和密码');
        }
        await traversalRelayRegister({
          relayBaseUrl: baseUrl,
          username: draft.username,
          password: draft.password,
        });
      }

      const relayResult = mode === 'refresh'
        ? await traversalRelayRefreshMe(readTraversalRelayAccountState() || buildFallbackRefreshAccount(draft, relaySettings))
        : undefined;

      const nextAccount = mode === 'refresh'
        ? relayResult!.account
        : await traversalRelayLogin({
            relayBaseUrl: baseUrl,
            username: draft.username,
            password: draft.password,
          });

      const nextRelaySettings = mode === 'refresh' ? relayResult!.relaySettings : nextAccount.relaySettings;
      if (!nextRelaySettings) {
        throw new Error('relay 控制面返回不完整，缺少 ws/control 信息');
      }

      writeTraversalRelayAccountState(nextAccount);
      setAccount(nextAccount);
      setRelayDevices(nextAccount.devices);
      setRelayStatus(`已登录 ${nextAccount.user?.username || draft.username} · device=${nextAccount.deviceId}`);
      return {
        account: nextAccount,
        relaySettings: nextRelaySettings,
      };
    } catch (error) {
      setRelayStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setRelayBusy(null);
    }
  }, []);

  return {
    account,
    relayDevices,
    relayStatus,
    relayBusy,
    refreshLocalAccount,
    syncRelay,
  };
}

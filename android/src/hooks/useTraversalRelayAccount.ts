import { useCallback, useEffect, useState } from 'react';
import type { TraversalRelayClientSettings } from '../lib/bridge-settings';
import {
  readTraversalRelayAccountState,
  resolveTraversalRelayBaseUrl,
  traversalRelayLogin,
  traversalRelayRefreshMe,
  traversalRelayRegister,
  writeTraversalRelayAccountState,
  type TraversalRelayAccountState,
} from '../lib/traversal-relay-client';
import { projectRelayDirectoryDeviceSnapshots } from '../lib/relay-account-directory';
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
  const relayBaseUrl = resolveTraversalRelayBaseUrl(draft.relayBaseUrl || relaySettings?.relayBaseUrl);
  return {
    username: draft.username.trim(),
    password: draft.password,
    relayBaseUrl,
    accessToken: relaySettings?.accessToken || '',
    user: null,
    deviceId: relaySettings?.deviceId || 'zterm-android',
    deviceName: relaySettings?.deviceName || 'ZTerm Android',
    platform: relaySettings?.platform || 'android',
    devices: [],
    directory: null,
    updatedAt: Date.now(),
    relaySettings,
  };
}

function projectRelayDevicesFromAccountState(account: TraversalRelayAccountState | null) {
  if (!account) {
    return [];
  }
  const directoryDevices = projectRelayDirectoryDeviceSnapshots(account.directory);
  return directoryDevices.length > 0 ? directoryDevices : account.devices;
}

export function useTraversalRelayAccount(initialRelaySettings?: TraversalRelayClientSettings) {
  const [account, setAccount] = useState<TraversalRelayAccountState | null>(() => readTraversalRelayAccountState());
  const [relayStatus, setRelayStatus] = useState('');
  const [relayBusy, setRelayBusy] = useState<'login' | 'register' | 'refresh' | null>(null);
  const [relayDevices, setRelayDevices] = useState<TraversalRelayDeviceSnapshot[]>(() => projectRelayDevicesFromAccountState(account));

  const refreshLocalAccount = useCallback(() => {
    const nextAccount = readTraversalRelayAccountState();
    setAccount(nextAccount);
    setRelayDevices(projectRelayDevicesFromAccountState(nextAccount));
    return nextAccount;
  }, []);

  useEffect(() => {
    refreshLocalAccount();
  }, [refreshLocalAccount, initialRelaySettings?.accessToken, initialRelaySettings?.relayBaseUrl]);

  const syncRelay = useCallback(async (
    mode: 'login' | 'register' | 'refresh',
    draft: RelayDraftAccount,
    relaySettings?: TraversalRelayClientSettings,
  ) => {
    const baseUrl = resolveTraversalRelayBaseUrl(draft.relayBaseUrl || relaySettings?.relayBaseUrl);
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
      setRelayDevices(projectRelayDevicesFromAccountState(nextAccount));
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

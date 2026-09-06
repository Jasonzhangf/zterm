import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeSettings, TraversalRelayClientSettings } from '../lib/bridge-settings';
import { applyTraversalRelaySettings } from '../lib/traversal-relay-client';
import {
  connectTraversalRelayDevicesStream,
  readTraversalRelayAccountState,
  sendTraversalRelayClientDebugLogs,
  sendTraversalRelayClientDebugSnapshot,
  traversalRelayRefreshMe,
  writeTraversalRelayAccountState,
  type TraversalRelayAccountState,
} from '../lib/traversal-relay-client';
import { collectClientDebugSnapshot } from '../lib/client-debug-snapshot';
import {
  projectRelayDirectoryDeviceSnapshots,
  type RelayAccountDirectory,
} from '../lib/relay-account-directory';
import {
  areTraversalRelaySettingsEqual,
  createRelayDeviceStreamRuntime,
} from '../lib/relay-device-stream-runtime';
import { runtimeDebug } from '../lib/runtime-debug';
import { projectOnlineTraversalRelayDaemonDevicesFromAccount } from '../lib/traversal-relay-devices';
import type { TraversalRelayDeviceSnapshot } from '../lib/types';
import { defaultClientControlDirectoryRuntime } from '../lib/client-control-directory-runtime';
import type { BridgeSettingsWriteResult } from '@zterm/shared';

type SetBridgeSettings = (
  next: BridgeSettings | ((current: BridgeSettings) => BridgeSettings),
) => BridgeSettingsWriteResult;

function projectRelayDevicesFromAccountState(account: TraversalRelayAccountState | null | undefined) {
  return projectOnlineTraversalRelayDaemonDevicesFromAccount(account);
}

export function useRelayDeviceStream(options: {
  bridgeSettings: BridgeSettings;
  setBridgeSettings: SetBridgeSettings;
  onPersistenceError?: (error: unknown) => void;
}) {
  const [relayDevices, setRelayDevices] = useState<TraversalRelayDeviceSnapshot[]>(() => (
    projectRelayDevicesFromAccountState(readTraversalRelayAccountState())
  ));
  const runtimeRef = useRef<ReturnType<typeof createRelayDeviceStreamRuntime> | null>(null);
  const setBridgeSettingsRef = useRef<SetBridgeSettings>(options.setBridgeSettings);
  const onPersistenceErrorRef = useRef(options.onPersistenceError);
  const refreshControlDirectory = useCallback((reason: string) => (
    runtimeRef.current?.refreshNow(reason) || Promise.resolve(false)
  ), []);

  useEffect(() => {
    setBridgeSettingsRef.current = options.setBridgeSettings;
    onPersistenceErrorRef.current = options.onPersistenceError;
  }, [options.onPersistenceError, options.setBridgeSettings]);

  const persistBridgeSettings = useCallback((next: Parameters<SetBridgeSettings>[0]) => {
    const result = setBridgeSettingsRef.current(next);
    if (!result || !result.ok) {
      onPersistenceErrorRef.current?.(
        result?.error || new Error('桥接设置持久化未返回结果'),
      );
    }
    return result;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handler = () => {
      const next = readTraversalRelayAccountState();
      const projectedDevices = projectRelayDevicesFromAccountState(next);
      setRelayDevices(projectedDevices);
      const nextRelay = next?.relaySettings;
      if (!nextRelay) {
        return;
      }
      if (areTraversalRelaySettingsEqual(options.bridgeSettings.traversalRelay, nextRelay)) {
        return;
      }
      persistBridgeSettings((current) => {
        const currentRelay = current.traversalRelay;
        if (areTraversalRelaySettingsEqual(currentRelay, nextRelay)) {
          return current;
        }
        return applyTraversalRelaySettings(current, nextRelay);
      });
    };
    handler();
    window.addEventListener('traversal-relay-account-change', handler);
    return () => window.removeEventListener('traversal-relay-account-change', handler);
  }, [options.bridgeSettings.traversalRelay, persistBridgeSettings]);

  useEffect(() => {
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => {
        const account = readTraversalRelayAccountState();
        if (!options.bridgeSettings.traversalRelay?.accessToken || !account?.accessToken || !account.relayBaseUrl) {
          return null;
        }
        return account;
      },
      refreshAccount: async (account) => {
        if (!account) {
          throw new Error('relay account missing or disabled');
        }
        return traversalRelayRefreshMe(account as TraversalRelayAccountState);
      },
      projectDevicesFromAccount: (account) => projectRelayDevicesFromAccountState(
        account as TraversalRelayAccountState | null | undefined,
      ),
      connectDevicesStream: (streamOptions) => connectTraversalRelayDevicesStream({
        account: streamOptions.account as TraversalRelayAccountState,
        onOpen: streamOptions.onOpen,
        onDevices: (devices) => {
          streamOptions.onDevices?.(devices);
        },
        onDirectory: (directory) => {
          streamOptions.onDirectory?.(directory);
        },
        onError: streamOptions.onError,
        onClose: streamOptions.onClose,
        onDebugRequest: streamOptions.onDebugRequest,
        onControlPong: streamOptions.onControlPong,
      }),
      projectDirectoryDevices: (directory) => projectRelayDirectoryDeviceSnapshots(
        directory as RelayAccountDirectory | null | undefined,
      ),
      setDevices: setRelayDevices,
      publishDirectoryTruth: (devices, state, relaySettings) => {
        if (state === 'confirmed') {
          defaultClientControlDirectoryRuntime.replaceFromDevices(devices, relaySettings);
          return;
        }
        defaultClientControlDirectoryRuntime.markUnconfirmed();
      },
      applyRelaySettings: (settings: TraversalRelayClientSettings) => {
        persistBridgeSettings((current) => (
          areTraversalRelaySettingsEqual(current.traversalRelay, settings)
            ? current
            : applyTraversalRelaySettings(current, settings)
        ));
      },
      invalidateAuthentication: (reason) => {
        runtimeDebug('relay.account.invalidated', { reason });
        writeTraversalRelayAccountState(null);
        setRelayDevices([]);
        defaultClientControlDirectoryRuntime.clear();
        persistBridgeSettings((current) => (
          current.traversalRelay
            ? applyTraversalRelaySettings(current, undefined)
            : current
        ));
      },
      runtimeDebug: (event, payload) => {
        runtimeDebug(event, payload || {});
      },
      onDebugRequest: (payload, liveSocket, account) => {
        const typedAccount = account as TraversalRelayAccountState;
        if (payload.includeSnapshot !== false) {
          sendTraversalRelayClientDebugSnapshot({
            socket: liveSocket,
            account: typedAccount,
            requestId: payload.requestId,
            reason: payload.reason || 'remote-request',
            snapshot: collectClientDebugSnapshot({
              requestId: payload.requestId || null,
              reason: payload.reason || null,
            }),
          });
        }
        if (payload.includeLogs !== false) {
          sendTraversalRelayClientDebugLogs({
            socket: liveSocket,
            account: typedAccount,
            limit: payload.logLimit || 120,
          });
        }
      },
    });

    runtimeRef.current = runtime;
    runtime.start();
    return () => {
      // Stop invalidates the generation before socket close callbacks run, so
      // cleanup must explicitly revoke the last confirmed directory snapshot.
      defaultClientControlDirectoryRuntime.markUnconfirmed();
      runtime.stop('app relay runtime disposed');
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [
    options.bridgeSettings.traversalRelay?.accessToken,
    options.bridgeSettings.traversalRelay?.relayBaseUrl,
    persistBridgeSettings,
  ]);

  return {
    relayDevices,
    refreshControlDirectory,
  };
}

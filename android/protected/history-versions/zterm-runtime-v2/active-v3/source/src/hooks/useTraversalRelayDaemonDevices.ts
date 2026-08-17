import { useCallback, useEffect, useState } from 'react';
import type { TraversalRelayDeviceSnapshot } from '../lib/types';
import { readOnlineTraversalRelayDaemonDevices } from '../lib/traversal-relay-devices';

export function useTraversalRelayDaemonDevices(enabled: boolean) {
  const [devices, setDevices] = useState<TraversalRelayDeviceSnapshot[]>([]);

  const refresh = useCallback(() => {
    if (!enabled) {
      setDevices([]);
      return;
    }
    setDevices(readOnlineTraversalRelayDaemonDevices());
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    devices,
    refresh,
  };
}

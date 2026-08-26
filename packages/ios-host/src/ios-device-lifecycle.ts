import type { Disposable } from '@zterm/runtime-contracts';

export const IOS_LIFECYCLE_CHANNEL = 'zterm:ios:lifecycle' as const;
export type IosDeviceLifecycleSignal = 'foreground-resume' | 'background-entered' | 'memory-warning' | 'low-battery' | 'network-status-change';

export function isIosDeviceLifecycleSignal(value: unknown): value is IosDeviceLifecycleSignal {
  return value === 'foreground-resume' || value === 'background-entered' || value === 'memory-warning' || value === 'low-battery' || value === 'network-status-change';
}

export function projectAppStateChange(appState: { isActive: boolean; isMultiTasking: boolean; batteryLevel?: number }): IosDeviceLifecycleSignal {
  if (!appState.isActive) return 'background-entered';
  if (appState.batteryLevel !== undefined && appState.batteryLevel < 0.2) return 'low-battery';
  return 'foreground-resume';
}

export interface IosDeviceLifecycleBridge {
  getAppState(): { isActive: boolean; isMultiTasking: boolean; batteryLevel?: number };
  addAppStateListener(listener: (state: { isActive: boolean; isMultiTasking: boolean }) => void): Disposable;
}

export function createIosDeviceLifecycleManager(bridge: IosDeviceLifecycleBridge) {
  return {
    getCurrentSignal: () => projectAppStateChange(bridge.getAppState()),
    subscribe: (listener: (signal: IosDeviceLifecycleSignal) => void): Disposable =>
      bridge.addAppStateListener((state) => listener(projectAppStateChange(state))),
  };
}

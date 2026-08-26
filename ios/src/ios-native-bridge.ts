import {
  createIosCapacitorAdapter,
  createIosDeviceLifecycleManager,
  createIosImeManager,
  createIosPermissionsManager,
  type IosHostGateway,
  type IosHostTransport,
  type IosImeBridge,
  type IosPermissionsBridge,
  type IosWebViewBridge,
} from '@zterm/ios-host';
import type { RuntimeEvent } from '@zterm/runtime-contracts';

export interface IosNativeHost {
  readonly gateway: IosHostGateway;
  readonly lifecycle: ReturnType<typeof createIosDeviceLifecycleManager>;
  readonly permissions: ReturnType<typeof createIosPermissionsManager>;
  readonly ime: ReturnType<typeof createIosImeManager>;
  subscribeEvents(listener: (event: RuntimeEvent) => void): () => void;
}

/**
 * Composition boundary for the native iOS shell. Native objects are adapted
 * into the framework-neutral contracts before they reach application code.
 */
export function createIosNativeHost(
  bridge: IosWebViewBridge,
  transport: IosHostTransport,
  lifecycleBridge: Parameters<typeof createIosDeviceLifecycleManager>[0],
  permissionsBridge: IosPermissionsBridge,
  imeBridge: IosImeBridge,
): IosNativeHost {
  const adapter = createIosCapacitorAdapter(bridge);
  return {
    gateway: adapter.gateway(transport),
    lifecycle: createIosDeviceLifecycleManager(lifecycleBridge),
    permissions: createIosPermissionsManager(permissionsBridge),
    ime: createIosImeManager(imeBridge),
    subscribeEvents(listener) {
      return adapter.subscribe(listener);
    },
  };
}

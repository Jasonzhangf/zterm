import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');
const repoRoot = resolve(__dirname, '../../..');

function readRepo(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('Android network identity plugin', () => {
  it('registers the NetworkIdentityPlugin with Capacitor', () => {
    const activity = readFileSync(resolve(androidRoot, 'java/com/zterm/android/MainActivity.java'), 'utf8');
    const plugin = readFileSync(resolve(androidRoot, 'java/com/zterm/android/NetworkIdentityPlugin.java'), 'utf8');

    expect(activity).toContain('registerPlugin(NetworkIdentityPlugin.class)');
    expect(plugin).toContain('@CapacitorPlugin(name = "NetworkIdentity")');
    expect(plugin).toContain('public void snapshot(PluginCall call)');
    expect(plugin).toContain('cm.getActiveNetwork()');
    expect(plugin).not.toContain('cm.getAllNetworks()');
    expect(plugin).toContain('TRANSPORT_WIFI');
    expect(plugin).toContain('TRANSPORT_CELLULAR');
    expect(plugin).toContain('TRANSPORT_VPN');
  });

  it('exposes a JS wrapper that reads local interfaces through Capacitor', () => {
    const wrapper = readFileSync(
      resolve(__dirname, '../plugins/NetworkIdentityPlugin.ts'),
      'utf8',
    );

    expect(wrapper).toContain('registerPlugin<NetworkIdentityPluginShape>(\n  "NetworkIdentity"');
    expect(wrapper).toContain('snapshot(): Promise<NetworkIdentitySnapshot>');
    expect(wrapper).toContain('isNativeNetworkIdentitySupported');
    expect(wrapper).toContain('readNativeNetworkIdentitySnapshot');
  });

  it('binds the native producer to the client.daemon_connection module in both registry maps', () => {
    const appsdkMap = JSON.parse(readRepo('android/.appsdk/maps/module-registry.json')) as {
      modules: Array<{ module_id: string; owned_paths: string[]; verification_gates?: string[] }>;
    };
    const docsMap = JSON.parse(readRepo('android/docs/module-registry.json')) as {
      modules: Array<{ module_id: string; owned_paths: string[] }>;
    };
    const nativePath = 'native/android/app/src/main/java/com/zterm/android/NetworkIdentityPlugin.java';

    const appsdkOwner = appsdkMap.modules.find((module) => module.owned_paths.includes(nativePath));
    const docsOwner = docsMap.modules.find((module) => module.owned_paths.includes(nativePath));

    expect(appsdkOwner?.module_id, 'appsdk map must own the native producer').toBe('client.daemon_connection');
    expect(docsOwner?.module_id, 'docs map must own the native producer').toBe('client.daemon_connection');
    expect(appsdkOwner?.verification_gates, 'appsdk owner must declare android_network_identity gate').toContain('android_network_identity');
  });

  it('registers the platform_network_signal resource against client.daemon_connection in the AppSDK resource map', () => {
    const appsdkResources = JSON.parse(readRepo('android/.appsdk/maps/resource-map.json')) as {
      resources: Array<{
        resource_id: string;
        owner: string;
        truth_store: string;
        binding_paths: string[];
        required_gates?: string[];
        status: string;
      }>;
    };
    const signal = appsdkResources.resources.find((resource) => resource.resource_id === 'resource.platform_network_signal');

    expect(signal, 'appsdk resource map must contain resource.platform_network_signal').toBeDefined();
    expect(signal?.owner).toBe('client.daemon_connection');
    expect(signal?.status).toBe('active');
    expect(signal?.binding_paths).toContain('native/android/app/src/main/java/com/zterm/android/NetworkIdentityPlugin.java');
    expect(signal?.binding_paths).toContain('src/plugins/NetworkIdentityPlugin.ts');
    expect(signal?.required_gates ?? []).toContain('android_network_identity');
  });

  it('registers the native snapshot producer in the AppSDK function and verification maps', () => {
    const functions = JSON.parse(readRepo('android/.appsdk/maps/function-map.json')) as {
      functions: Array<{
        function_id: string;
        owner: string;
        entry_symbols: string[];
        binding_paths: string[];
        required_gates: string[];
      }>;
    };
    const gates = JSON.parse(readRepo('android/.appsdk/maps/verification-map.json')) as {
      gates: Array<{
        gate_id: string;
        command: string;
        binding_paths: string[];
        status: string;
      }>;
    };

    const nativeFunc = functions.functions.find((fn) => fn.function_id === 'android_network_identity_snapshot');
    expect(nativeFunc?.owner).toBe('client.daemon_connection');
    expect(nativeFunc?.entry_symbols).toContain('NetworkIdentityPlugin#snapshot');
    expect(nativeFunc?.entry_symbols).toContain('NetworkIdentityPlugin#buildSnapshot');
    expect(nativeFunc?.binding_paths).toContain('native/android/app/src/main/java/com/zterm/android/NetworkIdentityPlugin.java');
    expect(nativeFunc?.required_gates).toContain('android_network_identity');

    const gate = gates.gates.find((entry) => entry.gate_id === 'android_network_identity');
    expect(gate?.status).toBe('active');
    expect(gate?.command).toContain('android-network-identity-truth.test.ts');
    expect(gate?.binding_paths).toContain('native/android/app/src/main/java/com/zterm/android/NetworkIdentityPlugin.java');
  });
});

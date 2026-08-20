import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { requireNativeNetworkInterfaces } from '../plugins/NetworkIdentityPlugin';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');
const repoRoot = resolve(__dirname, '../../..');

function readRepo(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readRepoBytes(relativePath: string): Buffer {
  return readFileSync(resolve(repoRoot, relativePath));
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
    expect(plugin).toContain('entry.put("name", ifaceName != null ? ifaceName : "")');
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
    const wrapperPath = 'src/plugins/NetworkIdentityPlugin.ts';

    expect(appsdkOwner?.module_id, 'appsdk map must own the native producer').toBe('client.daemon_connection');
    expect(docsOwner?.module_id, 'docs map must own the native producer').toBe('client.daemon_connection');
    expect(appsdkOwner?.verification_gates, 'appsdk owner must declare android_network_identity gate').toContain('android_network_identity');
    expect(appsdkMap.modules.find((module) => module.owned_paths.includes(wrapperPath))?.module_id).toBe('client.daemon_connection');
    expect(docsMap.modules.find((module) => module.owned_paths.includes(wrapperPath))?.module_id).toBe('client.daemon_connection');

    for (const [path, owner] of [
      ['src/lib/network-identity.test.ts', 'client.daemon_connection'],
      ['src/hooks/useOpenTabLifecycleEffects.test.tsx', 'client.session_runtime'],
      ['src/App.dynamic-refresh.test.tsx', 'client.app_shell'],
    ] as const) {
      expect(
        appsdkMap.modules.find((module) => module.owned_paths.includes(path))?.module_id,
        `appsdk map must own ${path}`,
      ).toBe(owner);
      expect(
        docsMap.modules.find((module) => module.owned_paths.includes(path))?.module_id,
        `docs map must own ${path}`,
      ).toBe(owner);
    }
  });

  it('keeps the platform signal in the project resource registry', () => {
    const canonical = JSON.parse(readRepo('android/docs/resource-registry.json')) as {
      resources: Array<{
        resource_id: string;
        owner_feature: string;
        allowed_operations: string[];
        truth_store: string;
        required_gates: string[];
      }>;
    };
    const canonicalSignal = canonical.resources.find((resource) => resource.resource_id === 'resource.platform_network_signal');
    expect(canonicalSignal?.owner_feature).toBe('terminal.transport_lifecycle');
    expect(canonicalSignal?.truth_store).toContain('NetworkIdentityPlugin.java');
    expect(canonicalSignal?.required_gates).toContain('src/lib/android-network-identity-truth.test.ts');
  });

  it('binds the typed native-error relay and bounded daemon error slot', () => {
    const featureRegistry = JSON.parse(readRepo('android/docs/feature-registry.json')) as {
      features: Array<{ feature_id: string; allowed_paths: string[]; required_gates: string[] }>;
    };
    const feature = featureRegistry.features.find((entry) => entry.feature_id === 'android_network_identity_snapshot');
    expect(feature?.allowed_paths).toEqual(expect.arrayContaining([
      'src/contexts/session-context-target-network-probe-runtime.ts',
      'src/contexts/session-context-target-network-probe-runtime.test.ts',
      'src/contexts/session-context-transport-orchestration-runtime.ts',
      'src/contexts/session-context-transport-orchestration-runtime.test.ts',
      'src/hooks/useOpenTabLifecycleEffects.ts',
      'src/lib/client-daemon-connection.ts',
      'src/lib/client-daemon-connection.test.ts',
    ]));
    expect(feature?.required_gates).toEqual(expect.arrayContaining([
      'src/contexts/session-context-target-network-probe-runtime.test.ts',
      'src/contexts/session-context-transport-orchestration-runtime.test.ts',
      'src/lib/client-daemon-connection.test.ts',
    ]));

    const resourceRegistry = JSON.parse(readRepo('android/docs/resource-registry.json')) as {
      resources: Array<{ resource_id: string; truth_store: string; allowed_operations: string[] }>;
    };
    const signal = resourceRegistry.resources.find((resource) => resource.resource_id === 'resource.platform_network_signal');
    expect(signal?.truth_store).toContain('client-daemon-connection.ts current typed error slot');
    expect(signal?.truth_store).toContain('registered typed error consumer');
    expect(signal?.allowed_operations).toContain('consume_native_snapshot_error');
    expect(signal?.allowed_operations).toContain('acknowledge_native_snapshot_error');
  });

  it('binds aggregate lifecycle identity and the physical tgz digest separately', () => {
    const manifest = JSON.parse(readRepo('android/generated/modules/zterm-runtime-v2/module.compiled.json')) as {
      artifact_hash: string;
      artifacts: Array<{ path: string; hash: string }>;
    };
    const artifactPath = `android/generated/modules/zterm-runtime-v2/lib/${manifest.artifacts[0]?.path || ''}`;
    const artifactBytes = readRepoBytes(artifactPath);
    const artifactDigest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;

    expect(manifest.artifacts[0]?.hash).toBe(artifactDigest);
    expect(manifest.artifact_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects silent fallback and catch-to-empty native snapshot errors', () => {
    const wrapper = readFileSync(
      resolve(__dirname, '../plugins/NetworkIdentityPlugin.ts'),
      'utf8',
    );

    expect(wrapper).toContain("snapshot requires a native Android runtime");
    expect(wrapper).not.toContain("web: () => ({");
    expect(wrapper).not.toContain("console.warn");
    expect(wrapper).toContain("NetworkIdentitySnapshotError");
    expect(wrapper).not.toContain("return []");
  });

  it('rejects malformed native interface snapshots explicitly', () => {
    expect(() =>
      requireNativeNetworkInterfaces({
        interfaces: undefined as never,
      }),
    ).toThrow('invalid interfaces');
  });

  it('accepts a complete native interface entry and preserves producer extras', () => {
    const entry = {
      name: 'wlan0',
      addressesSignature: 'v4:192.0.2.1',
      vpn: false,
      validated: true,
      transport: 'wifi',
    };

    expect(requireNativeNetworkInterfaces({ interfaces: [entry] })).toEqual([entry]);
  });

  it('accepts the native producer empty interface-name sentinel', () => {
    const entry = {
      name: '',
      addressesSignature: '',
      vpn: false,
    };

    expect(requireNativeNetworkInterfaces({ interfaces: [entry] })).toEqual([entry]);
  });

  it.each([
    [null],
    [{ name: 1, addressesSignature: 'sig', vpn: false }],
    [{ name: 'wlan0', addressesSignature: 1, vpn: false }],
    [{ name: 'wlan0', addressesSignature: 'sig', vpn: 'false' }],
  ])('rejects malformed native interface entry %j', (entry) => {
    expect(() => requireNativeNetworkInterfaces({ interfaces: [entry] as never })).toThrow(
      'invalid interface entry',
    );
  });
});

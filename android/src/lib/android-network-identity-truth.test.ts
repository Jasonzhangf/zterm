import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const androidRoot = resolve(__dirname, '../../native/android/app/src/main');

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
});

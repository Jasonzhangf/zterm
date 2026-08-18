import { describe, expect, it } from 'vitest';
import { createNetworkIdentityRuntime } from './network-identity';
import type { NetworkInterfaceFingerprint } from './network-identity';

function interfaces(...entries: Array<[name: string, signature: string, vpn?: boolean]>): NetworkInterfaceFingerprint[] {
  return entries.map(([name, addressesSignature, vpn = false]) => ({ name, addressesSignature, vpn }));
}

describe('createNetworkIdentityRuntime', () => {
  it('rejects resample when the native snapshot capability is not active', async () => {
    const runtime = createNetworkIdentityRuntime();

    await expect(runtime.resample()).rejects.toMatchObject({
      kind: 'TargetNetworkProbeError04NativeSnapshot',
      message: 'NetworkIdentity native snapshot capability is not active',
    });
    await expect(runtime.resampleWithStatus({
      connected: true,
      connectionType: 'wifi',
    })).rejects.toMatchObject({
      kind: 'TargetNetworkProbeError04NativeSnapshot',
      message: 'NetworkIdentity native snapshot capability is not active',
    });
  });

  it('does not reject resample when an active sampler is present', async () => {
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => interfaces(['wlan0', 'aaa']),
    });

    const sample = await runtime.resampleWithStatus({
      connected: true,
      connectionType: 'wifi',
    });
    expect(sample.fingerprint.interfaces).toHaveLength(1);
  });

  it('starts at generation 0 with no fingerprint', () => {
    const runtime = createNetworkIdentityRuntime();
    expect(runtime.readGeneration()).toBe(0);
    expect(runtime.readFingerprint()).toBeNull();
  });

  it('advances generation exactly once per connection-type change', () => {
    const runtime = createNetworkIdentityRuntime();
    const first = runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    expect(first.fingerprintChanged).toBe(true);
    expect(first.generation).toBe(1);

    const same = runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    expect(same.fingerprintChanged).toBe(false);
    expect(same.generation).toBe(1);

    const switched = runtime.ingestNetworkStatus({ connected: true, connectionType: 'cellular' });
    expect(switched.fingerprintChanged).toBe(true);
    expect(switched.generation).toBe(2);

    const none = runtime.ingestNetworkStatus({ connected: false, connectionType: 'none' });
    expect(none.fingerprintChanged).toBe(true);
    expect(none.generation).toBe(3);
  });

  it('completes a provisional interface-only baseline without retiring a transport', async () => {
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => interfaces(['wlan0', 'aaa']),
    });

    const initial = await runtime.resample();
    expect(initial.fingerprintChanged).toBe(true);
    expect(initial.generation).toBe(1);

    const firstKnownStatus = runtime.ingestNetworkStatus({
      connected: true,
      connectionType: 'wifi',
    });
    expect(firstKnownStatus.fingerprintChanged).toBe(false);
    expect(firstKnownStatus.generation).toBe(1);

    const foregroundResume = await runtime.resampleWithStatus({
      connected: true,
      connectionType: 'wifi',
    });
    expect(foregroundResume.fingerprintChanged).toBe(false);
    expect(foregroundResume.generation).toBe(1);
  });

  it('does not let an unknown online signal erase a confirmed connection type', () => {
    const runtime = createNetworkIdentityRuntime();

    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    const online = runtime.ingestNetworkStatus({
      connected: true,
      connectionType: 'unknown',
    });

    expect(online.fingerprintChanged).toBe(false);
    expect(online.generation).toBe(1);
    expect(online.fingerprint.connectionType).toBe('wifi');
  });

  it('does not advance when interface sampling enriches a confirmed status baseline', async () => {
    let currentInterfaces: NetworkInterfaceFingerprint[] = [];
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => currentInterfaces,
    });

    const status = runtime.ingestNetworkStatus({
      connected: true,
      connectionType: 'wifi',
    });
    expect(status.generation).toBe(1);

    currentInterfaces = interfaces(['wlan0', 'aaa']);
    const enriched = await runtime.resample();

    expect(enriched.fingerprintChanged).toBe(false);
    expect(enriched.generation).toBe(1);
    expect(enriched.fingerprint.interfaces).toEqual(currentInterfaces);
  });

  it('does not advance from an unknown empty baseline when status arrives first', () => {
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => [],
    });

    const initial = runtime.resample();
    expect(initial).toBeInstanceOf(Promise);

    return initial.then(() => {
      const status = runtime.ingestNetworkStatus({
        connected: true,
        connectionType: 'wifi',
      });

      expect(status.fingerprintChanged).toBe(false);
      expect(status.generation).toBe(1);
    });
  });

  it('reuses the latest interface snapshot on sync status ingestion', () => {
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => interfaces(['wlan0', 'aa:bb', false], ['tun0', 'cc:dd', true]),
    });
    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    const sample = runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    expect(sample.fingerprint.interfaces).toHaveLength(0);

    // resample fills interfaces; a further sync event keeps them.
    return runtime.resample().then((afterResample) => {
      expect(afterResample.fingerprintChanged).toBe(false);
      expect(afterResample.fingerprint.interfaces).toHaveLength(2);
      const afterSync = runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
      expect(afterSync.fingerprintChanged).toBe(false);
      expect(afterSync.fingerprint.interfaces).toHaveLength(2);
    });
  });

  it('advances generation when the interface set changes during resample', async () => {
    let currentInterfaces: NetworkInterfaceFingerprint[] = interfaces(['wlan0', 'aaa']);
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => currentInterfaces,
    });
    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    const first = await runtime.resample();
    expect(first.generation).toBe(1);

    currentInterfaces = interfaces(['rmnet_data0', 'bbb']);
    const second = await runtime.resample();
    expect(second.fingerprintChanged).toBe(true);
    expect(second.generation).toBe(2);
    expect(runtime.readGeneration()).toBe(2);
  });

  it('resampleWithStatus compares status AND interfaces in one step', async () => {
    let currentInterfaces: NetworkInterfaceFingerprint[] = interfaces(['wlan0', 'aaa']);
    const runtime = createNetworkIdentityRuntime({ sampleInterfaces: () => currentInterfaces });
    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });

    // Status flip alone is detected even when interfaces are unchanged.
    const flipped = await runtime.resampleWithStatus({ connected: true, connectionType: 'cellular' });
    expect(flipped.fingerprintChanged).toBe(true);
    expect(flipped.generation).toBe(2);

    // Interface change on top of an unchanged status is detected too.
    currentInterfaces = interfaces(['rmnet_data0', 'bbb']);
    const interfaceFlip = await runtime.resampleWithStatus({ connected: true, connectionType: 'cellular' });
    expect(interfaceFlip.fingerprintChanged).toBe(true);
    expect(interfaceFlip.generation).toBe(3);

    // Same status + same interfaces is stable.
    const stable = await runtime.resampleWithStatus({ connected: true, connectionType: 'cellular' });
    expect(stable.fingerprintChanged).toBe(false);
    expect(stable.generation).toBe(3);
  });

  it('treats interface order changes as the same fingerprint', async () => {
    const runtime = createNetworkIdentityRuntime({
      sampleInterfaces: () => interfaces(['wlan0', 'aaa'], ['tun0', 'bbb', true]),
    });
    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    await runtime.resample();
    const second = await runtime.resample();
    expect(second.fingerprintChanged).toBe(false);
  });

  it('detects VPN toggle via the interface snapshot', async () => {
    let currentInterfaces: NetworkInterfaceFingerprint[] = interfaces(['wlan0', 'aaa']);
    const runtime = createNetworkIdentityRuntime({ sampleInterfaces: () => currentInterfaces });
    runtime.ingestNetworkStatus({ connected: true, connectionType: 'wifi' });
    await runtime.resample();

    currentInterfaces = interfaces(['wlan0', 'aaa'], ['utun4', 'ccc', true]);
    const sample = await runtime.resample();
    expect(sample.fingerprintChanged).toBe(true);
    expect(sample.generation).toBe(2);
  });
});

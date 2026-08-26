import { describe, expect, it } from 'vitest';
import {
  createAndroidConnectionServiceRuntime,
  type AndroidConnectionLifecycleSignal,
} from './android-connection-service-runtime';
import type { AndroidConnectionServiceSnapshot } from '../lib/android-connection-service-snapshot';

const snapshot: AndroidConnectionServiceSnapshot = {
  state: 'mux-ready',
  generation: 'g1',
  target: {
    targetKey: 'daemon:mac-studio',
    bridgeHost: '100.66.1.82',
    bridgePort: 3333,
  },
  route: { mode: 'auto' },
  channels: [],
  lastHeartbeatAt: null,
  lastActivityAt: 1000,
  nextRetryAt: null,
  error: null,
  muxReadyPayload: { version: 1, daemonHostId: 'daemon-host' },
};

describe('Android connection service UI projection runtime', () => {
  it('keeps subscription valid while the Activity/WebView projection is detached', () => {
    const runtime = createAndroidConnectionServiceRuntime({
      readSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    });

    runtime.detach();
    const later = runtime.applySnapshot({
      ...snapshot,
      state: 'healthy',
      generation: 'g2',
      lastHeartbeatAt: 1200,
    });
    expect(later.state).toBe('healthy');
    expect(runtime.attach().state).toBe('healthy');
  });

  it('exposes no reconnect, probe, or heartbeat side effects', () => {
    const runtime = createAndroidConnectionServiceRuntime({
      readSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    });

    expect(runtime).not.toHaveProperty('requestReconnect');
    expect(runtime).not.toHaveProperty('probeTarget');
    expect(runtime).not.toHaveProperty('startHeartbeat');
    expect(runtime.projectLifecycleSignal({ source: 'foreground-resume' })).toEqual({
      kind: 'foreground-resume',
      platform: 'android',
      snapshotGeneration: 'g1',
    });
  });

  it('projects lifecycle without fabricating connection truth or calling service IPC', () => {
    const runtime = createAndroidConnectionServiceRuntime({
      readSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    });

    expect(() => runtime.projectLifecycleSignal({
      source: 'foreground-resume',
      connected: true,
    } as unknown as AndroidConnectionLifecycleSignal)).toThrow(
      /connection truth/,
    );
    expect(() => runtime.projectLifecycleSignal({
      source: 'foreground-resume',
      connectionType: 'wifi',
    } as unknown as AndroidConnectionLifecycleSignal)).toThrow(
      /connection truth/,
    );
    expect(() => runtime.projectLifecycleSignal({
      source: 'background-entered',
    } as unknown as AndroidConnectionLifecycleSignal)).toThrow(
      /unsupported Android lifecycle signal/,
    );
    expect(runtime.readSnapshot()).toBe(snapshot);
  });

  it('uses only the current native snapshot generation after a newer generation replaces the old one', () => {
    const runtime = createAndroidConnectionServiceRuntime({
      readSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    });

    runtime.applySnapshot({
      ...snapshot,
      state: 'healthy',
      generation: 'g2',
    });

    expect(runtime.projectLifecycleSignal({ source: 'foreground-resume' })).toEqual({
      kind: 'foreground-resume',
      platform: 'android',
      snapshotGeneration: 'g2',
    });
  });
});

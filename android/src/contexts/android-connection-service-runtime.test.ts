import { describe, expect, it } from 'vitest';
import { createAndroidConnectionServiceRuntime } from './android-connection-service-runtime';
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
    expect(runtime.projectLifecycleSignal('foreground-resume')).toBeNull();
  });
});

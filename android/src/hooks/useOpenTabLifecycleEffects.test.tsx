// @vitest-environment jsdom

import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForegroundRefreshRuntime } from '../lib/app-foreground-refresh';
import { createNetworkIdentityRuntime } from '../lib/network-identity';
import {
  BACKGROUND_HANDOFF_WAKE_LOCK_MS,
  useOpenTabLifecycleEffects,
} from './useOpenTabLifecycleEffects';
import type { Session } from '../lib/types';

const capacitorAppHarness = vi.hoisted(() => {
  const listenersByEventName: Record<string, Array<(payload: any) => void>> = {};
  return {
    addListener: vi.fn((eventName: string, listener: (payload: any) => void) => {
      listenersByEventName[eventName] = listenersByEventName[eventName] || [];
      listenersByEventName[eventName]!.push(listener);
      return {
        remove: vi.fn(async () => {
          listenersByEventName[eventName] = (listenersByEventName[eventName] || [])
            .filter((candidate) => candidate !== listener);
        }),
      };
    }),
    emit(eventName: string, payload: any) {
      (listenersByEventName[eventName] || []).forEach((listener) => listener(payload));
    },
    count(eventName: string) {
      return this.addListener.mock.calls.filter((call) => call[0] === eventName).length;
    },
    reset() {
      Object.keys(listenersByEventName).forEach((eventName) => {
        listenersByEventName[eventName] = [];
      });
      this.addListener.mockClear();
    },
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: capacitorAppHarness.addListener,
  },
}));

// Capacitor Network harness
const capacitorNetworkHarness = vi.hoisted(() => {
  const listenersByEventName: Record<string, Array<(payload: any) => void>> = {};
  return {
    addListener: vi.fn((eventName: string, listener: (payload: any) => void) => {
      listenersByEventName[eventName] = listenersByEventName[eventName] || [];
      listenersByEventName[eventName]!.push(listener);
      return {
        remove: vi.fn(async () => {
          listenersByEventName[eventName] = (listenersByEventName[eventName] || [])
            .filter((candidate) => candidate !== listener);
        }),
      };
    }),
    getStatus: vi.fn(async () => ({ connected: true, connectionType: 'wifi' })),
    emit(eventName: string, payload: any) {
      (listenersByEventName[eventName] || []).forEach((listener) => listener(payload));
    },
    count(eventName: string) {
      return this.addListener.mock.calls.filter((call) => call[0] === eventName).length;
    },
    reset() {
      Object.keys(listenersByEventName).forEach((eventName) => {
        listenersByEventName[eventName] = [];
      });
      this.addListener.mockClear();
      this.getStatus.mockClear();
    },
  };
});
vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: capacitorNetworkHarness.addListener,
    getStatus: capacitorNetworkHarness.getStatus,
  },
}));

const backgroundServiceHarness = vi.hoisted(() => ({
  startBackgroundService: vi.fn(),
  stopBackgroundService: vi.fn(),
  updateSessionCount: vi.fn(),
  setBackgroundHeartbeatCallback: vi.fn(),
  getBackgroundHeartbeatState: vi.fn(() => ({ isAlive: true, lastHeartbeatAt: Date.now() })),
  isBackgroundHeartbeatAlive: vi.fn(() => true),
  recordBackgroundHeartbeat: vi.fn(),
}));

vi.mock('../plugins/BackgroundServicePlugin', () => ({
  startBackgroundService: backgroundServiceHarness.startBackgroundService,
  stopBackgroundService: backgroundServiceHarness.stopBackgroundService,
  updateSessionCount: backgroundServiceHarness.updateSessionCount,
  setBackgroundHeartbeatCallback: backgroundServiceHarness.setBackgroundHeartbeatCallback,
  getBackgroundHeartbeatState: backgroundServiceHarness.getBackgroundHeartbeatState,
  isBackgroundHeartbeatAlive: backgroundServiceHarness.isBackgroundHeartbeatAlive,
  recordBackgroundHeartbeat: backgroundServiceHarness.recordBackgroundHeartbeat,
}));

const baseSession = {
  id: 's1',
  title: 'session',
  state: 'connected',
} as Session;

function LifecycleHarness({
  onForegroundResume,
  auditOpenTabsAgainstRemoteSessions,
  onForegroundActiveChange = vi.fn(),
  sessions = [baseSession],
}: {
  onForegroundResume: (reason: 'visibilitychange' | 'resume' | 'appStateChange') => void;
  auditOpenTabsAgainstRemoteSessions: (reason: any) => Promise<void>;
  onForegroundActiveChange?: (active: boolean) => void;
  sessions?: Session[];
}) {
  const sessionsRef = useRef<Session[]>(sessions);
  const openTabStateRef = useRef({
    tabs: [{ sessionId: 's1' }],
    activeSessionId: 's1',
  });
  const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

  useOpenTabLifecycleEffects({
    sessionsRef,
    openTabStateRef,
    foregroundRefreshRuntimeRef,
    retainedSessionCount: sessions.filter((session) => session.state !== 'closed').length,
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal: vi.fn(),
    bumpFollowResetEpoch: vi.fn(),
  });

  return <div>mounted</div>;
}

afterEach(() => {
  cleanup();
  capacitorAppHarness.reset();
  capacitorNetworkHarness.reset();
  backgroundServiceHarness.startBackgroundService.mockClear();
  backgroundServiceHarness.stopBackgroundService.mockClear();
  backgroundServiceHarness.updateSessionCount.mockClear();
  backgroundServiceHarness.setBackgroundHeartbeatCallback.mockClear();
  vi.useRealTimers();
});

describe('useOpenTabLifecycleEffects', () => {
  it('starts retained-session service while foreground without enabling background heartbeat', () => {
    render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
    />);

    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledTimes(1);
    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledWith(1);
    expect(backgroundServiceHarness.setBackgroundHeartbeatCallback).not.toHaveBeenCalled();
    expect(backgroundServiceHarness.stopBackgroundService).not.toHaveBeenCalled();
  });

  it('projects inactive immediately and starts persistent native protection while a session remains open', async () => {
    expect(BACKGROUND_HANDOFF_WAKE_LOCK_MS).toBe(5 * 60 * 1000);
    const onForegroundActiveChange = vi.fn();
    render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      onForegroundActiveChange={onForegroundActiveChange}
    />);

    capacitorAppHarness.emit('appStateChange', { isActive: false });
    expect(onForegroundActiveChange).toHaveBeenCalledTimes(1);
    expect(onForegroundActiveChange).toHaveBeenCalledWith(false);
    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledTimes(1);
    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledWith(1);

    capacitorAppHarness.emit('appStateChange', { isActive: true });
    expect(onForegroundActiveChange).toHaveBeenCalledWith(true);
    expect(backgroundServiceHarness.stopBackgroundService).not.toHaveBeenCalled();
  });

  it('keeps the service alive across foreground/background transitions', () => {
    render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
    />);

    capacitorAppHarness.emit('appStateChange', { isActive: false });
    capacitorAppHarness.emit('appStateChange', { isActive: true });
    capacitorAppHarness.emit('appStateChange', { isActive: false });

    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledTimes(1);
    expect(backgroundServiceHarness.stopBackgroundService).not.toHaveBeenCalled();
  });

  it('keeps the service lifecycle separate from the background heartbeat callback', () => {
    render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
    />);

    capacitorAppHarness.emit('appStateChange', { isActive: false });
    expect(backgroundServiceHarness.setBackgroundHeartbeatCallback).toHaveBeenLastCalledWith(expect.any(Function));
    expect(backgroundServiceHarness.stopBackgroundService).not.toHaveBeenCalled();

    capacitorAppHarness.emit('appStateChange', { isActive: true });
    expect(backgroundServiceHarness.setBackgroundHeartbeatCallback).toHaveBeenLastCalledWith(null);
    expect(backgroundServiceHarness.stopBackgroundService).not.toHaveBeenCalled();
  });

  it('does not start native background execution when no retained session exists', async () => {
    const onForegroundActiveChange = vi.fn();
    render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      onForegroundActiveChange={onForegroundActiveChange}
      sessions={[]}
    />);

    capacitorAppHarness.emit('appStateChange', { isActive: false });
    capacitorAppHarness.emit('appStateChange', { isActive: false });

    expect(onForegroundActiveChange).toHaveBeenCalledTimes(1);
    expect(onForegroundActiveChange).toHaveBeenCalledWith(false);
    expect(backgroundServiceHarness.startBackgroundService).not.toHaveBeenCalled();
  });

  it('stops native background execution when the last retained session closes while hidden', async () => {
    const onForegroundActiveChange = vi.fn();
    const view = render(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      onForegroundActiveChange={onForegroundActiveChange}
    />);

    capacitorAppHarness.emit('appStateChange', { isActive: false });
    expect(backgroundServiceHarness.startBackgroundService).toHaveBeenCalledWith(1);

    view.rerender(<LifecycleHarness
      onForegroundResume={vi.fn()}
      auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      onForegroundActiveChange={onForegroundActiveChange}
      sessions={[{ ...baseSession, state: 'closed' } as Session]}
    />);

    expect(backgroundServiceHarness.stopBackgroundService).toHaveBeenCalledTimes(1);
    expect(backgroundServiceHarness.updateSessionCount).toHaveBeenCalledWith(1);
  });

  it('keeps one Capacitor appStateChange listener across callback-only rerenders', async () => {
    const firstResume = vi.fn();
    const secondResume = vi.fn();
    const firstAudit = vi.fn(async () => undefined);
    const secondAudit = vi.fn(async () => undefined);

    const view = render(
      <LifecycleHarness
        onForegroundResume={firstResume}
        auditOpenTabsAgainstRemoteSessions={firstAudit}
      />,
    );
    expect(capacitorAppHarness.count('appStateChange')).toBe(1);

    view.rerender(
      <LifecycleHarness
        onForegroundResume={secondResume}
        auditOpenTabsAgainstRemoteSessions={secondAudit}
      />,
    );

    expect(capacitorAppHarness.count('appStateChange')).toBe(1);

    capacitorAppHarness.emit('appStateChange', { isActive: true });

    expect(firstResume).not.toHaveBeenCalled();
    expect(secondResume).toHaveBeenCalledWith('appStateChange');
    expect(firstAudit).not.toHaveBeenCalled();
    expect(secondAudit).toHaveBeenCalledWith('appStateChange');
  });

  it('keeps one Capacitor Network networkStatusChange listener across callback-only rerenders', async () => {
    const view = render(
      <LifecycleHarness
        onForegroundResume={vi.fn()}
        auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      />,
    );
    expect(capacitorNetworkHarness.count('networkStatusChange')).toBe(1);

    view.rerender(
      <LifecycleHarness
        onForegroundResume={vi.fn()}
        auditOpenTabsAgainstRemoteSessions={vi.fn(async () => undefined)}
      />,
    );

    expect(capacitorNetworkHarness.count('networkStatusChange')).toBe(1);
  });

  it('routes network change only to the target probe without changing foreground truth', async () => {
    const auditOpenTabs = vi.fn(async () => undefined);
    const onForegroundActiveChange = vi.fn();
    const notifyTargetNetworkSignal = vi.fn();

    const HarnessWithMocks = () => {
      const sessionsRef = useRef<Session[]>([baseSession]);
      const openTabStateRef = useRef({
        tabs: [{ sessionId: 's1' }],
        activeSessionId: 's1',
      });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 1,
        onForegroundActiveChange,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: auditOpenTabs,
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
      });

      return <div>mounted</div>;
    };

    render(<HarnessWithMocks />);

    capacitorNetworkHarness.emit('networkStatusChange', {
      connected: true,
      connectionType: 'wifi',
    });

    expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
      connected: true,
      connectionType: 'wifi',
      source: 'capacitor',
    });
    expect(auditOpenTabs).not.toHaveBeenCalled();
    expect(onForegroundActiveChange).not.toHaveBeenCalled();
  });

  it('keeps foreground truth unchanged when platform network reports disconnected', async () => {
    const onForegroundActiveChange = vi.fn();
    const notifyTargetNetworkSignal = vi.fn();

    const HarnessWithMocks = () => {
      const sessionsRef = useRef<Session[]>([baseSession]);
      const openTabStateRef = useRef({
        tabs: [{ sessionId: 's1' }],
        activeSessionId: 's1',
      });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 1,
        onForegroundActiveChange,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: vi.fn(async () => undefined),
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
      });

      return <div>mounted</div>;
    };

    render(<HarnessWithMocks />);

    capacitorNetworkHarness.emit('networkStatusChange', {
      connected: false,
      connectionType: 'none',
    });

    expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
      connected: false,
      connectionType: 'none',
      source: 'capacitor',
    });
    expect(onForegroundActiveChange).not.toHaveBeenCalled();
  });

  it('still routes a network generation to the target owner when no tab is active', async () => {
    const auditOpenTabs = vi.fn(async () => undefined);
    const notifyTargetNetworkSignal = vi.fn();

    const HarnessNoActiveSession = () => {
      const sessionsRef = useRef<Session[]>([]);
      const openTabStateRef = useRef({ tabs: [], activeSessionId: null });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 0,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: auditOpenTabs,
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
      });
      return <div>mounted</div>;
    };
    render(<HarnessNoActiveSession />);
    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'cellular' });
    expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
      connected: true,
      connectionType: 'cellular',
      source: 'capacitor',
    });
    expect(auditOpenTabs).not.toHaveBeenCalled();
  });

  it('probes retained daemon targets on foreground resume even without an active tab', () => {
    const auditOpenTabs = vi.fn(async () => undefined);
    const notifyTargetNetworkSignal = vi.fn();

    const HarnessNoActiveSession = () => {
      const sessionsRef = useRef<Session[]>([]);
      const openTabStateRef = useRef({ tabs: [], activeSessionId: null });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 0,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: auditOpenTabs,
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
      });
      return <div>mounted</div>;
    };

    render(<HarnessNoActiveSession />);
    capacitorAppHarness.emit('appStateChange', { isActive: true });

    expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
      source: 'foreground-resume',
    });
    expect(auditOpenTabs).not.toHaveBeenCalled();
  });

  it('stamps capacitor network changes with generation and retires stale transports across generations', async () => {
    const notifyTargetNetworkSignal = vi.fn();
    const networkIdentity = createNetworkIdentityRuntime();

    const HarnessWithNetworkIdentity = () => {
      const sessionsRef = useRef<Session[]>([baseSession]);
      const openTabStateRef = useRef({ tabs: [{ sessionId: 's1' }], activeSessionId: 's1' });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 1,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: vi.fn(async () => undefined),
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
        networkIdentity,
      });
      return <div>mounted</div>;
    };

    render(<HarnessWithNetworkIdentity />);

    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'wifi' });
    expect(notifyTargetNetworkSignal).toHaveBeenLastCalledWith({
      connected: true,
      connectionType: 'wifi',
      source: 'capacitor',
      networkGeneration: 1,
      fingerprintChanged: true,
    });

    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'cellular' });
    expect(notifyTargetNetworkSignal).toHaveBeenLastCalledWith({
      connected: true,
      connectionType: 'cellular',
      source: 'capacitor',
      networkGeneration: 2,
      fingerprintChanged: true,
    });

    // Same-generation event does not re-advance the generation.
    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'cellular' });
    expect(notifyTargetNetworkSignal).toHaveBeenLastCalledWith({
      connected: true,
      connectionType: 'cellular',
      source: 'capacitor',
      networkGeneration: 2,
      fingerprintChanged: false,
    });
  });

  it('recovers a backgrounded network change on foreground resume with a cross-generation signal', async () => {
    const notifyTargetNetworkSignal = vi.fn();
    const networkIdentity = createNetworkIdentityRuntime();
    capacitorNetworkHarness.getStatus.mockResolvedValue({ connected: true, connectionType: 'cellular' });

    const HarnessWithNetworkIdentity = () => {
      const sessionsRef = useRef<Session[]>([baseSession]);
      const openTabStateRef = useRef({ tabs: [{ sessionId: 's1' }], activeSessionId: 's1' });
      const foregroundRefreshRuntimeRef = useRef(createForegroundRefreshRuntime());

      useOpenTabLifecycleEffects({
        sessionsRef,
        openTabStateRef,
        foregroundRefreshRuntimeRef,
        retainedSessionCount: 1,
        onForegroundResume: vi.fn(),
        auditOpenTabsAgainstRemoteSessions: vi.fn(async () => undefined),
        notifyTargetNetworkSignal,
        bumpFollowResetEpoch: vi.fn(),
        networkIdentity,
      });
      return <div>mounted</div>;
    };

    render(<HarnessWithNetworkIdentity />);
    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'wifi' });

    // Background: hide the document so the cellular event is dropped while hidden.
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    capacitorAppHarness.emit('appStateChange', { isActive: false });
    capacitorNetworkHarness.emit('networkStatusChange', { connected: true, connectionType: 'cellular' });

    // Foreground: immediate same-generation signal first, then resample discovers
    // the backgrounded cellular switch and emits the cross-generation signal.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    capacitorAppHarness.emit('appStateChange', { isActive: true });
    await vi.waitFor(() => {
      expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
        source: 'foreground-resume',
        networkGeneration: 2,
        fingerprintChanged: true,
      });
    });
    Object.defineProperty(document, 'visibilityState', { value: originalVisibility, configurable: true });

    expect(notifyTargetNetworkSignal).toHaveBeenCalledWith({
      source: 'foreground-resume',
      networkGeneration: 1,
      fingerprintChanged: false,
    });
  });
});

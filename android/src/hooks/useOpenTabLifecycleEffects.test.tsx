// @vitest-environment jsdom

import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForegroundRefreshRuntime } from '../lib/app-foreground-refresh';
import { useOpenTabLifecycleEffects } from './useOpenTabLifecycleEffects';
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
vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: capacitorNetworkHarness.addListener,
  },
}));

const baseSession = {
  id: 's1',
  title: 'session',
  state: 'connected',
} as Session;

function LifecycleHarness({
  onForegroundResume,
  auditOpenTabsAgainstRemoteSessions,
}: {
  onForegroundResume: (reason: 'visibilitychange' | 'resume' | 'appStateChange') => void;
  auditOpenTabsAgainstRemoteSessions: (reason: any) => Promise<void>;
}) {
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
    onForegroundActiveChange: vi.fn(),
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
});

describe('useOpenTabLifecycleEffects', () => {
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
        sessionsRef, openTabStateRef, foregroundRefreshRuntimeRef,
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

});

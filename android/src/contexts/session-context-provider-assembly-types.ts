import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { SessionScheduleState } from '../lib/types';
import type {
  SessionAction,
  SessionContextValue,
  SessionManagerState,
} from './session-context-core';

export interface SessionProviderAssembliesSharedOptions {
  appForegroundActive?: boolean;
  state: SessionManagerState;
  stateRef: MutableRefObject<SessionManagerState>;
  dispatch: Dispatch<SessionAction>;
  scheduleStates: Record<string, SessionScheduleState>;
  scheduleStatesRef: MutableRefObject<Record<string, SessionScheduleState>>;
  sessionStore: any;
  setScheduleStates: Dispatch<SetStateAction<Record<string, SessionScheduleState>>>;
  bridgeSettings: BridgeSettings;
  terminalCacheLines: number;
  wsUrl?: string;
  refs: any;
}

export interface SessionProviderCoreAssembliesResult {
  getSessionRenderBufferSnapshot: SessionContextValue['getSessionRenderBufferSnapshot'];
  getSessionBufferStore: SessionContextValue['getSessionBufferStore'];
  getSessionHeadStore: SessionContextValue['getSessionHeadStore'];
  flushRuntimeDebugLogs: () => void;
  clearReconnectForSession: (sessionId: string) => void;
  writeSessionTransportHost: (sessionId: string, host: any) => unknown;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
  readSessionBufferSnapshot: (sessionId: string) => any;
  setActiveSessionSync: (id: string) => void;
  createSessionSync: (session: any, activate: boolean) => void;
  deleteSessionSync: (id: string) => void;
  moveSessionSync: (id: string, toIndex: number) => void;
  updateSessionSync: (id: string, updates: any) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  resolveSessionCacheLines: (rows?: number | null) => number;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => void;
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: any, data: string | ArrayBuffer) => void;
  setScheduleStateForSession: (sessionId: string, nextState: any) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  queueConnectTransportOpenIntent: (sessionId: string, host: any, activate: boolean) => void;
  readSessionTransportSocket: (sessionId: string) => any;
  readSessionTransportHost: (sessionId: string) => any;
  readSessionTransportRuntime: (sessionId: string) => any;
  readSessionTargetRuntime: (sessionId: string) => any;
  readSessionTargetKey: (sessionId: string) => any;
  clearSessionTransportRuntime: (sessionId: string) => any;
  readSessionBufferHead?: (sessionId: string) => any;
  requestSessionBufferSync: (sessionId: string, options?: any) => boolean;
  requestSessionBufferHead: (sessionId: string, ws?: any, options?: { force?: boolean }) => boolean;
}

import type { BridgeSettings } from '../lib/bridge-settings';
import type { NetworkIdentityRuntime } from '../lib/network-identity';
import type { MutableRefObject } from 'react';
import type {
  ClientMessage,
  Host,
  PasteImageStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamPurpose,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
  RemoteWindowVideoBitrateConfig,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  SessionState,
  TerminalWidthMode,
  TerminalViewportState,
  TerminalVisibleRange,
} from '../lib/types';
import type { SessionTargetNetworkSignal } from './session-context-target-network-probe-runtime';
import type { TerminalMuxTargetClientMessage, TerminalSessionCatalog } from '@zterm/shared/protocol';
import type { SessionRenderBufferSnapshot } from '../lib/types';
import type { SessionBufferStore } from '../lib/session-buffer-store';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { SessionHeadStore } from '../lib/session-head-store';
import type { SessionAttachmentStore } from '../lib/session-attachment-store';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';
import type { RemoteWindowControlMessage } from '../lib/remote-window-message-runtime';
import type {
  QueueSessionTransportOpenIntentOptions as SessionTransportOpenIntentHelperOptions,
} from './session-transport-open-helpers';
import {
  createSessionReconnectRuntime as createSessionReconnectRuntimeFromStore,
  type SessionReconnectRuntime,
} from '../lib/session-reconnect-store';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;

export interface SessionManagerState {
  sessions: Session[];
  activeSessionId: string | null;
  liveSessionIds: string[];
  liveSessionIdsExplicit: boolean;
  connectedCount: number;
}

export interface SessionCloseOptions {
  /**
   * Keep the daemon-target transport alive while stopping a logical session
   * for a later remote kill. The session is marked disconnected and its body
   * subscription is turned off, but the mux channel/control transport are not
   * closed yet so the caller can still send target control messages.
   */
  preserveTargetTransport?: boolean;
}

export type SessionAction =
  | { type: 'CREATE_SESSION'; session: Session }
  | { type: 'UPDATE_SESSION'; id: string; updates: Partial<Session> }
  | { type: 'MOVE_SESSION'; id: string; toIndex: number }
  | { type: 'DELETE_SESSION'; id: string; manualClose: true }
  | { type: 'SET_ACTIVE_SESSION'; id: string }
  | { type: 'SET_LIVE_SESSIONS'; ids: string[] }
  | { type: 'SET_SESSION_STATE'; id: string; state: SessionState }
  | { type: 'SET_SESSION_TITLE'; id: string; title: string }
  | { type: 'SET_SESSION_REMOTE_MISSING'; id: string; remoteMissing: boolean }
  | { type: 'INCREMENT_CONNECTED' }
  | { type: 'DECREMENT_CONNECTED' };

export const initialSessionManagerState: SessionManagerState = {
  sessions: [],
  activeSessionId: null,
  liveSessionIds: [],
  liveSessionIdsExplicit: false,
  connectedCount: 0,
};

function areSessionPatchFieldsEqual(session: Session, updates: Partial<Session>) {
  const entries = Object.entries(updates) as Array<[keyof Session, Session[keyof Session]]>;
  if (entries.length === 0) {
    return true;
  }
  return entries.every(([key, value]) => Object.is(session[key], value));
}

export function reduceSessionAction(state: SessionManagerState, action: SessionAction): SessionManagerState {
  switch (action.type) {
    case 'CREATE_SESSION': {
      const nextSessions = [...state.sessions.filter((session) => session.id !== action.session.id), action.session];
      return {
        ...state,
        sessions: nextSessions,
      };
    }
    case 'UPDATE_SESSION': {
      let changed = false;
      const nextSessions = state.sessions.map((session) => {
        if (session.id !== action.id) {
          return session;
        }
        if (areSessionPatchFieldsEqual(session, action.updates)) {
          return session;
        }
        changed = true;
        return { ...session, ...action.updates };
      });
      return changed ? { ...state, sessions: nextSessions } : state;
    }
    case 'MOVE_SESSION': {
      const currentIndex = state.sessions.findIndex((session) => session.id === action.id);
      if (currentIndex < 0) {
        return state;
      }
      const nextIndex = Math.max(0, Math.min(action.toIndex, state.sessions.length - 1));
      if (currentIndex === nextIndex) {
        return state;
      }
      const nextSessions = [...state.sessions];
      const [session] = nextSessions.splice(currentIndex, 1);
      nextSessions.splice(nextIndex, 0, session);
      return {
        ...state,
        sessions: nextSessions,
      };
    }
    case 'DELETE_SESSION': {
      const nextSessions = state.sessions.filter((session) => session.id !== action.id);
      const nextActiveSessionId = state.activeSessionId === action.id ? (nextSessions[0]?.id || null) : state.activeSessionId;
      const filteredLiveSessionIds = state.liveSessionIds.filter((sessionId) => sessionId !== action.id);
      const nextLiveSessionIds = state.liveSessionIdsExplicit
        ? (
          filteredLiveSessionIds.length === 0 && nextActiveSessionId
            ? [nextActiveSessionId]
            : filteredLiveSessionIds
        )
        : (nextActiveSessionId ? [nextActiveSessionId] : []);
      return {
        ...state,
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
        liveSessionIds: nextLiveSessionIds,
      };
    }
    case 'SET_ACTIVE_SESSION': {
      if (state.activeSessionId === action.id) {
        return state;
      }
      return {
        ...state,
        activeSessionId: action.id,
        liveSessionIds: state.liveSessionIdsExplicit ? state.liveSessionIds : [action.id],
      };
    }
    case 'SET_LIVE_SESSIONS': {
      const normalizedIds = Array.from(new Set(action.ids.filter((id) => typeof id === 'string' && id.trim().length > 0)));
      const liveSessionIds = normalizedIds;
      if (
        liveSessionIds.length === state.liveSessionIds.length
        && liveSessionIds.every((id, index) => state.liveSessionIds[index] === id)
      ) {
        return state;
      }
      return {
        ...state,
        liveSessionIds,
        liveSessionIdsExplicit: true,
      };
    }
    case 'SET_SESSION_STATE': {
      let changed = false;
      const nextSessions = state.sessions.map((session) => {
        if (session.id !== action.id || session.state === action.state) {
          return session;
        }
        changed = true;
        return { ...session, state: action.state };
      });
      return changed ? { ...state, sessions: nextSessions } : state;
    }
    case 'SET_SESSION_TITLE': {
      let changed = false;
      const nextSessions = state.sessions.map((session) => {
        if (session.id !== action.id || session.title === action.title) {
          return session;
        }
        changed = true;
        return { ...session, title: action.title };
      });
      return changed ? { ...state, sessions: nextSessions } : state;
    }
    case 'SET_SESSION_REMOTE_MISSING': {
      let changed = false;
      const nextSessions = state.sessions.map((session) => {
        if (session.id !== action.id || session.remoteMissing === action.remoteMissing) {
          return session;
        }
        changed = true;
        return { ...session, remoteMissing: action.remoteMissing };
      });
      return changed ? { ...state, sessions: nextSessions } : state;
    }
    case 'INCREMENT_CONNECTED':
      return { ...state, connectedCount: state.connectedCount + 1 };
    case 'DECREMENT_CONNECTED':
      return { ...state, connectedCount: Math.max(0, state.connectedCount - 1) };
    default:
      return state;
  }
}

export function sessionReducer(state: SessionManagerState, action: SessionAction): SessionManagerState {
  return reduceSessionAction(state, action);
}

export interface SessionContextValue {
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  getSessionDebugMetrics: (sessionId: string) => SessionDebugOverlayMetrics | null;
  createSession: (host: Host, options?: CreateSessionOptions) => string;
  closeSession: (id: string, options?: SessionCloseOptions) => void;
  switchSession: (id: string, options?: { refreshSource?: 'explicit-resume' | 'active-reentry' }) => void;
  setLiveSessionIds: (ids: string[]) => void;
  setActiveBodySubscriptionSuppressed: (suppressed: boolean) => void;
  moveSession: (id: string, toIndex: number) => void;
  renameSession: (id: string, name: string) => void;
  /** 远端 tmux rename-session 成功后的客户端身份迁移（同时改 sessionName/customName/title）。 */
  renameRemoteSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  /** Record when the app entered background for each session (resume grace decision). */
  recordBackgroundEnteredAt: (sessionIds: string[], at: number) => void;
  resumeActiveSessionTransport: (id: string) => boolean;
  notifyTargetNetworkSignal: (
    signal: SessionTargetNetworkSignal,
  ) => void;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (
    sessionId: string,
    file: File,
    options?: { pasteTarget?: PasteImageStartPayload['pasteTarget'] },
  ) => Promise<void>;
  sendFileAttach: (sessionId: string, file: File) => Promise<void>;
  requestRemoteScreenshot: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
    request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>,
  ) => Promise<RemoteScreenshotCapture>;
  requestRemoteWindowTargets: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  requestRemoteWindowStreamStart: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    options?: { videoBitrate?: RemoteWindowVideoBitrateConfig; purpose?: RemoteWindowStreamPurpose },
  ) => Promise<RemoteWindowReceiverStartResult>;
  updateRemoteWindowStreamQuality: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => void;
  updateRemoteWindowFocus: (
    sessionId: string,
    streamId: string,
    target: RemoteWindowStreamTargetManifest,
    revision?: number,
  ) => void;
  stopRemoteWindowStream: (sessionId: string, streamId: string) => Promise<boolean>;
  sendRemoteWindowInput: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  resizeRemoteWindowTarget: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  sendTerminalResize: (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: TerminalWidthMode) => boolean;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => void;
  requestScheduleList: (sessionId: string) => void;
  manageTmuxSessionsOnOpenTransport: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<string[] | null>;
  queryTerminalSessionCatalogOnOpenTransport: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<TerminalSessionCatalog | null>;
  upsertScheduleJob: (sessionId: string, job: ScheduleJobDraft) => void;
  deleteScheduleJob: (sessionId: string, jobId: string) => void;
  toggleScheduleJob: (sessionId: string, jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (sessionId: string, jobId: string) => void;
  getSessionScheduleState: (sessionId: string) => SessionScheduleState;
  getActiveSession: () => Session | null;
  getSession: (id: string) => Session | null;
  getSessionRenderBufferSnapshot: (sessionId: string) => SessionRenderBufferSnapshot;
  getSessionBufferStore: () => SessionBufferStore;
  getSessionRenderBufferStore: () => SessionRenderBufferStore;
  getSessionHeadStore: () => SessionHeadStore;
  onFileTransferMessage: (handler: (msg: any) => void) => () => void;
  onRemoteWindowMessage: (handler: (msg: RemoteWindowControlMessage) => void) => () => void;
  sendMessageRaw: (sessionId: string, msg: unknown) => void;
  sendTargetHeartbeat: () => number;
  /** Get count of attachments awaiting download. */
  getPendingAttachmentCount: () => number;
  /** Get pending attachments sorted newest first. */
  getPendingAttachments: () => SessionAttachmentStore extends { getAll: () => infer T } ? T : never;
  /** Query daemon for the full attachment history (incl. acknowledged items). */
  queryAttachmentHistory: () => void;
  /** Fetch a single asset (preview/original) for an attachment (history re-download). */
  fetchAttachmentAsset: (attachmentId: string, asset: 'preview' | 'original') => boolean;
}

export interface SessionProviderProps {
  children: React.ReactNode;
  wsUrl?: string;
  terminalCacheLines?: number;
  bridgeSettings?: BridgeSettings;
  appForegroundActive?: boolean;
  foregroundResumeEpoch?: number;
  /**
   * Mutable bridge to the freshest home projection (device list) held by the
   * AppContent layer; reconnect reads the current value to refresh stale direct
   * endpoints after a network change (see mergeHostWithLatestProjection).
   */
  latestSessionHostsRef?: MutableRefObject<Host[] | undefined>;
  /**
   * Client network-generation owner. When present, transport/facade layers
   * stamp route-health isolation with the current generation so a WiFi/cellular/
   * VPN/IP change invalidates prior route truth and reconnects on fresh paths.
   */
  networkIdentity?: NetworkIdentityRuntime;
}

export interface CreateSessionOptions {
  connect?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

export type { SessionReconnectRuntime };

export interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

export type QueueSessionTransportOpenIntentOptions = Omit<
  SessionTransportOpenIntentHelperOptions,
  'resolvedSessionName' | 'clearHandshakeTimeout' | 'finalizeSocketFailureBaseline'
>;

export type QueueSessionTransportOpenIntent = (options: QueueSessionTransportOpenIntentOptions) => void;

export function createSessionReconnectRuntime(): SessionReconnectRuntime {
  return createSessionReconnectRuntimeFromStore();
}

export function computeReconnectDelay(attempt: number) {
  if (attempt <= 0) return 0;
  const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  // ±20% jitter: synchronized exponential backoff across devices/tabs forms
  // a reconnect storm, so scatter each attempt within the band.
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.floor(base * jitter));
}

import type { BridgeSettings } from '../lib/bridge-settings';
import type {
  ClientMessage,
  Host,
  RemoteScreenshotCapture,
  RemoteScreenshotStatusPayload,
  ScheduleJobDraft,
  Session,
  SessionBufferState,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  SessionState,
  TerminalViewportState,
  TerminalVisibleRange,
} from '../lib/types';
import type { SessionRenderBufferSnapshot } from '../lib/types';
import type { SessionBufferStore } from '../lib/session-buffer-store';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { SessionHeadStore } from '../lib/session-head-store';
import type {
  QueueSessionTransportOpenIntentOptions as SessionTransportOpenIntentHelperOptions,
} from './session-sync-helpers';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;

export interface SessionManagerState {
  sessions: Session[];
  activeSessionId: string | null;
  liveSessionIds: string[];
  liveSessionIdsExplicit: boolean;
  connectedCount: number;
}

export type SessionAction =
  | { type: 'CREATE_SESSION'; session: Session; activate: boolean }
  | { type: 'UPDATE_SESSION'; id: string; updates: Partial<Session> }
  | { type: 'MOVE_SESSION'; id: string; toIndex: number }
  | { type: 'DELETE_SESSION'; id: string }
  | { type: 'SET_ACTIVE_SESSION'; id: string }
  | { type: 'SET_LIVE_SESSIONS'; ids: string[] }
  | { type: 'SET_SESSION_STATE'; id: string; state: SessionState }
  | { type: 'SET_SESSION_TITLE'; id: string; title: string }
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
      const nextActiveSessionId = action.activate ? action.session.id : state.activeSessionId || action.session.id;
      const nextLiveSessionIds = state.liveSessionIdsExplicit
        ? (
          state.liveSessionIds.includes(action.session.id)
            ? state.liveSessionIds
            : state.liveSessionIds
        )
        : (nextActiveSessionId ? [nextActiveSessionId] : []);
      return {
        ...state,
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
        liveSessionIds: nextLiveSessionIds,
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
      const liveSessionIds = normalizedIds.filter((id) => state.sessions.some((session) => session.id === id));
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
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  setLiveSessionIds: (ids: string[]) => void;
  moveSession: (id: string, toIndex: number) => void;
  renameSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  resumeActiveSessionTransport: (id: string) => boolean;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (sessionId: string, file: File) => Promise<void>;
  sendFileAttach: (sessionId: string, file: File) => Promise<void>;
  requestRemoteScreenshot: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => Promise<RemoteScreenshotCapture>;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => void;
  requestScheduleList: (sessionId: string) => void;
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
  sendMessageRaw: (sessionId: string, msg: unknown) => void;
}

export interface SessionProviderProps {
  children: React.ReactNode;
  wsUrl?: string;
  terminalCacheLines?: number;
  bridgeSettings?: BridgeSettings;
  appForegroundActive?: boolean;
}

export interface CreateSessionOptions {
  activate?: boolean;
  connect?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

export interface SessionReconnectRuntime {
  attempt: number;
  timer: number | null;
  nextDelayMs: number | null;
  connecting: boolean;
}

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
  return {
    attempt: 0,
    timer: null,
    nextDelayMs: null,
    connecting: false,
  };
}

export function computeReconnectDelay(attempt: number) {
  if (attempt <= 0) return 0;
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

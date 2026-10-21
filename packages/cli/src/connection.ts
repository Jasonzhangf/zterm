import type { AuthenticatedAccount } from './account-client.js';
import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
} from '../../shared/src/connection/relay-directory.js';
import type { TerminalWidthMode } from '../../shared/src/connection/bridge-settings.js';
import { DEFAULT_BRIDGE_PORT } from '../../shared/src/connection/mobile-config.js';
import type { TraversalRouteHealthScope } from '../../shared/src/connection/traversal/route-health-cache.js';
import type {
  AttemptFailure,
  AttemptId,
  InitialAttemptControl,
  InitialAttemptEvent,
  InitialAttemptPort,
  TraversalSettingsSource,
  TraversalTargetSource,
  TraversalTimerHandle,
  TraversalDiagnostics,
} from '../../shared/src/connection/traversal/types.js';
import {
  buildTerminalMuxChannelBinary,
  buildTerminalMuxChannelMessage,
  buildTerminalMuxChannelOpen,
  buildTerminalMuxHello,
  buildTerminalMuxTargetMessage,
  isTerminalMuxServerFrame,
  type TerminalBackendKind,
  type TerminalInputAckPayload,
  type TerminalMuxChannelClientMessage,
  type TerminalMuxChannelServerMessage,
  type TerminalMuxCapabilities,
  type TerminalMuxClientFrame,
  type TerminalMuxServerFrame,
  type TerminalMuxTargetClientMessage,
  type TerminalSessionCatalogEntry,
  type TerminalSessionCapabilitiesPayload,
  type TerminalSnapshotRequestPayload,
  type TerminalSnapshotResultPayload,
} from '../../shared/src/connection/protocol.js';

export type SessionConnectionFrame = TerminalMuxClientFrame | TerminalMuxServerFrame;

export type SessionConnectionState =
  | 'idle'
  | 'socket-connecting'
  | 'mux-hello'
  | 'awaiting-mux-ready'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed';

export type SessionConnectionStage =
  | 'resolution'
  | 'socket-connect'
  | 'mux-ready'
  | 'list-sessions'
  | 'snapshot'
  | 'channel-open'
  | 'channel-send'
  | 'closed';

export type SessionConnectionErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'auth_failed'
  | 'socket_error'
  | 'service_error'
  | 'unknown_failure'
  | 'protocol_error'
  | 'handshake_timeout'
  | 'server_error'
  | 'timeout'
  | 'cancelled'
  | 'socket_closed'
  | 'identity_mismatch'
  | 'channel_closed'
  | 'send_failed'
  | 'closed';

export class SessionConnectionError extends Error {
  readonly stage: SessionConnectionStage;
  readonly code: SessionConnectionErrorCode;
  readonly serverCode?: string;
  readonly requestId?: string;
  readonly channelId?: string;

  constructor(
    message: string,
    options: {
      stage: SessionConnectionStage;
      code: SessionConnectionErrorCode;
      serverCode?: string;
      requestId?: string;
      channelId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionConnectionError';
    this.stage = options.stage;
    this.code = options.code;
    this.serverCode = asNonEmptyString(options.serverCode) || undefined;
    this.requestId = options.requestId;
    this.channelId = options.channelId;
  }
}

export interface SessionConnectionServer {
  deviceId: string;
  daemonHostId: string;
}

export interface SessionConnectionRouteContext {
  device: RelayDirectoryDevice;
  daemon: RelayDirectoryDaemon;
  target: TraversalTargetSource;
  settings: TraversalSettingsSource;
  routeHealthScope: TraversalRouteHealthScope;
}

export interface SessionConnectionTraversalSocket extends InitialAttemptControl {
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  getDiagnostics(): TraversalDiagnostics;
}

export interface SessionConnectionTraversalOptions {
  autoReconnect: false;
  requireOpenConfirmation: true;
  routeHealthScope: TraversalRouteHealthScope;
  candidateScope: 'bound-initial';
  initialAttemptPort: InitialAttemptPort;
}

export interface SessionConnectionTraversalFactory {
  createSocket(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options: SessionConnectionTraversalOptions,
  ): SessionConnectionTraversalSocket;
}

export interface SessionConnectionTimerPort {
  setTimeout(callback: () => void, delayMs: number): TraversalTimerHandle;
  clearTimeout(handle: TraversalTimerHandle): void;
}

export interface SessionConnectionOptions {
  account: AuthenticatedAccount;
  server: SessionConnectionServer;
  routeHealthScope: TraversalRouteHealthScope;
  traversalFactory: SessionConnectionTraversalFactory;
  clientInstanceId: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  timers?: SessionConnectionTimerPort;
}

export interface SessionListResult {
  sessions: string[];
  sessionCatalog?: TerminalSessionCatalogEntry[];
}

export interface SessionSnapshotInput {
  backend: TerminalBackendKind;
  stableId: string;
  maxLines: number;
}

export interface SessionOpenExistingInput {
  sessionName: string;
  backend: TerminalBackendKind;
  stableId: string;
  cols?: number;
  rows?: number;
  widthMode?: TerminalWidthMode;
  autoCommand?: string;
  bodySubscribed?: boolean;
}

export interface SessionChannel {
  readonly id: string;
  readonly sessionName: string;
  readonly stableId: string;
  readonly capabilities?: TerminalSessionCapabilitiesPayload;
  send(message: TerminalMuxChannelClientMessage): void;
  sendBinary(dataBase64: string): void;
  close(reason?: string): void;
}

export type SessionConnectionEvent =
  | { type: 'state'; state: SessionConnectionState }
  | {
      type: 'ready';
      daemonHostId?: string;
      capabilities: TerminalMuxCapabilities;
    }
  | { type: 'target-message'; requestId?: string; message: Extract<
      TerminalMuxServerFrame,
      { type: 'mux-target-message' }
    >['payload']['message'] }
  | {
      type: 'channel-opened';
      channelId: string;
      sessionName: string;
      stableId: string;
      capabilities?: TerminalSessionCapabilitiesPayload;
    }
  | {
      type: 'channel-message';
      channelId: string;
      message: TerminalMuxChannelServerMessage;
    }
  | {
      type: 'channel-binary';
      channelId: string;
      dataBase64: string;
    }
  | {
      type: 'input-ack';
      channelId: string;
      payload: TerminalInputAckPayload;
    }
  | {
      type: 'channel-closed';
      channelId: string;
      reason: string;
      code?: string;
    }
  | { type: 'closed'; reason: string }
  | { type: 'error'; error: SessionConnectionError };

interface PendingTargetRequest {
  kind: 'list-sessions' | 'snapshot';
  stage: 'list-sessions' | 'snapshot';
  expectedStableId?: string;
  expectedBackend?: TerminalBackendKind;
  timer: TraversalTimerHandle;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve(payload: SessionListResult | TerminalSnapshotResultPayload): void;
  reject(error: SessionConnectionError): void;
}

interface PendingChannelOpen {
  channelId: string;
  sessionName: string;
  expectedStableId: string;
  timer: TraversalTimerHandle;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve(channel: SessionChannel): void;
  reject(error: SessionConnectionError): void;
}

const defaultTimers: SessionConnectionTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function requirePositiveTimeout(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveExactDirectoryServer(
  account: AuthenticatedAccount,
  selection: SessionConnectionServer,
) {
  const directory: RelayAccountDirectory = account.directory;
  if (directory.user.id !== account.user.id) {
    throw new SessionConnectionError('account and directory identities differ', {
      stage: 'resolution',
      code: 'invalid_context',
    });
  }
  const deviceId = asNonEmptyString(selection.deviceId);
  const daemonHostId = asNonEmptyString(selection.daemonHostId);
  if (!deviceId || !daemonHostId) {
    throw new SessionConnectionError('deviceId and daemonHostId are required', {
      stage: 'resolution',
      code: 'invalid_context',
    });
  }
  const device = directory.devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device?.daemon || device.daemon.hostId !== daemonHostId) {
    throw new SessionConnectionError('selected directory daemon was not found', {
      stage: 'resolution',
      code: 'invalid_context',
    });
  }
  return { device, daemon: device.daemon };
}

export function buildSessionConnectionRouteContext(
  account: AuthenticatedAccount,
  server: SessionConnectionServer,
  routeHealthScope: TraversalRouteHealthScope,
): SessionConnectionRouteContext {
  const { device, daemon } = resolveExactDirectoryServer(account, server);
  if (
    routeHealthScope.accountId !== account.user.id
    || routeHealthScope.daemonHostId !== daemon.hostId
  ) {
    throw new SessionConnectionError('route-health scope does not match the selected account and daemon', {
      stage: 'resolution',
      code: 'invalid_context',
    });
  }

  const firstDirectEndpoint = daemon.endpoints.find((endpoint) =>
    endpoint.kind === 'lan'
    || endpoint.kind === 'tailscale'
    || endpoint.kind === 'ipv6'
    || endpoint.kind === 'ipv4');
  const bridgeHost = firstDirectEndpoint?.host?.trim()
    || firstDirectEndpoint?.wsUrl?.trim()
    || '';
  const bridgePort = firstDirectEndpoint?.port || DEFAULT_BRIDGE_PORT;
  const relayClientUrl = account.ws?.client?.trim() || '';
  const target: TraversalTargetSource = {
    bridgeHost,
    bridgePort,
    daemonHostId: daemon.hostId,
    relayHostId: daemon.hostId,
    relayEndpointCandidates: daemon.endpoints,
    signalUrl: relayClientUrl,
    transportMode: 'auto',
  };
  const settings: TraversalSettingsSource = {
    signalUrl: relayClientUrl,
    turnServerUrl: account.turn?.url || '',
    turnUsername: account.turn?.username || '',
    turnCredential: account.turn?.credential || '',
    transportMode: 'auto',
    traversalRelay: {
      relayBaseUrl: account.relayBaseUrl,
      accessToken: account.accessToken,
      userId: account.user.id,
      username: account.user.username,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: device.platform,
      wsDevicesUrl: account.ws?.devices || '',
      wsHostUrl: account.ws?.host || '',
      wsClientUrl: relayClientUrl,
      turnUrl: account.turn?.url || '',
      turnUsername: account.turn?.username || '',
      turnCredential: account.turn?.credential || '',
      updatedAt: Date.now(),
    },
  };
  return {
    device,
    daemon,
    target,
    settings,
    routeHealthScope: { ...routeHealthScope },
  };
}

function decodeMessageData(data: string | ArrayBuffer) {
  return typeof data === 'string'
    ? data
    : new TextDecoder().decode(new Uint8Array(data));
}

function isSnapshotInput(input: SessionSnapshotInput) {
  return Boolean(asNonEmptyString(input.stableId))
    && (input.backend === 'tmux' || input.backend === 'herdr')
    && Number.isSafeInteger(input.maxLines)
    && input.maxLines > 0;
}

export class SessionConnection {
  private readonly context: SessionConnectionRouteContext;

  private readonly traversalFactory: SessionConnectionTraversalFactory;

  private readonly clientInstanceId: string;

  private readonly requestTimeoutMs: number;

  private readonly handshakeTimeoutMs: number;

  private readonly timers: SessionConnectionTimerPort;

  private readonly eventListeners = new Set<(event: SessionConnectionEvent) => void>();

  private readonly pendingRequests = new Map<string, PendingTargetRequest>();

  private readonly pendingChannelOpens = new Map<string, PendingChannelOpen>();

  private readonly channelMap = new Map<string, SessionChannel>();

  private readonly initialAttemptPort: InitialAttemptPort;

  private socket: SessionConnectionTraversalSocket | null = null;

  private requestSequence = 0;

  private channelSequence = 0;

  private handshakeTimer: TraversalTimerHandle | null = null;

  private currentAttemptId: AttemptId | null = null;

  private helloSendInFlight = false;

  private readyCommitted = false;

  private terminalError: SessionConnectionError | null = null;

  private readyPromise: Promise<void>;

  private resolveReady!: () => void;

  private rejectReady!: (error: SessionConnectionError) => void;

  private _state: SessionConnectionState = 'idle';

  constructor(private readonly options: SessionConnectionOptions) {
    this.context = buildSessionConnectionRouteContext(
      options.account,
      options.server,
      options.routeHealthScope,
    );
    this.traversalFactory = options.traversalFactory;
    this.clientInstanceId = asNonEmptyString(options.clientInstanceId);
    this.requestTimeoutMs = requirePositiveTimeout(options.requestTimeoutMs, 10_000);
    this.handshakeTimeoutMs = requirePositiveTimeout(options.handshakeTimeoutMs, 5_000);
    this.timers = options.timers || defaultTimers;
    if (!this.clientInstanceId) {
      throw new SessionConnectionError('clientInstanceId is required', {
        stage: 'socket-connect',
        code: 'invalid_context',
      });
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.initialAttemptPort = {
      onEvent: (event) => this.handleInitialAttemptEvent(event),
    };
    this.start();
  }

  public get state() {
    return this._state;
  }

  public get channels(): ReadonlyMap<string, SessionChannel> {
    return this.channelMap;
  }

  public ready() {
    return this.readyPromise;
  }

  public onEvent(listener: (event: SessionConnectionEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public getDiagnostics(): TraversalDiagnostics | null {
    return this.socket?.getDiagnostics() ?? null;
  }

  public async listSessions(
    options: { backend?: TerminalBackendKind } = {},
    signal?: AbortSignal,
  ): Promise<SessionListResult> {
    await this.waitForReady('list-sessions', signal);
    const message = {
      type: 'list-sessions',
      ...(options.backend
        ? { payload: { terminalBackend: options.backend } }
        : {}),
    } as const;
    return await this.requestTarget(
      'list-sessions',
      message,
      { stage: 'list-sessions', signal },
    ) as SessionListResult;
  }

  public async readSnapshot(
    input: SessionSnapshotInput,
    signal?: AbortSignal,
  ): Promise<TerminalSnapshotResultPayload> {
    if (!isSnapshotInput(input)) {
      throw new SessionConnectionError('snapshot input is invalid', {
        stage: 'snapshot',
        code: 'invalid_input',
      });
    }
    await this.waitForReady('snapshot', signal);
    const request: TerminalSnapshotRequestPayload = {
      version: 1,
      backend: input.backend,
      stableId: input.stableId,
      maxLines: input.maxLines,
    };
    const message = {
      type: 'terminal-snapshot-request',
      payload: request,
    } as const;
    return await this.requestTarget(
      'snapshot',
      message,
      {
        stage: 'snapshot',
        signal,
        expectedStableId: input.stableId,
        expectedBackend: input.backend,
      },
    ) as TerminalSnapshotResultPayload;
  }

  public async openExisting(
    input: SessionOpenExistingInput,
    signal?: AbortSignal,
  ): Promise<SessionChannel> {
    const sessionName = asNonEmptyString(input.sessionName);
    const stableId = asNonEmptyString(input.stableId);
    if (!sessionName || !stableId || (input.backend !== 'tmux' && input.backend !== 'herdr')) {
      throw new SessionConnectionError('exact existing session identity is required', {
        stage: 'channel-open',
        code: 'invalid_input',
      });
    }
    await this.waitForReady('channel-open', signal);
    const channelId = this.nextChannelId();
    const frame = buildTerminalMuxChannelOpen({
      channelId,
      sessionName,
      backend: input.backend,
      expectedSessionIdentity: stableId,
      existingOnly: true,
      cols: input.cols,
      rows: input.rows,
      widthMode: input.widthMode,
      autoCommand: input.autoCommand,
      bodySubscribed: input.bodySubscribed,
    });

    const channelPromise = new Promise<SessionChannel>((resolve, reject) => {
      const pending: PendingChannelOpen = {
        channelId,
        sessionName,
        expectedStableId: stableId,
        timer: this.timers.setTimeout(() => {
          this.rejectChannelOpen(
            channelId,
            new SessionConnectionError('channel open timed out', {
              stage: 'channel-open',
              code: 'timeout',
              channelId,
            }),
            'channel_open_timeout',
          );
        }, this.requestTimeoutMs),
        signal,
        resolve,
        reject,
      };
      this.pendingChannelOpens.set(channelId, pending);
      this.attachAbort(pending.signal, () => {
        this.rejectChannelOpen(
          channelId,
          new SessionConnectionError('channel open was cancelled', {
            stage: 'channel-open',
            code: 'cancelled',
            channelId,
          }),
          'channel_open_cancelled',
        );
      }, pending);
    });
    try {
      this.sendFrame(frame);
    } catch (error) {
      const pending = this.pendingChannelOpens.get(channelId);
      if (pending) {
        this.cleanupPendingChannelOpen(channelId, pending);
        pending.reject(new SessionConnectionError('channel open send failed', {
          stage: 'channel-open',
          code: 'send_failed',
          channelId,
          cause: error,
        }));
      }
    }
    return await channelPromise;
  }

  public close(reason = 'client_close') {
    if (this._state === 'closed') {
      return;
    }
    const closeReason = asNonEmptyString(reason) || 'client_close';
    this.setState('closing');
    this.clearHandshakeTimer();
    this.currentAttemptId = null;

    const closedError = new SessionConnectionError('connection closed by client', {
      stage: 'closed',
      code: 'closed',
    });
    for (const [requestId, pending] of this.pendingRequests) {
      this.cleanupPendingRequest(requestId, pending);
      pending.reject(new SessionConnectionError('connection closed by client', {
        stage: pending.stage,
        code: 'closed',
        requestId,
      }));
    }
    for (const [channelId, pending] of this.pendingChannelOpens) {
      this.cleanupPendingChannelOpen(channelId, pending);
      pending.reject(new SessionConnectionError('connection closed by client', {
        stage: 'channel-open',
        code: 'closed',
        channelId,
      }));
    }
    for (const channel of [...this.channelMap.values()]) {
      this.writeChannelClose(channel.id, closeReason);
      this.removeChannel(channel.id, closeReason, 'client_close');
    }

    this.terminalError = closedError;
    this.rejectReady(closedError);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, closeReason);
      } catch {
        // The socket may already be closed.
      }
    }
    this.setState('closed');
    this.emit({ type: 'closed', reason: closeReason });
    this.eventListeners.clear();
  }

  private start() {
    this.setState('socket-connecting');
    let socket: SessionConnectionTraversalSocket;
    try {
      socket = this.traversalFactory.createSocket(
        this.context.target,
        this.context.settings,
        {
          autoReconnect: false,
          requireOpenConfirmation: true,
          routeHealthScope: this.context.routeHealthScope,
          candidateScope: 'bound-initial',
          initialAttemptPort: this.initialAttemptPort,
        },
      );
    } catch (error) {
      this.failConnection(new SessionConnectionError('socket creation failed', {
        stage: 'socket-connect',
        code: 'socket_error',
        cause: error,
      }), false);
      return;
    }
    this.socket = socket;
    socket.onclose = (event) => {
      if (!this.readyCommitted || this._state !== 'ready') {
        return;
      }
      this.failConnection(new SessionConnectionError(
        'socket closed after mux readiness',
        {
          stage: 'closed',
          code: 'socket_closed',
          cause: event,
        },
      ), false);
    };
  }

  private handleInitialAttemptEvent(event: InitialAttemptEvent) {
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') {
      return;
    }
    switch (event.type) {
      case 'begin':
        this.handleAttemptBegin(event.attemptId);
        return;
      case 'invalidated':
        this.handleAttemptInvalidated(event);
        return;
      case 'message':
        this.handleAttemptMessage(event.attemptId, event.data);
        return;
      case 'terminal':
        this.handleAttemptTerminal(event);
        return;
    }
  }

  private handleAttemptBegin(attemptId: AttemptId) {
    if (this.readyCommitted) {
      return;
    }
    this.clearHandshakeTimer();
    this.currentAttemptId = attemptId;
    this.setState('mux-hello');
    const socket = this.socket;
    if (!socket) {
      return;
    }
    let sent = false;
    this.helloSendInFlight = true;
    try {
      sent = socket.sendForAttempt(attemptId, JSON.stringify(buildTerminalMuxHello(
        this.clientInstanceId,
        this.context.device.deviceId,
      )));
    } catch (error) {
      socket.failAttempt(attemptId, {
        stage: 'mux',
        kind: 'unknown',
        cause: error,
      });
      return;
    } finally {
      this.helloSendInFlight = false;
    }
    if (
      !sent
      || this.currentAttemptId !== attemptId
      || this.readyCommitted
      || this._state !== 'mux-hello'
    ) {
      return;
    }
    this.setState('awaiting-mux-ready');
    this.handshakeTimer = this.timers.setTimeout(() => {
      if (
        this.currentAttemptId !== attemptId
        || this.readyCommitted
        || this._state !== 'awaiting-mux-ready'
      ) {
        return;
      }
      this.handshakeTimer = null;
      socket.failAttempt(attemptId, {
        stage: 'mux',
        kind: 'timeout',
        timer: 'hello',
      });
    }, this.handshakeTimeoutMs);
  }

  private handleAttemptInvalidated(
    event: Extract<InitialAttemptEvent, { type: 'invalidated' }>,
  ) {
    if (event.attemptId !== this.currentAttemptId) {
      return;
    }
    const wasReady = this.readyCommitted;
    this.clearHandshakeTimer();
    this.currentAttemptId = null;
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') {
      return;
    }
    if (wasReady) {
      this.failConnection(this.attemptFailureError(event.failure || {
        stage: 'mux',
        kind: 'unknown',
      }), false);
      return;
    }
    this.setState('socket-connecting');
  }

  private handleAttemptMessage(attemptId: AttemptId, data: string | ArrayBuffer) {
    if (attemptId !== this.currentAttemptId) {
      return;
    }
    this.handleSocketMessage(attemptId, data);
  }

  private handleAttemptTerminal(
    event: Extract<InitialAttemptEvent, { type: 'terminal' }>,
  ) {
    if (
      event.attemptId !== undefined
      && this.currentAttemptId !== null
      && event.attemptId !== this.currentAttemptId
    ) {
      return;
    }
    if (
      this.readyCommitted
      && event.attemptId !== undefined
      && event.attemptId !== this.currentAttemptId
    ) {
      return;
    }
    this.clearHandshakeTimer();
    this.currentAttemptId = null;
    this.failConnection(this.attemptFailureError(event.failure), false);
  }

  private handleSocketMessage(attemptId: AttemptId, data: string | ArrayBuffer) {
    let value: unknown;
    try {
      value = JSON.parse(decodeMessageData(data)) as unknown;
    } catch (error) {
      this.handleAttemptFailure(attemptId, {
        stage: 'mux',
        kind: 'protocol',
        code: 'invalid-json',
        cause: error,
      });
      return;
    }
    if (!isTerminalMuxServerFrame(value)) {
      this.handleAttemptFailure(attemptId, {
        stage: 'mux',
        kind: 'protocol',
        code: 'invalid-mux',
      });
      return;
    }
    const frame = value;
    switch (frame.type) {
      case 'mux-ready':
        this.handleMuxReady(attemptId, frame);
        return;
      case 'mux-target-message':
        this.handleTargetMessage(frame);
        return;
      case 'mux-channel-opened':
        this.handleChannelOpened(frame);
        return;
      case 'mux-channel-message':
        this.handleChannelMessage(frame);
        return;
      case 'mux-channel-closed':
        this.handleChannelClosed(frame);
        return;
      case 'mux-error':
        this.handleMuxError(attemptId, frame);
        return;
      case 'mux-pong':
        return;
    }
  }

  private handleAttemptFailure(attemptId: AttemptId, failure: AttemptFailure) {
    if (this._state === 'ready') {
      this.failConnection(this.attemptFailureError(failure), true);
      return;
    }
    this.socket?.failAttempt(attemptId, failure);
  }

  private handleMuxReady(
    attemptId: AttemptId,
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-ready' }>,
  ) {
    if (
      attemptId !== this.currentAttemptId
      || this.readyCommitted
      || (
        this._state !== 'awaiting-mux-ready'
        && !(this.helloSendInFlight && this._state === 'mux-hello')
      )
    ) {
      this.failConnection(new SessionConnectionError('unexpected mux-ready frame', {
        stage: this.stageForCurrentState(),
        code: 'protocol_error',
        cause: {
          stage: 'mux',
          kind: 'protocol',
          code: 'unexpected-frame',
          cause: frame,
        } satisfies AttemptFailure,
      }), true);
      return;
    }
    if (
      frame.payload.daemonHostId
      && frame.payload.daemonHostId !== this.context.daemon.hostId
    ) {
      this.handleAttemptFailure(attemptId, {
        stage: 'mux',
        kind: 'binding',
        expectedDaemonHostId: this.context.daemon.hostId,
        actualDaemonHostId: frame.payload.daemonHostId,
        cause: frame,
      });
      return;
    }
    const socket = this.socket;
    if (!socket) {
      return;
    }
    let confirmed = false;
    try {
      confirmed = socket.confirmAttempt(attemptId);
    } catch (error) {
      socket.failAttempt(attemptId, {
        stage: 'mux',
        kind: 'unknown',
        cause: error,
      });
      return;
    }
    if (
      !confirmed
      || attemptId !== this.currentAttemptId
      || this.readyCommitted
    ) {
      return;
    }
    this.clearHandshakeTimer();
    this.readyCommitted = true;
    this.setState('ready');
    this.resolveReady();
    this.emit({
      type: 'ready',
      daemonHostId: frame.payload.daemonHostId,
      capabilities: frame.payload.capabilities,
    });
  }

  private handleTargetMessage(
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-target-message' }>,
  ) {
    const requestId = asNonEmptyString(frame.payload.requestId);
    const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
    if (pending) {
      if (frame.payload.message.type === 'error') {
        this.settlePendingRequest(requestId, pending);
        pending.reject(new SessionConnectionError(
          frame.payload.message.payload.message || 'target request failed',
          {
            stage: pending.stage,
            code: frame.payload.message.payload.code
              ? 'server_error'
              : 'server_error',
            requestId,
          },
        ));
      } else if (
        pending.kind === 'list-sessions'
        && frame.payload.message.type === 'sessions'
      ) {
        this.settlePendingRequest(requestId, pending);
        pending.resolve(frame.payload.message.payload);
      } else if (
        pending.kind === 'snapshot'
        && frame.payload.message.type === 'terminal-snapshot-result'
      ) {
        const result = frame.payload.message.payload;
        if (
          result.status === 'available'
          && (
            result.stableId !== pending.expectedStableId
            || result.backend !== pending.expectedBackend
          )
        ) {
          this.settlePendingRequest(requestId, pending);
          pending.reject(new SessionConnectionError('snapshot identity differs from the request', {
            stage: pending.stage,
            code: 'identity_mismatch',
            requestId,
          }));
        } else {
          this.settlePendingRequest(requestId, pending);
          pending.resolve(result);
        }
      } else {
        this.settlePendingRequest(requestId, pending);
        pending.reject(new SessionConnectionError('target response type does not match the request', {
          stage: pending.stage,
          code: 'protocol_error',
          requestId,
        }));
      }
    }
    this.emit({
      type: 'target-message',
      requestId: requestId || undefined,
      message: frame.payload.message,
    });
  }

  private handleChannelOpened(
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-channel-opened' }>,
  ) {
    const channelId = frame.payload.channelId;
    const pending = this.pendingChannelOpens.get(channelId);
    if (!pending) {
      this.writeChannelClose(channelId, 'unexpected_channel_opened');
      return;
    }
    if (
      frame.payload.stableId !== pending.expectedStableId
      || frame.payload.sessionName !== pending.sessionName
    ) {
      this.rejectChannelOpen(channelId, new SessionConnectionError(
        'opened channel identity differs from the request',
        {
          stage: 'channel-open',
          code: 'identity_mismatch',
          channelId,
        },
      ), 'session_identity_mismatch');
      return;
    }
    this.cleanupPendingChannelOpen(channelId, pending);
    const channel = this.createChannel({
      id: channelId,
      sessionName: frame.payload.sessionName,
      stableId: frame.payload.stableId,
      capabilities: frame.payload.capabilities,
    });
    this.channelMap.set(channelId, channel);
    pending.resolve(channel);
    this.emit({
      type: 'channel-opened',
      channelId,
      sessionName: channel.sessionName,
      stableId: channel.stableId,
      capabilities: channel.capabilities,
    });
  }

  private handleChannelMessage(
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-channel-message' }>,
  ) {
    const channelId = frame.payload.channelId;
    if (!this.channelMap.has(channelId)) {
      return;
    }
    this.emit({
      type: 'channel-message',
      channelId,
      message: frame.payload.message,
    });
    if (frame.payload.message.type === 'input-ack') {
      this.emit({
        type: 'input-ack',
        channelId,
        payload: frame.payload.message.payload,
      });
    }
  }

  private handleChannelClosed(
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-channel-closed' }>,
  ) {
    const channelId = frame.payload.channelId;
    const pending = this.pendingChannelOpens.get(channelId);
    if (pending) {
      this.cleanupPendingChannelOpen(channelId, pending);
      pending.reject(new SessionConnectionError(frame.payload.reason, {
        stage: 'channel-open',
        code: 'channel_closed',
        serverCode: frame.payload.code,
        channelId,
      }));
      return;
    }
    if (this.channelMap.has(channelId)) {
      this.removeChannel(
        channelId,
        frame.payload.reason,
        frame.payload.code,
      );
    }
  }

  private handleMuxError(
    attemptId: AttemptId,
    frame: Extract<TerminalMuxServerFrame, { type: 'mux-error' }>,
  ) {
    const channelId = asNonEmptyString(frame.payload.channelId);
    if (channelId) {
      const pending = this.pendingChannelOpens.get(channelId);
      if (pending) {
        this.cleanupPendingChannelOpen(channelId, pending);
        pending.reject(new SessionConnectionError(frame.payload.message, {
          stage: 'channel-open',
          code: 'server_error',
          channelId,
        }));
        return;
      }
    }
    if (this._state !== 'ready') {
      this.handleAttemptFailure(attemptId, {
        stage: 'mux',
        kind: 'mux-rejection',
        code: asNonEmptyString(frame.payload.code) || undefined,
        cause: frame,
      });
      return;
    }
    this.failConnection(new SessionConnectionError(frame.payload.message, {
      stage: this.stageForCurrentState(),
      code: 'server_error',
      serverCode: frame.payload.code,
      channelId: channelId || undefined,
    }), true);
  }

  private async requestTarget(
    kind: PendingTargetRequest['kind'],
    message: TerminalMuxTargetClientMessage,
    options: {
      stage: PendingTargetRequest['stage'];
      signal?: AbortSignal;
      expectedStableId?: string;
      expectedBackend?: TerminalBackendKind;
    },
  ): Promise<SessionListResult | TerminalSnapshotResultPayload> {
    if (this._state !== 'ready') {
      throw this.terminalError || new SessionConnectionError('connection is not ready', {
        stage: options.stage,
        code: 'closed',
      });
    }
    const requestId = this.nextRequestId();
    const frame = buildTerminalMuxTargetMessage(message, requestId);
    return await new Promise<SessionListResult | TerminalSnapshotResultPayload>((resolve, reject) => {
      const pending: PendingTargetRequest = {
        kind,
        stage: options.stage,
        expectedStableId: options.expectedStableId,
        expectedBackend: options.expectedBackend,
        timer: this.timers.setTimeout(() => {
          this.rejectPendingRequest(requestId, new SessionConnectionError('target request timed out', {
            stage: options.stage,
            code: 'timeout',
            requestId,
          }));
        }, this.requestTimeoutMs),
        signal: options.signal,
        resolve,
        reject,
      };
      this.pendingRequests.set(requestId, pending);
      this.attachAbort(options.signal, () => {
        this.rejectPendingRequest(requestId, new SessionConnectionError('target request was cancelled', {
          stage: options.stage,
          code: 'cancelled',
          requestId,
        }));
      }, pending);
      try {
        this.sendFrame(frame);
      } catch (error) {
        this.settlePendingRequest(requestId, pending);
        pending.reject(new SessionConnectionError('target request send failed', {
          stage: options.stage,
          code: 'send_failed',
          requestId,
          cause: error,
        }));
      }
    });
  }

  private waitForReady(stage: SessionConnectionStage, signal?: AbortSignal) {
    if (this._state === 'ready') {
      return Promise.resolve();
    }
    if (this.terminalError && (this._state === 'failed' || this._state === 'closed')) {
      return Promise.reject(this.terminalError);
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        finish(() => reject(new SessionConnectionError('operation cancelled before readiness', {
          stage,
          code: 'cancelled',
        })));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.readyPromise.then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private createChannel(input: {
    id: string;
    sessionName: string;
    stableId: string;
    capabilities?: TerminalSessionCapabilitiesPayload;
  }): SessionChannel {
    return {
      id: input.id,
      sessionName: input.sessionName,
      stableId: input.stableId,
      capabilities: input.capabilities,
      send: (message) => this.sendChannelMessage(input.id, message),
      sendBinary: (dataBase64) => this.sendChannelBinary(input.id, dataBase64),
      close: (reason = 'client_close') => {
        if (!this.channelMap.has(input.id)) {
          return;
        }
        this.writeChannelClose(input.id, reason);
        this.removeChannel(input.id, reason, 'client_close');
      },
    };
  }

  private sendChannelMessage(channelId: string, message: TerminalMuxChannelClientMessage) {
    if (!this.channelMap.has(channelId)) {
      throw new SessionConnectionError('channel is not open', {
        stage: 'channel-send',
        code: 'channel_closed',
        channelId,
      });
    }
    let frame: TerminalMuxClientFrame;
    try {
      frame = buildTerminalMuxChannelMessage(channelId, message);
    } catch (error) {
      throw new SessionConnectionError('channel message is not a session-bound message', {
        stage: 'channel-send',
        code: 'invalid_input',
        channelId,
        cause: error,
      });
    }
    this.sendFrame(frame);
  }

  private sendChannelBinary(channelId: string, dataBase64: string) {
    if (!this.channelMap.has(channelId)) {
      throw new SessionConnectionError('channel is not open', {
        stage: 'channel-send',
        code: 'channel_closed',
        channelId,
      });
    }
    this.sendFrame(buildTerminalMuxChannelBinary(channelId, dataBase64));
  }

  private sendFrame(frame: TerminalMuxClientFrame) {
    if (!this.socket || this._state === 'closed' || this._state === 'closing') {
      throw new SessionConnectionError('transport is not writable', {
        stage: frame.type === 'mux-channel-message' || frame.type === 'mux-channel-binary'
          ? 'channel-send'
          : 'socket-connect',
        code: 'send_failed',
      });
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      throw new SessionConnectionError('transport write failed', {
        stage: frame.type === 'mux-channel-message' || frame.type === 'mux-channel-binary'
          ? 'channel-send'
          : 'socket-connect',
        code: 'send_failed',
        cause: error,
      });
    }
  }

  private writeChannelClose(channelId: string, reason: string) {
    if (!this.socket || this._state === 'closed') {
      return;
    }
    try {
      this.socket.send(JSON.stringify({
        type: 'mux-channel-close',
        payload: {
          channelId,
          reason,
        },
      } satisfies TerminalMuxClientFrame));
    } catch {
      // Channel release continues even if the physical socket already closed.
    }
  }

  private removeChannel(channelId: string, reason: string, code?: string) {
    if (!this.channelMap.delete(channelId)) {
      return;
    }
    this.emit({
      type: 'channel-closed',
      channelId,
      reason,
      code,
    });
  }

  private rejectPendingRequest(requestId: string, error: SessionConnectionError) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.settlePendingRequest(requestId, pending);
    pending.reject(error);
  }

  private settlePendingRequest(requestId: string, pending: PendingTargetRequest) {
    this.cleanupPendingRequest(requestId, pending);
  }

  private cleanupPendingRequest(requestId: string, pending: PendingTargetRequest) {
    this.pendingRequests.delete(requestId);
    this.timers.clearTimeout(pending.timer);
    this.detachAbort(pending.signal, pending.abortListener);
  }

  private rejectChannelOpen(channelId: string, error: SessionConnectionError, closeReason: string) {
    const pending = this.pendingChannelOpens.get(channelId);
    if (!pending) {
      return;
    }
    this.cleanupPendingChannelOpen(channelId, pending);
    this.writeChannelClose(channelId, closeReason);
    pending.reject(error);
  }

  private cleanupPendingChannelOpen(channelId: string, pending: PendingChannelOpen) {
    this.pendingChannelOpens.delete(channelId);
    this.timers.clearTimeout(pending.timer);
    this.detachAbort(pending.signal, pending.abortListener);
  }

  private attachAbort<T extends PendingTargetRequest | PendingChannelOpen>(
    signal: AbortSignal | undefined,
    listener: () => void,
    pending: T,
  ) {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      listener();
      return;
    }
    const abortListener = () => {
      listener();
    };
    pending.abortListener = abortListener;
    signal.addEventListener('abort', abortListener, { once: true });
  }

  private detachAbort(
    signal: AbortSignal | undefined,
    listener: (() => void) | undefined,
  ) {
    if (signal && listener) {
      signal.removeEventListener('abort', listener);
    }
  }

  private attemptFailureError(failure: AttemptFailure) {
    const stage: SessionConnectionStage = this._state === 'ready'
      ? 'closed'
      : failure.stage === 'mux'
        ? 'mux-ready'
        : 'socket-connect';
    let code: SessionConnectionErrorCode;
    let serverCode: string | undefined;
    switch (failure.kind) {
      case 'http':
        code = failure.status === 401 || failure.status === 403
          ? 'auth_failed'
          : failure.status === undefined
            ? 'unknown_failure'
            : 'service_error';
        break;
      case 'system':
        code = 'socket_error';
        break;
      case 'ws-close':
        code = failure.code === 4001 ? 'auth_failed' : 'socket_closed';
        break;
      case 'rtc-state':
        code = 'socket_error';
        break;
      case 'rtc-rejection':
        code = 'service_error';
        serverCode = typeof failure.code === 'string' ? failure.code : undefined;
        break;
      case 'timeout':
        code = failure.stage === 'mux' ? 'handshake_timeout' : 'timeout';
        break;
      case 'protocol':
        code = 'protocol_error';
        break;
      case 'binding':
        code = 'identity_mismatch';
        break;
      case 'mux-rejection':
        code = 'service_error';
        serverCode = failure.code;
        break;
      case 'unknown':
        code = 'unknown_failure';
        break;
    }
    return new SessionConnectionError('initial traversal attempt failed', {
      stage,
      code,
      serverCode,
      cause: failure,
    });
  }

  private failConnection(error: SessionConnectionError, closeSocket: boolean) {
    if (this._state === 'closed' || this._state === 'failed') {
      return;
    }
    this.clearHandshakeTimer();
    this.terminalError = error;
    this.setState('failed');
    for (const [requestId, pending] of this.pendingRequests) {
      this.cleanupPendingRequest(requestId, pending);
      pending.reject(new SessionConnectionError('connection failed', {
        stage: pending.stage,
        code: error.code,
        serverCode: error.serverCode,
        requestId,
        cause: error,
      }));
    }
    for (const [channelId, pending] of this.pendingChannelOpens) {
      this.cleanupPendingChannelOpen(channelId, pending);
      pending.reject(new SessionConnectionError('connection failed during channel open', {
        stage: 'channel-open',
        code: error.code,
        serverCode: error.serverCode,
        channelId,
        cause: error,
      }));
    }
    for (const channelId of [...this.channelMap.keys()]) {
      this.removeChannel(channelId, error.message, error.code);
    }
    this.rejectReady(error);
    this.emit({ type: 'error', error });
    if (closeSocket) {
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        socket.onclose = null;
      }
      try {
        socket?.close(1000, error.code);
      } catch {
        // Preserve the first protocol or transport error.
      }
    }
  }

  private stageForCurrentState(): SessionConnectionStage {
    if (this._state === 'ready') {
      return 'closed';
    }
    if (this._state === 'awaiting-mux-ready' || this._state === 'mux-hello') {
      return 'mux-ready';
    }
    return 'socket-connect';
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer === null) {
      return;
    }
    this.timers.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private nextRequestId() {
    this.requestSequence += 1;
    return `cli-${this.clientInstanceId}-request-${this.requestSequence}`;
  }

  private nextChannelId() {
    this.channelSequence += 1;
    return `cli-${this.clientInstanceId}-channel-${this.channelSequence}`;
  }

  private setState(state: SessionConnectionState) {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.emit({ type: 'state', state });
  }

  private emit(event: SessionConnectionEvent) {
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }
}

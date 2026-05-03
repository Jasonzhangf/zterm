/**
 * Transport Layer - WebSocket management, heartbeat, and reconnect decorators.
 *
 * This module provides a WebSocket transport implementation and decorators
 * for adding automatic reconnect and heartbeat capabilities.
 *
 * The base Transport interface follows the native WebSocket API pattern with
 * onopen/onmessage/onclose/onerror callbacks, making it a drop-in replacement
 * for existing WebSocket usage in SessionContext.
 */

export interface Transport {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  getDiagnostics(): TransportDiagnostics;
  readonly readyState: number;
}

export interface TransportDiagnostics {
  readyState: number;
  protocol?: string;
  bytesSent: number;
  bytesReceived: number;
  reason?: string;
}

export interface HeartbeatOptions {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  pingMessage?: string;
  onTimeout?: (transport: Transport) => void;
}

export interface ReconnectOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onReconnectAttempt?: (attempt: number, delayMs: number) => void;
  onReconnectSuccess?: () => void;
  onReconnectFailure?: (error: Error) => void;
}

// ============================================================================
// WebSocketTransport: raw WebSocket wrapper
// ============================================================================

export class WebSocketTransport implements Transport {
  private ws: WebSocket;
  private _bytesSent = 0;
  private _bytesReceived = 0;

  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = (event) => {
      this.onopen?.(event);
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this._bytesReceived += new TextEncoder().encode(event.data).byteLength;
      } else if (event.data instanceof ArrayBuffer) {
        this._bytesReceived += event.data.byteLength;
      }
      this.onmessage?.(event);
    };

    this.ws.onclose = (event) => {
      this.onclose?.(event);
    };

    this.ws.onerror = (event) => {
      this.onerror?.(event);
    };
  }

  send(data: string | ArrayBuffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not open (readyState=${this.ws.readyState})`);
    }
    this.ws.send(data);
    if (typeof data === 'string') {
      this._bytesSent += new TextEncoder().encode(data).byteLength;
    } else {
      this._bytesSent += data.byteLength;
    }
  }

  close(code?: number, reason?: string): void {
    if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    this.ws.close(code, reason);
  }

  getDiagnostics(): TransportDiagnostics {
    return {
      readyState: this.ws.readyState,
      protocol: this.ws.protocol,
      bytesSent: this._bytesSent,
      bytesReceived: this._bytesReceived,
    };
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

// ============================================================================
// HeartbeatDecorator: adds ping/pong monitoring to an existing transport
// ============================================================================

/**
 * Wraps a Transport and adds heartbeat (ping/pong) monitoring.
 * Sends a ping message at regular intervals and expects a pong response.
 * If a pong is not received within the timeout, the onTimeout callback is invoked.
 *
 * The decorator forwards all events (onopen, onmessage, onclose, onerror) from
 * the underlying transport, but also intercepts message events to detect pongs.
 */
export class HeartbeatTransport implements Transport {
  private inner: Transport;
  private options: HeartbeatOptions;
  private pingInterval: number | null = null;
  private pongTimeout: number | null = null;
  private lastPongAt: number = Date.now();
  private closed = false;

  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  constructor(inner: Transport, options: HeartbeatOptions) {
    this.inner = inner;
    this.options = options;

    // Bind to inner transport events
    inner.onopen = (event) => {
      this.startHeartbeat();
      this.onopen?.(event);
    };

    inner.onmessage = (event) => {
      this.handleMessage(event);
      this.onmessage?.(event);
    };

    inner.onclose = (event) => {
      this.stopHeartbeat();
      this.onclose?.(event);
    };

    inner.onerror = (event) => {
      this.onerror?.(event);
    };
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      const trimmed = event.data.trim();
      if (trimmed === 'pong' || trimmed === '{"type":"pong"}') {
        this.lastPongAt = Date.now();
        this.resetPongTimeout();
        return;
      }
    }
  }

  private startHeartbeat(): void {
    if (this.closed) return;
    this.stopHeartbeat();

    this.pingInterval = window.setInterval(() => {
      if (this.closed || this.inner.readyState !== WebSocket.OPEN) {
        return;
      }
      // Send ping message
      const pingMsg = this.options.pingMessage ?? 'ping';
      try {
        this.inner.send(pingMsg);
      } catch (err) {
        // If send fails, the transport will likely error out soon
        console.warn('[HeartbeatTransport] ping send failed:', err);
        return;
      }

      this.resetPongTimeout();
    }, this.options.pingIntervalMs);
  }

  private resetPongTimeout(): void {
    if (this.pongTimeout !== null) {
      window.clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }

    this.pongTimeout = window.setTimeout(() => {
      if (this.closed) return;
      // Pong timeout: no response within expected window
      const elapsed = Date.now() - this.lastPongAt;
      if (elapsed >= this.options.pongTimeoutMs) {
        console.warn('[HeartbeatTransport] pong timeout, transport may be stale');
        if (this.options.onTimeout) {
          this.options.onTimeout(this);
        } else {
          // Default: close the underlying transport to trigger reconnect layer
          try {
            this.inner.close();
          } catch (e) {
            // ignore
          }
        }
      }
    }, this.options.pongTimeoutMs);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout !== null) {
      window.clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  send(data: string | ArrayBuffer): void {
    this.inner.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.inner.close(code, reason);
  }

  getDiagnostics(): TransportDiagnostics {
    const innerDiag = this.inner.getDiagnostics();
    return {
      ...innerDiag,
      // Add heartbeat-specific info if needed
    };
  }

  get readyState(): number {
    return this.inner.readyState;
  }
}

// ============================================================================
// ReconnectDecorator: automatically reconnects when the underlying transport closes
// ============================================================================

/**
 * Wraps a Transport factory and automatically reconnects after unexpected disconnections.
 *
 * The decorator maintains its own readyState and callbacks. When the inner transport
 * emits a 'close' event (unless it was a manual close), it schedules a reconnect
 * attempt using exponential backoff. During reconnect attempts, send() will throw
 * an error (caller should retry later). The wrapper passes through all events
 * and seamlessly replaces the inner transport when a new connection succeeds.
 *
 * Important: This decorator DOES NOT buffer messages. Callers must check readyState
 * before sending.
 */
export class ReconnectTransport implements Transport {
  private inner: Transport | null = null;
  private url: string;
  private transportFactory: (url: string) => Transport;
  private options: ReconnectOptions;
  private manualClose = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private reconnectInProgress = false;

  // Callbacks that external code attaches to this wrapper
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  constructor(
    url: string,
    transportFactory: (url: string) => Transport,
    options: ReconnectOptions
  ) {
    this.url = url;
    this.transportFactory = transportFactory;
    this.options = options;
    this.connect();
  }

  private connect(): void {
    if (this.inner) {
      this.detachInnerEvents();
      try {
        this.inner.close();
      } catch (e) {
        // ignore
      }
    }

    const newTransport = this.transportFactory(this.url);
    this.inner = newTransport;
    this.attachInnerEvents();

    // If the transport is already open (synchronously unlikely), but we're safe.
  }

  private attachInnerEvents(): void {
    if (!this.inner) return;

    this.inner.onopen = (event) => {
      this.reconnectInProgress = false;
      this.attempt = 0;
      this.onopen?.(event);
    };

    this.inner.onmessage = (event) => {
      this.onmessage?.(event);
    };

    this.inner.onclose = (event) => {
      // If manual close, do not attempt reconnect
      if (this.manualClose) {
        this.onclose?.(event);
        return;
      }

      // Notify external listeners about the close (they may want to update UI)
      this.onclose?.(event);

      // Start reconnect procedure
      this.scheduleReconnect();
    };

    this.inner.onerror = (event) => {
      this.onerror?.(event);
    };
  }

  private detachInnerEvents(): void {
    if (!this.inner) return;
    // Remove references to prevent potential memory leaks
    this.inner.onopen = null;
    this.inner.onmessage = null;
    this.inner.onclose = null;
    this.inner.onerror = null;
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    if (this.reconnectInProgress) return;
    if (this.attempt >= this.options.maxAttempts) {
      const error = new Error(`Reconnect failed after ${this.options.maxAttempts} attempts`);
      this.options.onReconnectFailure?.(error);
      // Trigger final onclose with error reason?
      return;
    }

    const delay = this.computeDelay();
    this.reconnectInProgress = true;
    this.options.onReconnectAttempt?.(this.attempt + 1, delay);

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.attempt++;
      this.connect();
      // The onopen of the new inner transport will clear reconnectInProgress and reset attempt.
    }, delay);
  }

  private computeDelay(): number {
    if (this.attempt === 0) return 0;
    const exponential = this.options.baseDelayMs * Math.pow(2, this.attempt - 1);
    return Math.min(this.options.maxDelayMs, exponential);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectInProgress = false;
  }

  send(data: string | ArrayBuffer): void {
    if (!this.inner || this.inner.readyState !== WebSocket.OPEN) {
      throw new Error('Transport not ready: connection not open');
    }
    this.inner.send(data);
  }

  close(code?: number, reason?: string): void {
    this.manualClose = true;
    this.cancelReconnect();
    if (this.inner) {
      this.inner.close(code, reason);
    }
  }

  getDiagnostics(): TransportDiagnostics {
    if (this.inner) {
      return this.inner.getDiagnostics();
    }
    return {
      readyState: WebSocket.CLOSED,
      bytesSent: 0,
      bytesReceived: 0,
      reason: 'No active transport',
    };
  }

  get readyState(): number {
    return this.inner ? this.inner.readyState : WebSocket.CLOSED;
  }
}

// ============================================================================
// Factory function for a fully decorated transport (heartbeat + reconnect)
// ============================================================================

export interface CreateTransportOptions {
  /**
   * Base WebSocket URL.
   */
  url: string;
  /**
   * Enable heartbeat monitoring. Default: true.
   */
  heartbeat?: Partial<HeartbeatOptions> | false;
  /**
   * Enable automatic reconnect. Default: true.
   */
  reconnect?: Partial<ReconnectOptions> | false;
  /**
   * Custom transport factory (useful for testing). Default: WebSocketTransport.
   */
  transportFactory?: (url: string) => Transport;
}

const DEFAULT_HEARTBEAT_OPTIONS: HeartbeatOptions = {
  pingIntervalMs: 30000,
  pongTimeoutMs: 70000,
  pingMessage: 'ping',
};

const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  maxAttempts: 10,
  baseDelayMs: 1200,
  maxDelayMs: 30000,
};

/**
 * Creates a Transport instance optionally decorated with heartbeat and reconnect.
 *
 * The returned transport is ready to use. If reconnect is enabled, the transport
 * will automatically attempt to re-establish the connection upon unexpected closure.
 * If heartbeat is enabled, it will send periodic pings and monitor pong responses.
 *
 * @example
 * ```typescript
 * const transport = createTransport({
 *   url: 'ws://localhost:8080',
 *   heartbeat: { pingIntervalMs: 15000, pongTimeoutMs: 30000 },
 *   reconnect: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000 }
 * });
 *
 * transport.onopen = () => console.log('connected');
 * transport.onmessage = (e) => console.log('msg', e.data);
 * transport.send('hello');
 * ```
 */
export function createTransport(options: CreateTransportOptions): Transport {
  const {
    url,
    heartbeat = true,
    reconnect = true,
    transportFactory = (u: string) => new WebSocketTransport(u),
  } = options;

  let transport: Transport = transportFactory(url);

  // Apply heartbeat decorator if enabled
  if (heartbeat !== false) {
    const heartbeatOpts: HeartbeatOptions = {
      ...DEFAULT_HEARTBEAT_OPTIONS,
      ...(typeof heartbeat === 'object' ? heartbeat : {}),
    };
    transport = new HeartbeatTransport(transport, heartbeatOpts);
  }

  // Apply reconnect decorator if enabled
  if (reconnect !== false) {
    const reconnectOpts: ReconnectOptions = {
      ...DEFAULT_RECONNECT_OPTIONS,
      ...(typeof reconnect === 'object' ? reconnect : {}),
    };
    // For reconnect, we need to capture the factory that creates the base transport
    // without the heartbeat decorator applied twice. However, the current factory
    // already includes heartbeat. That's fine because when reconnect creates a new
    // transport, it will also include heartbeat (the factory is the same).
    transport = new ReconnectTransport(url, (u) => {
      let t = transportFactory(u);
      if (heartbeat !== false) {
        const hbOpts: HeartbeatOptions = {
          ...DEFAULT_HEARTBEAT_OPTIONS,
          ...(typeof heartbeat === 'object' ? heartbeat : {}),
        };
        t = new HeartbeatTransport(t, hbOpts);
      }
      return t;
    }, reconnectOpts);
  }

  return transport;
}

// Re-export WebSocket constants for convenience
export const WebSocketState = {
  CONNECTING: WebSocket.CONNECTING,
  OPEN: WebSocket.OPEN,
  CLOSING: WebSocket.CLOSING,
  CLOSED: WebSocket.CLOSED,
} as const;

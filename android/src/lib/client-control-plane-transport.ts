import type { ClientControlDirectoryRuntime } from './client-control-directory-runtime';
import type {
  BridgeSocketCloseLike,
  BridgeSocketMessageLike,
  BridgeTransportSocket,
  TraversalDiagnostics,
  TraversalTransportMode,
} from './traversal/types';

interface ClientControlPlaneTransportOptions {
  daemonHostId: string;
  mode: TraversalTransportMode;
  directoryRuntime: Pick<ClientControlDirectoryRuntime, 'isConfirmed' | 'read' | 'readStatus' | 'subscribe'>;
  openConfirmedTransport: () => BridgeTransportSocket;
  confirmationTimeoutMs?: number;
}

export class ClientControlPlaneTransport implements BridgeTransportSocket {
  public onopen: ((event?: Event) => void) | null = null;

  public onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;

  public onerror: ((event?: Event) => void) | null = null;

  public onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;

  private inner: BridgeTransportSocket | null = null;

  private closed = false;

  private failureReason: string | undefined;

  private unsubscribe: (() => void) | null;

  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly options: ClientControlPlaneTransportOptions) {
    this.unsubscribe = options.directoryRuntime.subscribe(() => this.openWhenConfirmed());
    this.confirmationTimer = setTimeout(
      () => this.failWaitingForControlDirectory(),
      options.confirmationTimeoutMs ?? 10_000,
    );
    queueMicrotask(() => this.openWhenConfirmed());
  }

  public get readyState() {
    return this.inner?.readyState ?? (this.closed ? WebSocket.CLOSED : WebSocket.CONNECTING);
  }

  public get bufferedAmount() {
    return this.inner?.bufferedAmount || 0;
  }

  private openWhenConfirmed() {
    if (this.closed || this.inner || !this.options.directoryRuntime.isConfirmed()) {
      return;
    }
    this.clearConfirmationTimer();
    if (!this.options.directoryRuntime.read(this.options.daemonHostId)) {
      this.closed = true;
      this.failureReason = `confirmed control directory has no target ${this.options.daemonHostId}`;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onclose?.({ code: 4404, reason: this.failureReason });
      return;
    }

    let inner: BridgeTransportSocket;
    try {
      inner = this.options.openConfirmedTransport();
    } catch (error) {
      this.closed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.failureReason = `confirmed transport configuration failed: ${message}`;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onclose?.({ code: 4409, reason: this.failureReason });
      return;
    }
    this.inner = inner;
    this.unsubscribe?.();
    this.unsubscribe = null;
    inner.onopen = (event) => this.onopen?.(event);
    inner.onmessage = (event) => this.onmessage?.(event);
    inner.onerror = (event) => this.onerror?.(event);
    inner.onclose = (event) => this.onclose?.(event);
  }

  private clearConfirmationTimer() {
    if (this.confirmationTimer === null) {
      return;
    }
    clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }

  private failWaitingForControlDirectory() {
    if (this.closed || this.inner) {
      return;
    }
    this.confirmationTimer = null;
    this.closed = true;
    this.failureReason = 'control directory confirmation timeout';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onclose?.({ code: 4408, reason: this.failureReason });
  }

  private resolveWaitingReason() {
    const status = this.options.directoryRuntime.readStatus(this.options.daemonHostId);
    if (!status.confirmed) {
      return `waiting for control directory generation ${status.generation} for target ${this.options.daemonHostId}`;
    }
    if (status.targetPresent === false) {
      return `confirmed control directory generation ${status.generation} has no target ${this.options.daemonHostId}`;
    }
    return `opening confirmed control directory generation ${status.generation} target ${this.options.daemonHostId}`;
  }

  public send(data: string | ArrayBuffer) {
    if (!this.inner || this.inner.readyState !== WebSocket.OPEN) {
      throw new Error('control-confirmed daemon transport is not open');
    }
    this.inner.send(data);
  }

  public close(code?: number, reason?: string) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearConfirmationTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inner?.close(code, reason);
  }

  public confirmTransportReady() {
    this.inner?.confirmTransportReady?.();
  }

  public reportFailure(reason: string, options?: { authFailure?: boolean }) {
    this.failureReason = reason;
    this.inner?.reportFailure(reason, options);
  }

  public getDiagnostics(): TraversalDiagnostics {
    if (this.inner) {
      return this.inner.getDiagnostics();
    }
    return {
      mode: this.options.mode,
      stage: this.closed ? (this.failureReason ? 'error' : 'closed') : 'connecting',
      reason: this.failureReason || this.resolveWaitingReason(),
      attempts: [],
    };
  }
}

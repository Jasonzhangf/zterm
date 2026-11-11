import type {
  AppErrorCode,
  AppSendResultPayload,
  AppSendResultStatus,
} from "../../../../../packages/shared/src/connection/app-protocol.ts";

/**
 * Public contract types for the Zterm V2 connections module.
 *
 * First increment surface: connect / openChannel / observeLink / closeOwnLink.
 * The module owns physical links and generations only. It does not own member
 * roles, agent sessions, delivery state, or ticket completion.
 *
 * Channel kinds:
 *   - terminal: a real terminal-mux session channel. Requires a legal target
 *     (sessionName/backend) and a remote open/ack before any payload may be sent.
 *   - message / file / receipt / status: generic business channels carried by
 *     their own real service (V1 /app in a later increment). Terminal mux does
 *     NOT advertise these; requesting them here returns unsupported_channel.
 */
export type LinkKind = "terminal" | "message" | "file" | "receipt" | "status";

export type TerminalBackendKind = "tmux" | "herdr";

/**
 * One machine-scoped terminal session the peer proved in its catalog.
 * `stableId` is the daemon-issued identity used for exact-existing channel
 * targets; it is never synthesized from `name`.
 */
export interface SessionCatalogEntry {
  readonly name: string;
  readonly backend: TerminalBackendKind;
  readonly stableId: string;
}

export interface TerminalChannelTarget {
  readonly sessionName: string;
  readonly backend?: TerminalBackendKind;
  readonly expectedSessionIdentity?: string;
  readonly existingOnly?: true;
  readonly cols?: number;
  readonly rows?: number;
  readonly bodySubscribed?: boolean;
}

export interface ChannelOpenRequest {
  readonly channelId: string;
  readonly kind: LinkKind;
  readonly target?: TerminalChannelTarget;
}

export interface ChannelOpenResult {
  readonly sessionName?: string;
  readonly stableId?: string;
}

export type LinkState = "connecting" | "connected" | "closed" | "unreachable" | "rejected";

/** Actual transport path class, derived only from the real connection result. */
export type LinkPath = "direct" | "relay" | "unknown";

export type Freshness = "fresh" | "stale" | "unavailable";

export interface LinkCapabilities {
  readonly channelKinds: readonly LinkKind[];
  readonly transportKind: string;
}

/** Opaque stable handle to a physical machine link. */
export interface LinkRef {
  readonly id: string;
  readonly machineId: string;
  readonly generation: number;
}

/** Opaque handle to a logical channel bound to a link. */
export interface ChannelRef {
  readonly id: string;
  readonly linkId: string;
  readonly kind: LinkKind;
  readonly sessionName?: string;
}

export interface LinkBackpressure {
  readonly queuedBytes: number;
  readonly bufferedBytes: number;
  readonly backpressured: boolean;
}

export interface LinkObservation {
  readonly machineId: string;
  readonly generation: number;
  readonly path: LinkPath;
  readonly status: LinkState;
  readonly freshness: Freshness;
  readonly observedAt: number;
  readonly transportKind: string;
  /** Peer-proven identity, or null when the wire omits it. */
  readonly peerIdentity: string | null;
  /** True only when the peer proved an identity matching the requested machine. */
  readonly peerIdentityVerified: boolean;
  readonly capabilities: LinkCapabilities;
  readonly backpressure: LinkBackpressure;
  readonly errorCode?: string;
}

export interface LinkCloseInfo {
  readonly code?: number;
  readonly reason?: string;
}

export interface ChannelMessage {
  readonly kind: LinkKind;
  readonly channelId: string;
  readonly linkId: string;
  readonly data: string | ArrayBuffer;
}

export interface ChannelCloseInfo {
  readonly reason?: string;
  readonly code?: string;
}

export type ChannelEventHandler = (event: ChannelMessage) => void;

/**
 * One requests-message command on an accepted `message` channel. It carries
 * only the V1 logical message id and the non-secret destination selector;
 * the caller never supplies target credentials or a raw destination URL.
 */
export interface AppMessageRequest {
  /**
   * Wire correlation id and V1 logical message id. Persisted at accept time,
   * reused on resume, and never regenerated per attempt.
   */
  readonly v1MessageId: string;
  /**
   * Persisted destination machine selector. connections resolves this into the
   * exact V1 AppTarget through the accounts authorization port; it is never
   * written to the wire.
   */
  readonly targetMachineId: string;
  readonly subject: string;
  readonly body: string;
}

/** Public outcome of one `requestMessage` call. */
export type AppMessageResult =
  | {
      readonly kind: "result";
      readonly requestId: string;
      readonly messageId: string;
      readonly status: AppSendResultStatus;
      readonly stage: AppSendResultPayload["stage"];
    }
  | {
      readonly kind: "unknown";
      readonly requestId: string;
      readonly messageId: string;
      readonly errorRef: string;
      readonly cause?: string;
    }
  | {
      readonly kind: "rejected";
      /** Wire-level AppProtocolError code, or a connection-level code. */
      readonly code: AppErrorCode | "peer_identity_mismatch" | "unsupported_channel";
      readonly stage?: string;
      readonly errorRef?: string;
      readonly cause?: string;
    };

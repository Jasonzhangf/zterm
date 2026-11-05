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

export interface ChannelMessage {
  readonly kind: LinkKind;
  readonly channelId: string;
  readonly linkId: string;
  readonly data: string | ArrayBuffer;
}

export type ChannelEventHandler = (event: ChannelMessage) => void;

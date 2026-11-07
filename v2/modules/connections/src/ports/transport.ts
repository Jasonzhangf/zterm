/** Platform transport contract for a machine link (implemented by adapters). */
import type { AuthorizedMachineLink } from "./accounts-authorization.ts";
import type { ConnectionError } from "../public/errors.ts";
import type {
  ChannelOpenRequest,
  ChannelOpenResult,
  LinkKind,
  LinkPath,
  SessionCatalogEntry,
} from "../public/types.ts";

export interface TransportCloseInfo {
  readonly code?: number;
  readonly reason?: string;
}

/** A connected, peer-verified transport. */
export interface TransportHandle {
  /** Path class proven by the real connection result, never assumed. */
  readonly path: LinkPath;
  readonly transportKind: string;
  /** Peer-proven identity, or null when the wire omits it. */
  readonly peerIdentity: string | null;
  /** True only when the peer proved an identity matching the requested machine. */
  readonly peerIdentityVerified: boolean;
  /** Channel kinds the peer declared during handshake. */
  readonly peerChannelKinds: readonly LinkKind[];
  readonly bufferedBytes: number;
  /**
   * Read the peer's machine-scoped terminal session catalog through a target
   * control message. This never opens or writes a terminal channel.
   */
  listSessions(): Promise<readonly SessionCatalogEntry[]>;
  /**
   * Ask the peer to open a real channel and wait for its accept/reject. A
   * channel is addressable only after this resolves; callers must not invent an
   * address and send to it. Unsupported kinds reject with unsupported_channel.
   */
  openChannel(request: ChannelOpenRequest): Promise<ChannelOpenResult>;
  /**
   * Write one payload onto a channel the peer already accepted as a legal
   * protocol channel frame. Never a bare broadcast or an unregistered channel.
   */
  sendChannel(channelId: string, data: string | ArrayBuffer): void;
  /** Close a channel the peer accepted. */
  closeChannel(channelId: string, reason?: string): void;
  close(code?: number, reason?: string): void;
  /** Subscribe to inbound channel frames already routed by channel id. */
  onChannelMessage(handler: (channelId: string, data: string | ArrayBuffer) => void): () => void;
  onClose(handler: (info: TransportCloseInfo) => void): void;
  /** Notify when a channel this link accepted was closed by the remote peer. */
  onChannelClosed(handler: (channelId: string, info?: { reason?: string; code?: string }) => void): () => void;
  /** Notify when a late-open channel close frame could not be sent. */
  onChannelCloseFailure(handler: (failure: ConnectionError) => void): () => void;
  /**
   * Retry releasing one late-open channel. The transport keeps the pending
   * release until the close frame is sent or the physical link closes.
   */
  retryLateOpenClose(channelId: string): void;
}

export interface TransportOpenContext {
  readonly clientInstanceId: string;
}

export interface TransportPort {
  /** Open a real link or throw a typed ConnectionError. */
  open(auth: AuthorizedMachineLink, context: TransportOpenContext): Promise<TransportHandle>;
}

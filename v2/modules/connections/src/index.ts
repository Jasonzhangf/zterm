export { createConnectionManager } from "./public/link-port.ts";
export type { ConnectionManager, ConnectionManagerOptions } from "./public/link-port.ts";
export { ConnectionError } from "./public/errors.ts";
export type { ConnectionErrorCode } from "./public/errors.ts";
export type {
  LinkKind,
  TerminalBackendKind,
  TerminalChannelTarget,
  ChannelOpenRequest,
  ChannelOpenResult,
  LinkState,
  LinkPath,
  Freshness,
  LinkCapabilities,
  LinkRef,
  ChannelRef,
  LinkBackpressure,
  LinkObservation,
  SessionCatalogEntry,
  ChannelMessage,
  ChannelEventHandler,
  AppMessageRequest,
  AppMessageResult,
} from "./public/types.ts";
export type { AuthorizedMachineLink, AccountsAuthorizationPort } from "./ports/accounts-authorization.ts";
export type { TransportHandle, TransportPort } from "./ports/transport.ts";
export { V1TraversalTransport } from "./adapters/v1-traversal.ts";
export { createAppCodec, AppWebSocketTransport, buildAppGatewayUrl } from "./adapters/app-websocket.ts";
export type { AppFrameTransportHandle } from "./adapters/app-websocket.ts";

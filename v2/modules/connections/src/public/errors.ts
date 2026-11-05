/** Typed error surface for the connections module. */
export type ConnectionErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "directory_rejected"
  | "machine_mismatch"
  | "peer_identity_mismatch"
  | "unreachable"
  | "unsupported_channel"
  | "channel_close_failed"
  | "link_not_found"
  | "link_closed"
  | "stale_generation"
  | "unknown";

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  readonly machineId?: string;
  readonly channelId?: string;

  constructor(
    code: ConnectionErrorCode,
    message: string,
    options: { machineId?: string; channelId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectionError";
    this.code = code;
    this.machineId = options.machineId;
    this.channelId = options.channelId;
  }
}

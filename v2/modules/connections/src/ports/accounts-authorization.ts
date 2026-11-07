/**
 * Injected accounts authorization port.
 *
 * The connections module never reads a credential store or config file. It only
 * consumes an already-verified authorization produced by the accounts owner.
 * The resolved target/settings carry transport tokens for the real handshake,
 * but connections must not persist, log, or surface them in observations.
 */
import type {
  TraversalSettingsSource,
  TraversalTargetSource,
} from "../../../../../packages/shared/src/connection/traversal/index.ts";
import type { LinkCapabilities } from "../public/types.ts";

export interface AuthorizedMachineLink {
  /** Stable target machine identity requested by the caller. */
  readonly machineId: string;
  /** Actual peer daemon identity that the target must prove during handshake. */
  readonly daemonHostId: string;
  readonly accountId: string;
  /** Opaque verified authorization handle. Never a secret, never a ticket payload. */
  readonly authorizationId: string;
  readonly capabilities: LinkCapabilities;
  /** Endpoint candidates + transport token, produced by accounts. */
  readonly target: TraversalTargetSource;
  /** Relay/TURN settings, produced by accounts. */
  readonly settings: TraversalSettingsSource;
}

export interface AccountsAuthorizationPort {
  /**
   * Resolve and verify the caller authorization for the target machine.
   * Implementations throw ConnectionError("unauthorized"|"directory_rejected").
   */
  authorizeMachine(machineId: string): Promise<AuthorizedMachineLink>;
}

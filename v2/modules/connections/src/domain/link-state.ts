/** Domain ownership of physical-link identity, generation, and capabilities. */
import type {
  LinkBackpressure,
  LinkCapabilities,
  LinkPath,
  LinkState,
} from "../public/types.ts";
import type { TransportHandle } from "../ports/transport.ts";

export interface LinkRecord {
  readonly id: string;
  readonly machineId: string;
  readonly generation: number;
  status: LinkState;
  path: LinkPath;
  transportKind: string;
  /** Peer-proven identity, or null when the wire omits it. */
  peerIdentity: string | null;
  /** True only when the peer proved an identity matching the requested machine. */
  peerIdentityVerified: boolean;
  capabilities: LinkCapabilities;
  observedAt: number;
  backpressure: LinkBackpressure;
  errorCode?: string;
  transport?: TransportHandle;
}

export interface LinkStateUpdate {
  status?: LinkState;
  path?: LinkPath;
  transportKind?: string;
  observedAt?: number;
  backpressure?: LinkBackpressure;
  errorCode?: string;
}

/**
 * Generation fencing: a transport callback bound to an older generation must
 * not overwrite the current link truth after a reconnect (or after a stale
 * socket wakes up).
 */
export function isCurrentGeneration(record: Pick<LinkRecord, "generation">, generation: number) {
  return record.generation === generation;
}

export class LinkStore {
  private readonly records = new Map<string, LinkRecord>();

  get(id: string): LinkRecord | undefined {
    return this.records.get(id);
  }

  put(record: LinkRecord): void {
    this.records.set(record.id, record);
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  update(id: string, update: LinkStateUpdate): LinkRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (update.status !== undefined) record.status = update.status;
    if (update.path !== undefined) record.path = update.path;
    if (update.transportKind !== undefined) record.transportKind = update.transportKind;
    if (update.observedAt !== undefined) record.observedAt = update.observedAt;
    if (update.backpressure !== undefined) record.backpressure = update.backpressure;
    if (update.errorCode !== undefined) record.errorCode = update.errorCode;
    return record;
  }

  /** Returns the next monotonically increasing generation for a link id. */
  nextGeneration(id: string): number {
    const current = this.records.get(id);
    return (current?.generation ?? 0) + 1;
  }
}

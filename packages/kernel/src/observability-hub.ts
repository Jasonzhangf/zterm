import { KernelContractError } from './errors.ts';

export interface ObservabilityRecord {
  readonly kind: string;
  readonly at: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class ObservabilityHub {
  private readonly records: ObservabilityRecord[] = [];
  private readonly maxEntries: number;
  private dropped = 0;

  constructor(maxEntries = 1_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new KernelContractError('invalid_observability_bound', 'maxEntries must be a positive safe integer');
    }
    this.maxEntries = maxEntries;
  }

  record(record: ObservabilityRecord): void {
    if (!record.kind.trim() || !Number.isFinite(record.at)) {
      throw new KernelContractError('invalid_observability_record', 'observability kind and timestamp are required');
    }
    validateMetadata(record.metadata);
    this.records.push(Object.freeze({
      kind: record.kind,
      at: record.at,
      metadata: Object.freeze({ ...record.metadata }),
    }));
    if (this.records.length > this.maxEntries) {
      this.records.shift();
      this.dropped += 1;
    }
  }

  read(): readonly ObservabilityRecord[] {
    return this.records.slice();
  }

  droppedCount(): number {
    return this.dropped;
  }
}

function validateMetadata(metadata: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (/(?:payload|body|chunk|data|request|response)/iu.test(key)) {
      throw new KernelContractError('business_payload_forbidden', `business payload field is not allowed: ${key}`);
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new KernelContractError('business_payload_forbidden', `non-scalar observability metadata is not allowed: ${key}`);
    }
  }
}

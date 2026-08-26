import { KernelContractError } from './errors.ts';

export interface ProjectionSnapshot<T> {
  readonly revision: number;
  readonly value: Readonly<T>;
}

export class ProjectionRegistry<T> {
  private current: ProjectionSnapshot<T> | null = null;

  commit(revision: number, value: T): ProjectionSnapshot<T> {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new KernelContractError('invalid_revision', 'projection revision must be a non-negative safe integer');
    }
    if (this.current && revision <= this.current.revision) {
      throw new KernelContractError('stale_revision', `projection revision ${revision} is not newer than ${this.current.revision}`);
    }
    const next = Object.freeze({ revision, value: freezeValue(value) }) as ProjectionSnapshot<T>;
    this.current = next;
    return next;
  }

  read(): ProjectionSnapshot<T> | null {
    return this.current;
  }
}

function freezeValue<T>(value: T): Readonly<T> {
  deepFreeze(value, new WeakSet<object>());
  return value as Readonly<T>;
}

function deepFreeze(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

export interface DagpipeResultOk {
  ok: true;
  outputs: Record<string, unknown>;
}

export interface DagpipeResultError {
  ok: false;
  error: string;
}

export type DagpipeResult = DagpipeResultOk | DagpipeResultError;

export interface DagpipeCompileResult {
  ok: boolean;
  graphs?: string[];
  error?: string;
}

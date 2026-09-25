import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

interface DagpipeNativeModule {
  compilePhase0: () => string;
  runMirrorPublish: (inputJson: string) => string;
  runControlDispatch: (inputJson: string) => string;
}

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

function sourceIndexNode() {
  const base = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  return join(base, '..', '..', 'native', 'dagpipe', 'index.node');
}

function runtimeIndexNode() {
  return join(process.cwd(), 'dagpipe.node');
}

let cachedNative: DagpipeNativeModule | null = null;

export function loadDagpipeNative(): DagpipeNativeModule {
  if (cachedNative) {
    return cachedNative;
  }
  const candidates = [
    process.env.ZTERM_DAGPIPE_NATIVE,
    sourceIndexNode(),
    runtimeIndexNode(),
  ].filter((value): value is string => Boolean(value));
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error(
      `zterm-dagpipe native module missing; expected one of: ${candidates.join(', ')}`,
    );
  }
  cachedNative = require(selected) as DagpipeNativeModule;
  return cachedNative;
}

export function compilePhase0(): DagpipeCompileResult {
  return JSON.parse(loadDagpipeNative().compilePhase0()) as DagpipeCompileResult;
}

export function runMirrorPublish(input: Record<string, unknown>): DagpipeResult {
  const raw = JSON.parse(loadDagpipeNative().runMirrorPublish(JSON.stringify(input))) as DagpipeResult;
  if (!raw.ok) {
    throw new Error(raw.error);
  }
  return raw;
}

export function runControlDispatch(input: Record<string, unknown>): DagpipeResult {
  const raw = JSON.parse(loadDagpipeNative().runControlDispatch(JSON.stringify(input))) as DagpipeResult;
  if (!raw.ok) {
    throw new Error(raw.error);
  }
  return raw;
}

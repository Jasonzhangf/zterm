import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DagpipeCompileResult,
  DagpipeResult,
} from './dagpipe-types';
export type {
  DagpipeCompileResult,
  DagpipeResult,
  DagpipeResultError,
  DagpipeResultOk,
} from './dagpipe-types';
import { fileURLToPath } from 'node:url';

const require = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

interface DagpipeNativeModule {
  compilePhase0: () => string;
  compilePhase2: () => string;
  compilePhase3: () => string;
  compilePhase4: () => string;
  runConnectionLifecycle: (inputJson: string) => string;
  runBufferManagement: (inputJson: string) => string;
  runBufferRender: (inputJson: string) => string;
  runInputDispatch: (inputJson: string) => string;
  runPhase2Relay: (inputJson: string) => string;
  runPhase2DaemonConnection: (inputJson: string) => string;
  runPhase3InputSchedule: (inputJson: string) => string;
  runPhase3FileBrowse: (inputJson: string) => string;
  runPhase3Upload: (inputJson: string) => string;
  runPhase3Download: (inputJson: string) => string;
  runPhase3Attachment: (inputJson: string) => string;
  runPhase3Screenshot: (inputJson: string) => string;
  runPhase4RemoteWindow: (inputJson: string) => string;
}

function sourceIndexNode() {
  const here = typeof __dirname !== 'undefined'
    ? __dirname
    : fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', 'native', 'dagpipe', 'index.node');
}

function runtimeIndexNode() {
  return join(process.cwd(), 'dagpipe.node');
}

function cwdNativeIndexNode() {
  return join(process.cwd(), 'native', 'dagpipe', 'index.node');
}

function loadDagpipeNative(): DagpipeNativeModule {
  const candidates = [
    process.env.ZTERM_DAGPIPE_NATIVE,
    sourceIndexNode(),
    cwdNativeIndexNode(),
    runtimeIndexNode(),
  ].filter((value): value is string => Boolean(value));
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error(
      `zterm-dagpipe native module missing; expected one of: ${candidates.join(', ')}`,
    );
  }
  return require(selected) as DagpipeNativeModule;
}

function cached(): DagpipeNativeModule {
  // NAPI modules are process-global once loaded. Keep the lookup lazy so tests
  // can point ZTERM_DAGPIPE_NATIVE at a freshly built index.node.
  return loadDagpipeNative();
}

export function compilePhase0(): DagpipeCompileResult {
  return JSON.parse(cached().compilePhase0()) as DagpipeCompileResult;
}

export function compilePhase2(): DagpipeCompileResult {
  return JSON.parse(cached().compilePhase2()) as DagpipeCompileResult;
}

export function compilePhase3(): DagpipeCompileResult {
  return JSON.parse(cached().compilePhase3()) as DagpipeCompileResult;
}

export function compilePhase4(): DagpipeCompileResult {
  return JSON.parse(cached().compilePhase4()) as DagpipeCompileResult;
}

function run(fn: keyof DagpipeNativeModule, input: Record<string, unknown>): DagpipeResult {
  const raw = JSON.parse(
    (cached()[fn] as (json: string) => string)(JSON.stringify(input)),
  ) as DagpipeResult;
  if (!raw.ok) {
    throw new Error(raw.error);
  }
  return raw;
}

export function runConnectionLifecycle(input: Record<string, unknown>): DagpipeResult {
  return run('runConnectionLifecycle', input);
}

export function runBufferManagement(input: Record<string, unknown>): DagpipeResult {
  return run('runBufferManagement', input);
}

export function runBufferRender(input: Record<string, unknown>): DagpipeResult {
  return run('runBufferRender', input);
}

export function runInputDispatch(input: Record<string, unknown>): DagpipeResult {
  return run('runInputDispatch', input);
}

export function runPhase2Relay(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase2Relay', input);
}

export function runPhase2DaemonConnection(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase2DaemonConnection', input);
}

export function runPhase3InputSchedule(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3InputSchedule', input);
}

export function runPhase3FileBrowse(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3FileBrowse', input);
}

export function runPhase3Upload(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3Upload', input);
}

export function runPhase3Download(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3Download', input);
}

export function runPhase3Attachment(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3Attachment', input);
}

export function runPhase3Screenshot(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase3Screenshot', input);
}

export function runPhase4RemoteWindow(input: Record<string, unknown>): DagpipeResult {
  return run('runPhase4RemoteWindow', input);
}

export { readDagpipeInputChunks } from './dagpipe-input-chunks';

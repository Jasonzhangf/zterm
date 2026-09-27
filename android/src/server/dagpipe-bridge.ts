import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

interface DagpipeNativeModule {
  compilePhase0: () => string;
  compileAllDagpipePhases: () => string;
  runPhase2DaemonConnection: (inputJson: string) => string;
  runPhase3InputSchedule: (inputJson: string) => string;
  runPhase3FileBrowse: (inputJson: string) => string;
  runPhase3Upload: (inputJson: string) => string;
  runPhase3Download: (inputJson: string) => string;
  runPhase3Attachment: (inputJson: string) => string;
  runPhase3Screenshot: (inputJson: string) => string;
  runPhase4RemoteWindow: (inputJson: string) => string;
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

export interface MirrorChangedRange {
  startIndex: number;
  endIndex: number;
}

export interface MirrorChangedRangesInput {
  sourceReadback: Record<string, unknown>;
  prevMirrorSnapshot: Record<string, unknown>;
  diffPolicy?: Record<string, unknown>;
  subscriberFacts?: Record<string, unknown>;
}

function sourceIndexNode() {
  const base = typeof __dirname !== 'undefined'
    ? __dirname
    : (
        typeof import.meta.url === 'string' && import.meta.url.length > 0
          ? fileURLToPath(new URL('.', import.meta.url))
          : process.cwd()
      );
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

export function compileAllDagpipePhases(): DagpipeCompileResult {
  return JSON.parse(
    loadDagpipeNative().compileAllDagpipePhases(),
  ) as DagpipeCompileResult;
}

export function runMirrorPublish(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(loadDagpipeNative().runMirrorPublish(JSON.stringify(input))) as DagpipeResult;
}

export function runPhase2DaemonConnection(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase2DaemonConnection(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3InputSchedule(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3InputSchedule(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3FileBrowse(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3FileBrowse(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3Upload(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3Upload(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3Download(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3Download(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3Attachment(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3Attachment(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase3Screenshot(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase3Screenshot(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runPhase4RemoteWindow(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(
    loadDagpipeNative().runPhase4RemoteWindow(JSON.stringify(input)),
  ) as DagpipeResult;
}

export function runControlDispatch(input: Record<string, unknown>): DagpipeResult {
  return JSON.parse(loadDagpipeNative().runControlDispatch(JSON.stringify(input))) as DagpipeResult;
}

export function mirrorPublishChangedRanges(
  input: MirrorChangedRangesInput,
): { ok: true; ranges: MirrorChangedRange[] } | { ok: false; error: string } {
  const result = runMirrorPublish({
    execution_id: 'mirror-runtime',
    attempt_id: 'mirror-runtime',
    inputs: {
      'arc.source_readback': input.sourceReadback,
      'arc.diff_policy': input.diffPolicy ?? {},
      'arc.prev_mirror_snapshot': input.prevMirrorSnapshot,
      'arc.subscriber_facts': input.subscriberFacts ?? {
        subscribers: [{ id: 'live' }],
      },
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const rawWireFrames = result.outputs['arc.wire_frames'];
  if (
    !rawWireFrames ||
    typeof rawWireFrames !== 'object' ||
    !Array.isArray((rawWireFrames as { frames?: unknown }).frames)
  ) {
    return { ok: false, error: 'DAGpipe mirror publish returned no wire frame plan' };
  }
  const frames = (rawWireFrames as {
    frames: Array<{ action?: string; ranges?: Array<{ startIndex?: number; endIndex?: number }> }>;
  }).frames;
  const ranges: MirrorChangedRange[] = [];
  for (const frame of frames) {
    const action = frame.action ?? 'body';
    if (action === 'hold') {
      continue;
    }
    for (const range of frame.ranges ?? []) {
      const startIndex = Number(range.startIndex ?? 0);
      const endIndex = Number(range.endIndex ?? 0);
      if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && endIndex > startIndex) {
        ranges.push({ startIndex, endIndex });
      }
    }
  }
  const merged = ranges
    .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex)
    .reduce<MirrorChangedRange[]>((acc, range) => {
      const previous = acc[acc.length - 1];
      if (previous && range.startIndex <= previous.endIndex) {
        previous.endIndex = Math.max(previous.endIndex, range.endIndex);
        return acc;
      }
      acc.push({ ...range });
      return acc;
    }, []);
  return { ok: true, ranges: merged };
}

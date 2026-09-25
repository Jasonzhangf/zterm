import { Capacitor, registerPlugin } from '@capacitor/core';
import type { DagpipeCompileResult, DagpipeResult } from './dagpipe-types';

interface DagpipeCoreNativePlugin {
  compilePhase0(): Promise<{ method: 'compilePhase0'; json: string }>;
  compileAllDagpipePhases(): Promise<{ method: 'compileAllDagpipePhases'; json: string }>;
  runPhase6Control(options: { inputJson: string }): Promise<{ method: 'runPhase6Control'; json: string }>;
  runPhase7Update(options: { inputJson: string }): Promise<{ method: 'runPhase7Update'; json: string }>;
  runPhase4RemoteWindow(options: { inputJson: string }): Promise<{ method: 'runPhase4RemoteWindow'; json: string }>;
  runPhase5ShellLifecycle(options: { inputJson: string }): Promise<{ method: 'runPhase5ShellLifecycle'; json: string }>;
  runPhase8Connection(options: { inputJson: string }): Promise<{ method: 'runPhase8Connection'; json: string }>;
  runConnectionLifecycle(options: { inputJson: string }): Promise<{ method: 'runConnectionLifecycle'; json: string }>;
  runBufferManagement(options: { inputJson: string }): Promise<{ method: 'runBufferManagement'; json: string }>;
  runBufferRender(options: { inputJson: string }): Promise<{ method: 'runBufferRender'; json: string }>;
  runInputDispatch(options: { inputJson: string }): Promise<{ method: 'runInputDispatch'; json: string }>;
}

const DagpipeCore = registerPlugin<DagpipeCoreNativePlugin>('DagpipeCore');

export function isDagpipeNativeCapable(): boolean {
  return Capacitor.isNativePlatform();
}

function parseResult(method: keyof DagpipeCoreNativePlugin, raw: string): DagpipeResult {
  const parsed = JSON.parse(raw) as DagpipeResult;
  if (!parsed.ok) {
    throw new Error(`${String(method)} failed: ${'error' in parsed ? parsed.error : 'unknown'}`);
  }
  return parsed;
}

export async function compileDagpipePhase0(): Promise<DagpipeCompileResult> {
  return JSON.parse((await DagpipeCore.compilePhase0()).json) as DagpipeCompileResult;
}

export async function compileDagpipeAllPhases(): Promise<DagpipeCompileResult> {
  return JSON.parse(
    (await DagpipeCore.compileAllDagpipePhases()).json,
  ) as DagpipeCompileResult;
}

export async function runDagpipePhase8Connection(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runPhase8Connection',
    (await DagpipeCore.runPhase8Connection({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipePhase6Control(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runPhase6Control',
    (await DagpipeCore.runPhase6Control({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipePhase7Update(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runPhase7Update',
    (await DagpipeCore.runPhase7Update({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipePhase4RemoteWindow(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runPhase4RemoteWindow',
    (await DagpipeCore.runPhase4RemoteWindow({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipePhase5ShellLifecycle(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runPhase5ShellLifecycle',
    (await DagpipeCore.runPhase5ShellLifecycle({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipeConnection(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runConnectionLifecycle',
    (await DagpipeCore.runConnectionLifecycle({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipeBufferManagement(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runBufferManagement',
    (await DagpipeCore.runBufferManagement({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipeBufferRender(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runBufferRender',
    (await DagpipeCore.runBufferRender({ inputJson: JSON.stringify(input) })).json,
  );
}

export async function runDagpipeInputDispatch(input: Record<string, unknown>): Promise<DagpipeResult> {
  return parseResult(
    'runInputDispatch',
    (await DagpipeCore.runInputDispatch({ inputJson: JSON.stringify(input) })).json,
  );
}

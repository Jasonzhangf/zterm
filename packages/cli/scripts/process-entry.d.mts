export interface ProcessInvocation {
  command: string;
  args: string[];
}

export interface NpmInvocationOptions {
  npmCommand?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
}

export function resolveNodeScriptInvocation(
  scriptPath: string,
  args: string[],
  execPath?: string,
): ProcessInvocation;

export function resolveNpmInvocation(
  args: string[],
  options?: NpmInvocationOptions,
): ProcessInvocation;

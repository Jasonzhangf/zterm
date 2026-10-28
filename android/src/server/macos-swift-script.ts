import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SWIFT_SCRIPT_COMPILE_TIMEOUT_MS = 120_000;

export interface MacosSwiftScriptCommand {
  command: string;
  args: string[];
}

export interface MacosSwiftScriptOptions {
  /** Interpreter or compiler path used when the script has no cached binary. */
  swiftBinary: string;
  source: string;
  swiftVersion?: string;
  timeoutMs?: number;
}

function cacheRoot(): string {
  return process.env.ZTERM_SWIFT_SCRIPT_CACHE_DIR || join(homedir(), '.zterm', 'cache', 'swift-scripts');
}

/** The compiled binary is named after its source, so a source edit is a new key. */
export function swiftScriptCacheKey(source: string, swiftVersion: string): string {
  return createHash('sha256').update(`${swiftVersion}\n${source}`).digest('hex').slice(0, 32);
}

export function swiftScriptCachePath(source: string, swiftVersion: string): string {
  return join(cacheRoot(), `zterm-swift-${swiftScriptCacheKey(source, swiftVersion)}`);
}

/**
 * Returns the cached command without touching the compiler. The daemon starts
 * long-lived helpers synchronously, so the hot path must not await a build.
 */
export function resolveCachedSwiftScript(source: string, swiftVersion: string): MacosSwiftScriptCommand | null {
  const binaryPath = swiftScriptCachePath(source, swiftVersion);
  if (!existsSync(binaryPath)) {
    return null;
  }
  return { command: binaryPath, args: [] };
}

function interpreterCommand(swiftBinary: string, source: string, swiftVersion: string): MacosSwiftScriptCommand {
  return { command: swiftBinary, args: ['-swift-version', swiftVersion, '-e', source] };
}

/**
 * macOS side effects run as inline Swift programs. Interpreting them per run
 * makes the daemon pay a full compiler pass on every call, and the app window
 * catalog refreshes every few seconds, so the machine stays saturated in
 * swift-frontend and starves the input helper of CPU. Compiling each source
 * once into the cache keeps the refresh cadence without the compiler churn;
 * when no compiler is available the interpreter command is used unchanged.
 */
export async function prepareSwiftScript(options: MacosSwiftScriptOptions): Promise<MacosSwiftScriptCommand> {
  const swiftVersion = options.swiftVersion || '5';
  const cached = resolveCachedSwiftScript(options.source, swiftVersion);
  if (cached) {
    return cached;
  }
  const stagingDir = mkdtempSync(join(tmpdir(), 'zterm-swift-'));
  try {
    mkdirSync(cacheRoot(), { recursive: true });
    const sourcePath = join(stagingDir, 'script.swift');
    const binaryPath = join(stagingDir, 'script');
    writeFileSync(sourcePath, options.source);
    await execFileAsync(`${options.swiftBinary}c`, ['-swift-version', swiftVersion, '-O', '-o', binaryPath, sourcePath], {
      timeout: options.timeoutMs || SWIFT_SCRIPT_COMPILE_TIMEOUT_MS,
    });
    chmodSync(binaryPath, 0o755);
    const target = swiftScriptCachePath(options.source, swiftVersion);
    try {
      renameSync(binaryPath, target);
    } catch {
      // A concurrent compile may have published the same key first; the cache is
      // content addressed, so either copy is the same program.
      rmSync(binaryPath, { force: true });
      if (!existsSync(target)) {
        throw new Error(`swift script cache publish failed: ${target}`);
      }
    }
    return { command: target, args: [] };
  } catch {
    return interpreterCommand(options.swiftBinary, options.source, swiftVersion);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
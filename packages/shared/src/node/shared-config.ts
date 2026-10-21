import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type JsonObject = Record<string, unknown>;

export interface ConfigSnapshot {
  path: string;
  found: boolean;
  config: JsonObject;
}

export interface ConfigMutation<T> {
  value: T;
  changed: boolean;
}

export type ConfigStoreErrorCode =
  | 'invalid_json'
  | 'invalid_config'
  | 'config_busy'
  | 'config_aborted'
  | 'config_read_failed'
  | 'config_write_failed';

export class ConfigStoreError extends Error {
  readonly code: ConfigStoreErrorCode;
  readonly path: string;
  readonly lockPath?: string;

  constructor(
    code: ConfigStoreErrorCode,
    message: string,
    path: string,
    options?: { lockPath?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ConfigStoreError';
    this.code = code;
    this.path = path;
    this.lockPath = options?.lockPath;
  }
}

export interface SharedConfigStoreOptions {
  homeDir?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function positiveDuration(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined, path: string, lockPath: string) {
  if (signal?.aborted) {
    return Promise.reject(
      new ConfigStoreError('config_aborted', `Config transaction aborted: ${path}`, path, { lockPath }),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new ConfigStoreError('config_aborted', `Config transaction aborted: ${path}`, path, { lockPath }),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function getSharedConfigPath(homeDir: string = homedir()) {
  return join(homeDir, '.zterm', 'config.json');
}

export class SharedConfigStore {
  readonly path: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(options: SharedConfigStoreOptions = {}) {
    this.path = getSharedConfigPath(options.homeDir);
    this.lockPath = `${this.path}.lock`;
    this.lockTimeoutMs = positiveDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.lockRetryMs = Math.max(1, positiveDuration(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS));
  }

  async read(): Promise<ConfigSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { path: this.path, found: false, config: {} };
      }
      throw new ConfigStoreError(
        'config_read_failed',
        `Unable to read config: ${this.path}`,
        this.path,
        { cause: error },
      );
    }

    if (!raw.trim()) {
      throw new ConfigStoreError(
        'invalid_json',
        `Config is empty: ${this.path}`,
        this.path,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ConfigStoreError(
        'invalid_json',
        `Config contains invalid JSON: ${this.path}`,
        this.path,
        { cause: error },
      );
    }
    if (!isJsonObject(parsed)) {
      throw new ConfigStoreError(
        'invalid_config',
        `Config root must be a JSON object: ${this.path}`,
        this.path,
      );
    }
    return { path: this.path, found: true, config: parsed };
  }

  async update<T>(
    mutate: (latest: JsonObject) => ConfigMutation<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await this.acquireLock(signal);
    let temporaryPath: string | undefined;

    try {
      const snapshot = await this.read();
      const mutation = mutate(snapshot.config);
      if (!mutation || typeof mutation.changed !== 'boolean') {
        throw new ConfigStoreError(
          'invalid_config',
          'Config mutation did not return { value, changed }: ' + this.path,
          this.path,
        );
      }
      if (!mutation.changed) {
        return mutation.value;
      }

      signal?.throwIfAborted();
      const body = `${JSON.stringify(snapshot.config, null, 2)}\n`;
      temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      temporaryPath = undefined;
      return mutation.value;
    } catch (error) {
      if (error instanceof ConfigStoreError) {
        throw error;
      }
      if (signal?.aborted) {
        throw new ConfigStoreError(
          'config_aborted',
          `Config transaction aborted: ${this.path}`,
          this.path,
          { lockPath: this.lockPath, cause: error },
        );
      }
      throw new ConfigStoreError(
        'config_write_failed',
        `Unable to commit config: ${this.path}`,
        this.path,
        { lockPath: this.lockPath, cause: error },
      );
    } finally {
      if (temporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      await this.releaseLock(lock);
    }
  }

  private async acquireLock(signal: AbortSignal | undefined) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      signal?.throwIfAborted();
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(
            `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`,
            'utf8',
          );
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await rm(this.lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        return handle;
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          if (signal?.aborted) {
            throw new ConfigStoreError(
              'config_aborted',
              `Config transaction aborted: ${this.path}`,
              this.path,
              { lockPath: this.lockPath, cause: error },
            );
          }
          throw new ConfigStoreError(
            'config_write_failed',
            `Unable to acquire config lock: ${this.lockPath}`,
            this.path,
            { lockPath: this.lockPath, cause: error },
          );
        }
        if (Date.now() >= deadline) {
          throw new ConfigStoreError(
            'config_busy',
            `Config lock is held: ${this.lockPath}; stop the owning process or remove a confirmed stale lock`,
            this.path,
            { lockPath: this.lockPath },
          );
        }
        await waitForRetry(this.lockRetryMs, signal, this.path, this.lockPath);
      }
    }
  }

  private async releaseLock(handle: Awaited<ReturnType<typeof open>>) {
    await handle.close().catch(() => undefined);
    await rm(this.lockPath, { force: true }).catch(() => undefined);
  }
}

export type TerminalLifecycleMode =
  | 'raw'
  | 'alternate-screen'
  | 'cursor'
  | 'color'
  | 'bracketed-paste';

export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export type TerminalCleanupCause =
  | { kind: 'normal' }
  | { kind: 'initialization-failed'; error: unknown }
  | { kind: 'network-error'; error?: unknown }
  | { kind: 'input-failure'; error?: unknown }
  | { kind: 'signal'; signal: TerminalSignal }
  | { kind: 'epipe'; error?: unknown };

export interface TerminalLifecycleTty {
  isRaw: boolean;
  setRawMode(value: boolean): void;
}

export interface TerminalLifecycleOutput {
  write(data: string): boolean;
}

export interface TerminalLifecycleHooks {
  stopInput?(): void | Promise<void>;
  settleInput?(cause: TerminalCleanupCause): void | Promise<void>;
  releaseConnection?(cause: TerminalCleanupCause): void | Promise<void>;
  restoreProjection?(cause: TerminalCleanupCause): void | Promise<void>;
}

export interface TerminalLifecycleOptions {
  tty: TerminalLifecycleTty;
  output: TerminalLifecycleOutput;
  hooks?: TerminalLifecycleHooks;
}

export interface TerminalSavedState {
  rawMode: boolean;
  changedModes: readonly TerminalLifecycleMode[];
}

export interface TerminalLifecycleError {
  stage: string;
  message: string;
  cause: unknown;
}

export interface TerminalCleanupResult {
  kind: 'ok' | 'failed';
  cause: TerminalCleanupCause;
  saved: TerminalSavedState | null;
  cleanupErrors: readonly TerminalLifecycleError[];
  alreadyCleaned: boolean;
}

export type TerminalLifecycleStartResult =
  | {
      kind: 'ok';
      saved: TerminalSavedState;
    }
  | {
      kind: 'failed';
      stage: 'initialization';
      error: TerminalLifecycleError;
      cleanup: TerminalCleanupResult;
    };

export interface TerminalLifecycle {
  start(): Promise<TerminalLifecycleStartResult>;
  cleanup(cause?: TerminalCleanupCause): Promise<TerminalCleanupResult>;
  handleSignal(signal: TerminalSignal): Promise<TerminalCleanupResult>;
  handleOutputError(error: unknown): Promise<TerminalCleanupResult>;
}

const ENTER_INTERACTIVE_SEQUENCE = [
  '\x1b[?1049h',
  '\x1b[H',
  '\x1b[?25h',
  '\x1b[0m',
  '\x1b[?2004h',
].join('');

function operationError(stage: string, cause: unknown): TerminalLifecycleError {
  return {
    stage,
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function publicCause(cause: TerminalCleanupCause) {
  return { ...cause };
}

function hasEpipeCode(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'EPIPE',
  );
}

export function createTerminalLifecycle(
  options: TerminalLifecycleOptions,
): TerminalLifecycle {
  let saved: TerminalSavedState | null = null;
  let startPromise: Promise<TerminalLifecycleStartResult> | null = null;
  let cleanupPromise: Promise<TerminalCleanupResult> | null = null;
  let cleanupResult: TerminalCleanupResult | null = null;

  async function performCleanup(cause: TerminalCleanupCause): Promise<TerminalCleanupResult> {
    const cleanupErrors: TerminalLifecycleError[] = [];
    const hooks = options.hooks || {};

    async function runHook(stage: string, action: (() => void | Promise<void>) | undefined) {
      if (!action) return;
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(operationError(stage, error));
      }
    }

    await runHook('stop-input', hooks.stopInput);
    await runHook('settle-input', hooks.settleInput ? () => hooks.settleInput?.(cause) : undefined);
    await runHook(
      'release-connection',
      hooks.releaseConnection ? () => hooks.releaseConnection?.(cause) : undefined,
    );
    await runHook(
      'restore-projection',
      hooks.restoreProjection ? () => hooks.restoreProjection?.(cause) : undefined,
    );

    const changedModes = new Set(saved?.changedModes || []);
    const restoreParts: string[] = [];
    if (changedModes.has('color')) {
      restoreParts.push('\x1b[0m');
    }
    if (changedModes.has('bracketed-paste')) {
      restoreParts.push('\x1b[?2004l');
    }
    if (changedModes.has('cursor')) {
      restoreParts.push('\x1b[?25h');
    }
    if (changedModes.has('alternate-screen')) {
      restoreParts.push('\x1b[?1049l');
    }

    if (restoreParts.length > 0) {
      try {
        options.output.write(restoreParts.join(''));
      } catch (error) {
        cleanupErrors.push(operationError('terminal-restore', error));
      }
    }

    if (changedModes.has('raw') && saved) {
      try {
        options.tty.setRawMode(saved.rawMode);
      } catch (error) {
        cleanupErrors.push(operationError('raw-mode-restore', error));
      }
    }

    return {
      kind: cleanupErrors.length === 0 ? 'ok' : 'failed',
      cause: publicCause(cause),
      saved: saved
        ? {
            rawMode: saved.rawMode,
            changedModes: [...saved.changedModes],
          }
        : null,
      cleanupErrors,
      alreadyCleaned: false,
    };
  }

  function cleanup(cause: TerminalCleanupCause = { kind: 'normal' }) {
    if (cleanupPromise) {
      return cleanupPromise.then((result) => ({
        ...result,
        alreadyCleaned: true,
      }));
    }

    cleanupPromise = performCleanup(cause).then((result) => {
      cleanupResult = result;
      return result;
    });
    return cleanupPromise;
  }

  async function start(): Promise<TerminalLifecycleStartResult> {
    if (startPromise) return startPromise;

    startPromise = (async () => {
      if (cleanupResult) {
        const error = operationError('initialization', new Error('terminal lifecycle is closed'));
        return {
          kind: 'failed' as const,
          stage: 'initialization' as const,
          error,
          cleanup: {
            ...cleanupResult,
            alreadyCleaned: true,
          },
        };
      }

      let initialRawMode = false;
      const changedModes: TerminalLifecycleMode[] = [];

      try {
        initialRawMode = options.tty.isRaw;
        options.tty.setRawMode(true);
        if (!initialRawMode) changedModes.push('raw');

        changedModes.push(
          'alternate-screen',
          'cursor',
          'color',
          'bracketed-paste',
        );
        saved = {
          rawMode: initialRawMode,
          changedModes: [...changedModes],
        };
        options.output.write(ENTER_INTERACTIVE_SEQUENCE);
        return {
          kind: 'ok' as const,
          saved: {
            rawMode: initialRawMode,
            changedModes: [...changedModes],
          },
        };
      } catch (error) {
        saved = {
          rawMode: initialRawMode,
          changedModes: [...changedModes],
        };
        const initializationError = operationError('initialization', error);
        const cleanupOutcome = await cleanup({
          kind: 'initialization-failed',
          error,
        });
        return {
          kind: 'failed' as const,
          stage: 'initialization' as const,
          error: initializationError,
          cleanup: cleanupOutcome,
        };
      }
    })();

    return startPromise;
  }

  return {
    start,
    cleanup,
    handleSignal(signal) {
      return cleanup({ kind: 'signal', signal });
    },
    handleOutputError(error) {
      if (!hasEpipeCode(error)) {
        throw error;
      }
      return cleanup({ kind: 'epipe', error });
    },
  };
}

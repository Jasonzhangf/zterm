import type {
  RemoteWindowCloseStatus,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '@zterm/shared/protocol';
import {
  cloneRemoteWindowTargetCatalogResponse,
  cloneRemoteWindowTargetCatalogResult,
} from './remote-window-stream-daemon-helpers';
import {
  buildMacosAppWindowTargets,
  buildRemoteWindowStreamTargets,
  parseIterm2Catalog,
  parseMacosAppWindowCatalog,
  parseTmuxClientTargets,
  type Iterm2RawCatalog,
  type MacosAppWindowCatalog,
  type TmuxClientTarget,
} from './remote-window-catalog';
import { ITERM2_CATALOG_PYTHON, MACOS_APP_WINDOW_CATALOG_SWIFT } from './remote-window-scripts';
import { remoteWindowError, summarizeRemoteWindowCatalogError } from './remote-window-support';

interface RemoteWindowTargetCatalogCacheEntry {
  response: RemoteWindowStreamTargetsResponsePayload;
}

const DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_REFRESH_INTERVAL_MS = 5_000;

export interface RemoteWindowCatalogRuntimeDeps {
  platform: NodeJS.Platform;
  pythonBinary: string;
  swiftBinary: string;
  iterm2PythonTimeoutMs: number;
  appWindowCatalogTimeoutMs: number;
  /** Daemon-owned self-refresh cadence for the resident catalog snapshot. */
  targetCatalogRefreshIntervalMs?: number;
  now: () => string;
  nowMs: () => number;
  runIterm2Python: (script: string, options: { pythonBinary: string; timeoutMs: number }) => Promise<string>;
  runMacosAppWindowCatalog: (script: string, options: { swiftBinary: string; timeoutMs: number }) => Promise<string>;
  runTmux: (args: string[]) => { ok: true; stdout: string };
}

export interface RemoteWindowCatalogRuntime {
  listTargets: (
    payload: RemoteWindowStreamRequestPayload,
  ) => Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload>;
  warm: () => void;
  listAppWindowTargets: () => Promise<RemoteWindowStreamTargetManifest[]>;
  /**
   * Internal destructive-close observation. It consumes the existing
   * self-refresh loop; it never starts a second scan or snapshot.
   */
  awaitAppWindowCloseObservation: (
    request: RemoteWindowAppWindowCloseObservationRequest,
  ) => Promise<RemoteWindowAppWindowCloseObservationResult>;
  dispose: () => void;
}

export interface RemoteWindowAppWindowCloseObservationRequest {
  windowId: string;
  pid?: number;
  /**
   * Marker of the close-injection completion. Only an app-window enumeration
   * that actually STARTED after this marker may settle the waiter.
   */
  injectedAtMs: number;
}

export interface RemoteWindowAppWindowCloseObservationResult {
  status: Extract<RemoteWindowCloseStatus, 'closed' | 'not_closed' | 'unverified' | 'failed'>;
  error?: string;
}

interface RemoteWindowAppWindowRefreshObservation {
  startedAtMs: number;
  ok: boolean;
  /**
   * Canonical app-window identities observed by the app-window enumeration,
   * keyed by `pid:windowId` to match the stream's canonical app-window target.
   */
  windowKeys: Set<string>;
  errorMessage?: string;
}

const appWindowIdentityKey = (pid: number | undefined, windowId: string): string => (
  `${typeof pid === 'number' ? pid : ''}:${windowId}`
);

interface RemoteWindowAppWindowCloseWaiter {
  request: RemoteWindowAppWindowCloseObservationRequest;
  deadlineTimer: ReturnType<typeof setTimeout>;
  settle: (result: RemoteWindowAppWindowCloseObservationResult) => void;
}

export function createRemoteWindowCatalogRuntime(
  deps: RemoteWindowCatalogRuntimeDeps,
): RemoteWindowCatalogRuntime {
  // The daemon owns one canonical full catalog snapshot; source-set selection is a read-time projection.
  let snapshot: RemoteWindowTargetCatalogCacheEntry | null = null;
  let refreshFailure: RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload | null = null;
  let hasSuccessfulSnapshot = false;
  let refresh: Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let generation = 0;
  const closeWaiters = new Set<RemoteWindowAppWindowCloseWaiter>();
  const refreshIntervalMs = Math.max(
    1_000,
    Math.floor(deps.targetCatalogRefreshIntervalMs ?? DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_REFRESH_INTERVAL_MS),
  );
  const closeObservationDeadlineMs = refreshIntervalMs + deps.appWindowCatalogTimeoutMs;

  const settleAppWindowCloseWaiters = (observation: RemoteWindowAppWindowRefreshObservation) => {
    for (const waiter of Array.from(closeWaiters)) {
      if (observation.startedAtMs <= waiter.request.injectedAtMs) {
        continue;
      }
      clearTimeout(waiter.deadlineTimer);
      closeWaiters.delete(waiter);
      if (!observation.ok) {
        waiter.settle({
          status: 'failed',
          error: observation.errorMessage ?? 'app window catalog refresh failed after close injection',
        });
        continue;
      }
      waiter.settle(observation.windowKeys.has(appWindowIdentityKey(waiter.request.pid, waiter.request.windowId))
        ? { status: 'not_closed' }
        : { status: 'closed' });
    }
  };

  const rejectAppWindowCloseWaiters = (error: string) => {
    for (const waiter of Array.from(closeWaiters)) {
      clearTimeout(waiter.deadlineTimer);
      closeWaiters.delete(waiter);
      waiter.settle({ status: 'failed', error });
    }
  };

  const buildFullCatalogPayload = (requestId: string): RemoteWindowStreamRequestPayload => ({
    requestId,
    includeAppWindows: true,
    includeIterm2: true,
  });

  // Error codes owned by a source that the request explicitly excluded. A read
  // must never surface the failure of a source it did not ask for.
  const excludedSourceErrorCodes = (payload: RemoteWindowStreamRequestPayload): Set<string> => {
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    return new Set<string>([
      ...(includeAppWindows ? [] : ['app_window_catalog_unavailable']),
      ...(includeIterm2
        ? []
        : [
            'iterm2_api_unavailable',
            'tmux_client_catalog_unavailable',
            'iterm2_capture_window_unavailable',
            'remote_window_pane_geometry_invalid',
          ]),
    ]);
  };

  const projectSnapshot = (
    response: RemoteWindowStreamTargetsResponsePayload,
    payload: RemoteWindowStreamRequestPayload,
  ): RemoteWindowStreamTargetsResponsePayload => {
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    if (includeAppWindows && includeIterm2) {
      return cloneRemoteWindowTargetCatalogResponse(response, payload.requestId);
    }
    const excludedCodes = excludedSourceErrorCodes(payload);
    const errors = (response.errors ?? [])
      .filter((error) => !excludedCodes.has(error.code))
      .map((error) => ({ ...error, requestId: payload.requestId }));
    return {
      requestId: payload.requestId,
      targets: response.targets.filter((target) => (
        target.videoTarget.kind === 'app-window' ? includeAppWindows : includeIterm2
      )),
      ...(errors.length > 0 ? { errors } : {}),
    };
  };

  const queryIterm2Catalog = async () => parseIterm2Catalog(await deps.runIterm2Python(
    ITERM2_CATALOG_PYTHON,
    { pythonBinary: deps.pythonBinary, timeoutMs: deps.iterm2PythonTimeoutMs },
  ));
  const queryMacosAppWindowCatalog = async () => parseMacosAppWindowCatalog(
    await deps.runMacosAppWindowCatalog(
      MACOS_APP_WINDOW_CATALOG_SWIFT,
      { swiftBinary: deps.swiftBinary, timeoutMs: deps.appWindowCatalogTimeoutMs },
    ),
  );

  const listTargetsLive = async (
    payload: RemoteWindowStreamRequestPayload,
    onAppWindowSource?: (outcome: {
      startedAtMs: number;
      ok: boolean;
      windowKeys: Set<string>;
      errorMessage?: string;
    }) => void,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> => {
    const createdAt = deps.now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets: RemoteWindowStreamTargetManifest[] = [];
    const errors: RemoteWindowStreamErrorPayload[] = [];

    let macosAppWindowCatalogOk = false;
    let macosAppWindowCatalog: MacosAppWindowCatalog | null = null;
    let appWindowStartedAtMs = 0;
    let appWindowWindowKeys = new Set<string>();
    let appWindowErrorMessage: string | undefined;
    if (includeAppWindows) {
      try {
        appWindowStartedAtMs = deps.nowMs();
        macosAppWindowCatalog = await queryMacosAppWindowCatalog();
        const appWindowTargets = buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt);
        targets.push(...appWindowTargets);
        appWindowWindowKeys = new Set(appWindowTargets.map((item) => (
          appWindowIdentityKey(item.videoTarget.pid, item.videoTarget.windowId)
        )));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
        appWindowErrorMessage = message || 'macOS app window catalog unavailable';
        errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
      }
    }

    let catalog: Iterm2RawCatalog | null = null;
    if (includeIterm2) {
      try {
        catalog = await queryIterm2Catalog();
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'iTerm2 Python API unavailable');
        errors.push(remoteWindowError(payload, 'iterm2_api_unavailable', message || 'iTerm2 Python API unavailable'));
      }
    }

    let tmuxTargets = new Map<string, TmuxClientTarget>();
    if (catalog) {
      if (!macosAppWindowCatalogOk) {
        try {
          appWindowStartedAtMs = deps.nowMs();
          macosAppWindowCatalog = await queryMacosAppWindowCatalog();
          const appWindowTargets = buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt);
          appWindowWindowKeys = new Set(appWindowTargets.map((item) => (
            appWindowIdentityKey(item.videoTarget.pid, item.videoTarget.windowId)
          )));
          macosAppWindowCatalogOk = true;
          appWindowErrorMessage = undefined;
        } catch (error) {
          const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
          appWindowErrorMessage = message || 'macOS app window catalog unavailable';
          errors.push(remoteWindowError(payload, 'app_window_catalog_unavailable', message || 'macOS app window catalog unavailable'));
        }
      }
      try {
        tmuxTargets = parseTmuxClientTargets(deps.runTmux([
          'list-clients',
          '-F',
          '#{client_tty}\t#{session_name}\t#{window_id}\t#{pane_id}',
        ]).stdout);
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'tmux client catalog unavailable');
        errors.push(remoteWindowError(payload, 'tmux_client_catalog_unavailable', message || 'tmux client catalog unavailable'));
      }
    }

    if (catalog) {
      try {
        const iterm2Build = buildRemoteWindowStreamTargets(catalog, tmuxTargets, createdAt, {
          includeAppWindowTargets: false,
          macosAppWindowCatalog,
          requireCaptureWindowForPanes: true,
        });
        targets.push(...iterm2Build.targets);
        for (const degradation of iterm2Build.degradations) {
          errors.push(remoteWindowError(payload, degradation.code, degradation.message));
        }
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'remote window target manifest invalid');
        errors.push(remoteWindowError(payload, 'remote_window_manifest_invalid', message || 'remote window target manifest invalid'));
      }
    }

    onAppWindowSource?.({
      startedAtMs: appWindowStartedAtMs || deps.nowMs(),
      ok: macosAppWindowCatalogOk,
      windowKeys: appWindowWindowKeys,
      ...(macosAppWindowCatalogOk ? {} : { errorMessage: appWindowErrorMessage }),
    });

    // Always answer with the structured catalog shape. Collapsing to
    // `errors[0]` would drop every other failure reason and would make one
    // degraded source indistinguishable from a total failure.
    return {
      requestId: payload.requestId,
      targets,
      ...(errors.length > 0 ? { errors } : {}),
    };
  };

  const startRefresh = (requestId: string) => {
    if (disposed || refresh) {
      return refresh;
    }
    const refreshPayload = buildFullCatalogPayload(requestId || `rw-catalog-refresh-${deps.nowMs()}`);
    const startedGeneration = generation;
    const started = listTargetsLive(refreshPayload, (outcome) => {
      settleAppWindowCloseWaiters(outcome);
    })
      .catch((error: unknown) => remoteWindowError(
        refreshPayload,
        'remote_window_catalog_failed',
        error instanceof Error ? error.message : 'remote window catalog failed',
      ))
      .then((result) => {
        if (!disposed && startedGeneration === generation) {
          // A refresh that produced targets is fresh and usable even when one
          // optional source degraded: commit it together with its per-source
          // errors and let the read-time projection filter by the requested
          // source set. Only a refresh that produced no target *and* reported
          // errors invalidates the resident snapshot.
          const hasTargets = 'targets' in result && result.targets.length > 0;
          const hasErrors = 'targets' in result ? Boolean(result.errors?.length) : true;
          if ('targets' in result && (hasTargets || !hasErrors)) {
            snapshot = {
              response: cloneRemoteWindowTargetCatalogResponse(result, result.requestId),
            };
            hasSuccessfulSnapshot = true;
            refreshFailure = null;
          } else {
            snapshot = null;
            refreshFailure = hasSuccessfulSnapshot ? cloneRemoteWindowTargetCatalogResult(result, result.requestId) : null;
          }
        }
        return result;
      })
      .finally(() => {
        if (refresh === started) {
          refresh = null;
        }
      });
    refresh = started;
    return started;
  };

  const startRefreshTimer = () => {
    if (refreshTimer || disposed || deps.platform !== 'darwin') {
      return;
    }
    refreshTimer = setInterval(() => {
      void startRefresh(`rw-catalog-refresh-${deps.nowMs()}`);
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  };

  // Client requests only read the daemon-owned snapshot. The daemon keeps the
  // snapshot warm through its own self-refresh loop, so a request never forces
  // a live enumeration.
  const listTargets = async (
    payload: RemoteWindowStreamRequestPayload,
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> => {
    if (!payload.requestId) {
      return remoteWindowError(payload, 'remote_window_request_invalid', 'remote window target request requires requestId');
    }
    if (deps.platform !== 'darwin') {
      return remoteWindowError(payload, 'remote_window_platform_unsupported', 'remote window stream catalog is only available on macOS daemon hosts');
    }
    if (disposed) {
      return remoteWindowError(
        payload,
        'remote_window_catalog_not_ready',
        'remote window target catalog runtime is disposed',
      );
    }
    const ready = snapshot;
    if (ready) {
      return projectSnapshot(ready.response, payload);
    }
    if (refreshFailure) {
      return 'targets' in refreshFailure
        ? projectSnapshot(refreshFailure, payload)
        : excludedSourceErrorCodes(payload).has(refreshFailure.code)
          ? remoteWindowError(payload, 'remote_window_catalog_not_ready', 'remote window target catalog is not ready')
          : { ...refreshFailure, requestId: payload.requestId };
    }
    if (refresh) {
      const pending = await refresh;
      const refreshed = snapshot;
      if ('targets' in pending && refreshed) {
        return projectSnapshot(refreshed.response, payload);
      }
      if (!hasSuccessfulSnapshot) {
        return remoteWindowError(
          payload,
          'remote_window_catalog_not_ready',
          'remote window target catalog is not ready',
        );
      }
      return 'targets' in pending
        ? projectSnapshot(pending, payload)
        : cloneRemoteWindowTargetCatalogResult(pending, payload.requestId);
    }
    return remoteWindowError(
      payload,
      'remote_window_catalog_not_ready',
      'remote window target catalog is not ready',
    );
  };

  const warm = () => {
    if (deps.platform !== 'darwin') {
      return;
    }
    const payload: RemoteWindowStreamRequestPayload = {
      requestId: `rw-catalog-warm-${deps.nowMs()}`,
      includeAppWindows: true,
      includeIterm2: true,
    };
    void startRefresh(payload.requestId);
    startRefreshTimer();
  };

  const listAppWindowTargets = async () => buildMacosAppWindowTargets(
    await queryMacosAppWindowCatalog(),
    deps.now(),
  );

  const awaitAppWindowCloseObservation = (
    request: RemoteWindowAppWindowCloseObservationRequest,
  ): Promise<RemoteWindowAppWindowCloseObservationResult> => {
    if (deps.platform !== 'darwin') {
      return Promise.resolve({ status: 'failed', error: 'remote window close observation is only available on macOS daemon hosts' });
    }
    if (disposed) {
      return Promise.resolve({ status: 'failed', error: 'remote window catalog runtime is disposed' });
    }
    return new Promise((resolve) => {
      let waiter: RemoteWindowAppWindowCloseWaiter;
      const settle = (result: RemoteWindowAppWindowCloseObservationResult) => {
        clearTimeout(waiter.deadlineTimer);
        resolve(result);
      };
      waiter = {
        request,
        settle,
        deadlineTimer: setTimeout(() => {
          closeWaiters.delete(waiter);
          resolve({ status: 'unverified', error: 'no qualifying app window refresh completed before the observation deadline' });
        }, closeObservationDeadlineMs),
      };
      // The existing self-refresh loop reports every app-window enumeration
      // start; a refresh that completed before the injection marker must not
      // settle the waiter, so it stays registered until a later one lands.
      closeWaiters.add(waiter);
    });
  };

  const dispose = () => {
    disposed = true;
    generation += 1;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    rejectAppWindowCloseWaiters('remote window catalog runtime is disposed');
    snapshot = null;
    refreshFailure = null;
    hasSuccessfulSnapshot = false;
    refresh = null;
  };

  return { listTargets, warm, listAppWindowTargets, awaitAppWindowCloseObservation, dispose };
}

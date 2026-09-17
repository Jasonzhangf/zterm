import type {
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

export interface RemoteWindowCatalogRuntimeDeps {
  platform: NodeJS.Platform;
  pythonBinary: string;
  swiftBinary: string;
  iterm2PythonTimeoutMs: number;
  appWindowCatalogTimeoutMs: number;
  targetCatalogCacheTtlMs: number;
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
  dispose: () => void;
}

export function createRemoteWindowCatalogRuntime(
  deps: RemoteWindowCatalogRuntimeDeps,
): RemoteWindowCatalogRuntime {
  // The daemon owns one canonical full catalog snapshot; source-set selection is a read-time projection.
  let snapshot: RemoteWindowTargetCatalogCacheEntry | null = null;
  let refresh: Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let generation = 0;

  const buildFullCatalogPayload = (requestId: string): RemoteWindowStreamRequestPayload => ({
    requestId,
    includeAppWindows: true,
    includeIterm2: true,
  });

  const projectSnapshot = (
    response: RemoteWindowStreamTargetsResponsePayload,
    payload: RemoteWindowStreamRequestPayload,
  ): RemoteWindowStreamTargetsResponsePayload => {
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    if (includeAppWindows && includeIterm2) {
      return cloneRemoteWindowTargetCatalogResponse(response, payload.requestId);
    }
    const excludedCodes = new Set<string>([
      ...(includeAppWindows ? [] : ['app_window_catalog_unavailable']),
      ...(includeIterm2 ? [] : ['iterm2_api_unavailable', 'tmux_client_catalog_unavailable']),
    ]);
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
  ): Promise<RemoteWindowStreamTargetsResponsePayload | RemoteWindowStreamErrorPayload> => {
    const createdAt = deps.now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets: RemoteWindowStreamTargetManifest[] = [];
    const errors: RemoteWindowStreamErrorPayload[] = [];

    let macosAppWindowCatalogOk = false;
    let macosAppWindowCatalog: MacosAppWindowCatalog | null = null;
    if (includeAppWindows) {
      try {
        macosAppWindowCatalog = await queryMacosAppWindowCatalog();
        targets.push(...buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
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
          macosAppWindowCatalog = await queryMacosAppWindowCatalog();
          macosAppWindowCatalogOk = true;
        } catch (error) {
          const message = summarizeRemoteWindowCatalogError(error, 'macOS app window catalog unavailable');
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
        targets.push(...buildRemoteWindowStreamTargets(catalog, tmuxTargets, createdAt, {
          includeAppWindowTargets: false,
          macosAppWindowCatalog,
          requireCaptureWindowForPanes: true,
        }));
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, 'remote window target manifest invalid');
        errors.push(remoteWindowError(payload, 'remote_window_manifest_invalid', message || 'remote window target manifest invalid'));
      }
    }

    if (targets.length > 0) {
      return {
        requestId: payload.requestId,
        targets,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }
    return errors[0] || { requestId: payload.requestId, targets: [] };
  };

  const startRefresh = (requestId: string) => {
    if (disposed || refresh) {
      return refresh;
    }
    const refreshPayload = buildFullCatalogPayload(requestId || `rw-catalog-refresh-${deps.nowMs()}`);
    const startedGeneration = generation;
    const started = listTargetsLive(refreshPayload)
      .catch((error: unknown) => remoteWindowError(
        refreshPayload,
        'remote_window_catalog_failed',
        error instanceof Error ? error.message : 'remote window catalog failed',
      ))
      .then((result) => {
        if (!disposed && startedGeneration === generation && 'targets' in result) {
          snapshot = {
            response: cloneRemoteWindowTargetCatalogResponse(result, result.requestId),
          };
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
    if (refreshTimer || deps.platform !== 'darwin' || deps.targetCatalogCacheTtlMs <= 0) {
      return;
    }
    refreshTimer = setInterval(() => {
      void startRefresh(`rw-catalog-refresh-${deps.nowMs()}`);
    }, deps.targetCatalogCacheTtlMs);
    refreshTimer.unref?.();
  };

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
    if (refresh) {
      const pending = await refresh;
      const refreshed = snapshot;
      if ('targets' in pending && refreshed) {
        return projectSnapshot(refreshed.response, payload);
      }
      return cloneRemoteWindowTargetCatalogResult(pending, payload.requestId);
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

  const dispose = () => {
    disposed = true;
    generation += 1;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    snapshot = null;
    refresh = null;
  };

  return { listTargets, warm, listAppWindowTargets, dispose };
}

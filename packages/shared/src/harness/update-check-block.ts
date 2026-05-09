/**
 * update-check-block.ts — Update-check domain block (first production contract slice)
 *
 * 唯一职责：处理 update/check 和 update/apply operations，
 * 产出对应的 events 和 app-update projection。
 *
 * 纯函数 block，通过 BlockContext 读写 projection 和 emit event，
 * 不依赖任何平台 API（fetch/storage 由 harness 注入的 mock 提供）。
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';
import {
  type AppUpdateProjectionPreferences,
  type AppUpdateProjectionManifest,
  type AppUpdateProjectionInput,
} from '../interaction/projection';

export const UPDATE_CHECK_PROJECTION_KEY = 'app-update' as const;

export interface UpdateCheckBlockDeps {
  /** Fetch latest manifest JSON from a URL */
  fetchManifest: (url: string) => Promise<AppUpdateProjectionManifest>;
  /** Current time in ms */
  now: () => number;
  /** Runtime version code */
  runtimeVersionCode: number;
  /** Default preferences */
  defaultPreferences: AppUpdateProjectionPreferences;
}

function getStoredPreferences(ctx: BlockContext): AppUpdateProjectionPreferences {
  const proj = ctx.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
  return proj?.preferences ?? defaultPrefs();
}

function setProjection(ctx: BlockContext, input: AppUpdateProjectionInput) {
  ctx.setProjection(UPDATE_CHECK_PROJECTION_KEY, input);
}

function defaultPrefs(): AppUpdateProjectionPreferences {
  return {
    manifestUrl: '',
    autoCheckOnLaunch: true,
    ignoreUntilManualCheck: false,
  };
}

export function createUpdateCheckBlock(deps: UpdateCheckBlockDeps): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['update/check', 'update/apply'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    const events: TerminalEvent[] = [];

    if (op.type === 'update/check') {
      const prefs = getStoredPreferences(ctx);

      // Set checking state
      const current = ctx.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);
      setProjection(ctx, {
        preferences: prefs,
        latestManifest: current?.latestManifest ?? null,
        availableManifest: current?.availableManifest ?? null,
        checking: true,
        installing: current?.installing ?? false,
        lastError: null,
        updateStage: 'checking-manifest',
        runtimeVersionCode: deps.runtimeVersionCode,
      });

      // In production, this is async via orchestration; in harness, we invoke synchronously
      // The harness user should mock fetchManifest if needed.
      // For harness tests, we expose a sync path via the projection store.

      return events;
    }

    if (op.type === 'update/apply') {
      const prefs = getStoredPreferences(ctx);
      const current = ctx.getProjection<AppUpdateProjectionInput>(UPDATE_CHECK_PROJECTION_KEY);

      if (!current?.availableManifest) {
        events.push(createEvent('operation/failed', {
          operationType: 'update/apply',
          error: 'No available manifest to apply',
        }));
        return events;
      }

      setProjection(ctx, {
        preferences: prefs,
        latestManifest: current.latestManifest,
        availableManifest: current.availableManifest,
        checking: false,
        installing: true,
        lastError: null,
        updateStage: 'downloading-and-installing',
        runtimeVersionCode: deps.runtimeVersionCode,
      });

      events.push(createEvent('app/update-applied', {}));

      return events;
    }

    return events;
  };

  return { opTypes, handler };
}

/** Sync helper: directly feed a fetched manifest into the projection,
 *  simulating what the orchestration layer would do after fetchManifest resolves. */
export function applyManifestToProjection(
  ctx: BlockContext,
  manifest: AppUpdateProjectionManifest | null,
  error: string | null,
  deps: UpdateCheckBlockDeps,
  prefs?: AppUpdateProjectionPreferences,
) {
  const currentPrefs = prefs ?? getStoredPreferences(ctx);

  const hasNewVersion = manifest !== null && manifest.versionCode > deps.runtimeVersionCode;

  setProjection(ctx, {
    preferences: {
      ...currentPrefs,
      lastCheckedAt: deps.now(),
      lastSeenVersionCode: manifest?.versionCode ?? currentPrefs.lastSeenVersionCode,
    },
    latestManifest: manifest,
    availableManifest: hasNewVersion ? manifest : null,
    checking: false,
    installing: false,
    lastError: error,
    updateStage: error ? 'failed' : 'idle',
    runtimeVersionCode: deps.runtimeVersionCode,
  });
}


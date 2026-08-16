import { runtimeDebug } from './runtime-debug';
import {
  createForegroundResumeState as createSharedForegroundState,
  markHidden as markHiddenPure,
} from '@zterm/shared/terminal/foreground-resume';

export interface ForegroundRefreshRuntime {
  wasHidden: boolean;
  lastResumeAt: number;
}

export function createForegroundRefreshRuntime(): ForegroundRefreshRuntime {
  return createSharedForegroundState();
}

export function markForegroundRuntimeHidden(runtime: ForegroundRefreshRuntime, visibilityState?: string) {
  const updated = markHiddenPure(runtime);
  runtime.wasHidden = updated.wasHidden;
  runtimeDebug('app.visibility.hidden', {
    visibilityState: visibilityState || null,
  });
}


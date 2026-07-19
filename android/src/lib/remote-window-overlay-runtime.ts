import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from './types';

export type RemoteWindowOverlayMode = 'floating' | 'fullscreen';

export type RemoteWindowOverlayState =
  | { phase: 'closed'; requestEpoch: number }
  | { phase: 'targetEnumerating'; requestEpoch: number; errorMessage?: string | null }
  | {
      phase: 'pickerOpen';
      requestEpoch: number;
      targets: RemoteWindowStreamTargetManifest[];
      errors: RemoteWindowStreamErrorPayload[];
      errorMessage?: string | null;
    }
  | {
      phase: 'targetLocked';
      requestEpoch: number;
      target: RemoteWindowStreamTargetManifest;
      mode: RemoteWindowOverlayMode;
      streamStarted: false;
      errors: RemoteWindowStreamErrorPayload[];
    };

export const initialRemoteWindowOverlayState: RemoteWindowOverlayState = {
  phase: 'closed',
  requestEpoch: 0,
};

function normalizeErrors(
  errors: RemoteWindowStreamErrorPayload[] | undefined,
): RemoteWindowStreamErrorPayload[] {
  return Array.isArray(errors)
    ? errors.filter((error) => error && typeof error.message === 'string')
    : [];
}

export function beginRemoteWindowTargetEnumeration(
  state: RemoteWindowOverlayState,
): { state: RemoteWindowOverlayState; requestEpoch: number } {
  const requestEpoch = state.requestEpoch + 1;
  return {
    requestEpoch,
    state: {
      phase: 'targetEnumerating',
      requestEpoch,
      errorMessage: null,
    },
  };
}

export function applyRemoteWindowTargetCatalog(
  state: RemoteWindowOverlayState,
  requestEpoch: number,
  payload: RemoteWindowStreamTargetsResponsePayload,
): RemoteWindowOverlayState {
  if (state.requestEpoch !== requestEpoch) {
    return state;
  }
  return {
    phase: 'pickerOpen',
    requestEpoch,
    targets: Array.isArray(payload.targets) ? payload.targets : [],
    errors: normalizeErrors(payload.errors),
    errorMessage: null,
  };
}

export function failRemoteWindowTargetCatalog(
  state: RemoteWindowOverlayState,
  requestEpoch: number,
  error: unknown,
): RemoteWindowOverlayState {
  if (state.requestEpoch !== requestEpoch) {
    return state;
  }
  return {
    phase: 'pickerOpen',
    requestEpoch,
    targets: [],
    errors: [],
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export function selectRemoteWindowTarget(
  state: RemoteWindowOverlayState,
  targetId: string,
): RemoteWindowOverlayState {
  if (state.phase !== 'pickerOpen') {
    return state;
  }
  const target = state.targets.find((item) => item.streamTargetId === targetId) || null;
  if (!target) {
    return {
      ...state,
      errorMessage: 'Selected remote window target is no longer in the catalog',
    };
  }
  return {
    phase: 'targetLocked',
    requestEpoch: state.requestEpoch,
    target,
    mode: 'floating',
    streamStarted: false,
    errors: state.errors,
  };
}

export function enterRemoteWindowFullscreen(state: RemoteWindowOverlayState): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked') {
    return state;
  }
  return {
    ...state,
    mode: 'fullscreen',
  };
}

export function shrinkRemoteWindowOverlay(state: RemoteWindowOverlayState): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked') {
    return state;
  }
  return {
    ...state,
    mode: 'floating',
  };
}

export function closeRemoteWindowOverlay(state: RemoteWindowOverlayState): RemoteWindowOverlayState {
  return {
    phase: 'closed',
    requestEpoch: state.requestEpoch + 1,
  };
}

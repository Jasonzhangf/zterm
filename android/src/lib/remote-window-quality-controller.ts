import type {
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoBitrateConfig,
} from './types';

export type RemoteWindowQualityApplyState =
  | { phase: 'idle'; revision: number }
  | {
      phase: 'requested';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoBitrateConfig;
    }
  | {
      phase: 'applied';
      revision: number;
      qualityKey: string;
      applied: RemoteWindowVideoBitrateConfig;
      result: RemoteWindowStreamQualityResultPayload;
    }
  | {
      phase: 'rejected';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoBitrateConfig;
      message: string;
    };

export function createRemoteWindowQualityApplyState(): RemoteWindowQualityApplyState {
  return { phase: 'idle', revision: 0 };
}

export function beginRemoteWindowQualityRequest(options: {
  state: RemoteWindowQualityApplyState;
  qualityKey: string;
  requested: RemoteWindowVideoBitrateConfig;
}) {
  const revision = options.state.revision + 1;
  return {
    state: {
      phase: 'requested',
      revision,
      qualityKey: options.qualityKey,
      requested: options.requested,
    } as RemoteWindowQualityApplyState,
    revision,
  };
}

export function acceptRemoteWindowQualityResult(
  state: RemoteWindowQualityApplyState,
  result: RemoteWindowStreamQualityResultPayload,
): RemoteWindowQualityApplyState {
  if (
    state.phase !== 'requested'
    || result.status !== 'applied'
    || result.revision !== state.revision
    || !result.appliedVideoBitrate
  ) {
    return state;
  }
  return {
    phase: 'applied',
    revision: state.revision,
    qualityKey: state.qualityKey,
    applied: result.appliedVideoBitrate,
    result,
  };
}

export function rejectRemoteWindowQualityRequest(options: {
  state: RemoteWindowQualityApplyState;
  revision: number;
  message: string;
}): RemoteWindowQualityApplyState {
  if (options.state.phase !== 'requested' || options.state.revision !== options.revision) {
    return options.state;
  }
  return {
    phase: 'rejected',
    revision: options.revision,
    qualityKey: options.state.qualityKey,
    requested: options.state.requested,
    message: options.message,
  };
}

export function hasRemoteWindowQualityKey(
  state: RemoteWindowQualityApplyState,
  qualityKey: string,
) {
  return state.phase !== 'idle' && state.qualityKey === qualityKey;
}

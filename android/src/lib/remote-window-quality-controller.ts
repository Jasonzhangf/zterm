import type {
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoProfile,
} from './types';

export type RemoteWindowQualityApplyState =
  | { phase: 'idle'; revision: number }
  | {
      phase: 'requested';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoProfile;
    }
  | {
      phase: 'applied';
      revision: number;
      qualityKey: string;
      applied: RemoteWindowVideoProfile;
      result: RemoteWindowStreamQualityResultPayload;
    }
  | {
      phase: 'rejected';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoProfile;
      message: string;
    };

export function createRemoteWindowQualityApplyState(): RemoteWindowQualityApplyState {
  return { phase: 'idle', revision: 0 };
}

export function beginRemoteWindowQualityRequest(options: {
  state: RemoteWindowQualityApplyState;
  qualityKey: string;
  requested: RemoteWindowVideoProfile;
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
    || result.revision !== state.revision
  ) {
    return state;
  }
  if (result.status === 'rejected') {
    return {
      phase: 'rejected',
      revision: state.revision,
      qualityKey: state.qualityKey,
      requested: state.requested,
      message: result.error?.message || 'remote window quality request rejected',
    };
  }
  if (!result.appliedVideoProfile) {
    return {
      phase: 'rejected',
      revision: state.revision,
      qualityKey: state.qualityKey,
      requested: state.requested,
      message: 'remote window quality result omitted applied profile',
    };
  }
  return {
    phase: 'applied',
    revision: state.revision,
    qualityKey: state.qualityKey,
    applied: result.appliedVideoProfile,
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
  return (state.phase === 'requested' || state.phase === 'applied')
    && state.qualityKey === qualityKey;
}

import type {
  RemoteWindowStreamGroupBudget,
  RemoteWindowStreamQualityResultPayload,
  RemoteWindowVideoProfile,
} from './types';

export const REMOTE_WINDOW_QUALITY_UNSUPPORTED_CODE =
  'remote_window_stream_quality_unsupported';

export interface RemoteWindowQualityAcknowledged {
  revision: number;
  qualityKey: string;
  profile: RemoteWindowVideoProfile;
  groupBudget: RemoteWindowStreamGroupBudget | null;
}

export type RemoteWindowQualityApplyState =
  | { phase: 'idle'; revision: number; acknowledged: RemoteWindowQualityAcknowledged | null }
  | {
      phase: 'requested';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoProfile;
      acknowledged: RemoteWindowQualityAcknowledged | null;
    }
  | {
      phase: 'applied';
      revision: number;
      qualityKey: string;
      applied: RemoteWindowVideoProfile;
      groupBudget: RemoteWindowStreamGroupBudget | null;
      result: RemoteWindowStreamQualityResultPayload;
      acknowledged: RemoteWindowQualityAcknowledged;
    }
  | {
      phase: 'rejected';
      revision: number;
      qualityKey: string;
      requested: RemoteWindowVideoProfile;
      code: string;
      message: string;
      unsupported: boolean;
      acknowledged: RemoteWindowQualityAcknowledged | null;
    };

export function createRemoteWindowQualityApplyState(): RemoteWindowQualityApplyState {
  return { phase: 'idle', revision: 0, acknowledged: null };
}

function acknowledgedFromResult(
  qualityKey: string,
  result: RemoteWindowStreamQualityResultPayload,
): RemoteWindowQualityAcknowledged | null {
  if (result.status !== 'applied' || !result.appliedVideoProfile) {
    return null;
  }
  return {
    revision: result.revision,
    qualityKey,
    profile: result.appliedVideoProfile,
    groupBudget: result.appliedGroupBudget ?? null,
  };
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
      acknowledged: options.state.acknowledged,
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
    const code = result.error?.code || 'remote_window_stream_quality_rejected';
    return {
      phase: 'rejected',
      revision: state.revision,
      qualityKey: state.qualityKey,
      requested: state.requested,
      code,
      message: result.error?.message || 'remote window quality request rejected',
      unsupported: code === REMOTE_WINDOW_QUALITY_UNSUPPORTED_CODE,
      acknowledged: state.acknowledged,
    };
  }
  const acknowledged = acknowledgedFromResult(state.qualityKey, result);
  if (!acknowledged) {
    return {
      phase: 'rejected',
      revision: state.revision,
      qualityKey: state.qualityKey,
      requested: state.requested,
      code: 'remote_window_stream_quality_rejected',
      message: 'remote window quality result omitted applied profile',
      unsupported: false,
      acknowledged: state.acknowledged,
    };
  }
  return {
    phase: 'applied',
    revision: state.revision,
    qualityKey: state.qualityKey,
    applied: acknowledged.profile,
    groupBudget: result.appliedGroupBudget ?? null,
    result,
    acknowledged,
  };
}

export function rejectRemoteWindowQualityRequest(options: {
  state: RemoteWindowQualityApplyState;
  revision: number;
  message: string;
  code?: string;
}): RemoteWindowQualityApplyState {
  if (options.state.phase !== 'requested' || options.state.revision !== options.revision) {
    return options.state;
  }
  const code = options.code || 'remote_window_stream_quality_failed';
  return {
    phase: 'rejected',
    revision: options.revision,
    qualityKey: options.state.qualityKey,
    requested: options.state.requested,
    code,
    message: options.message,
    unsupported: code === REMOTE_WINDOW_QUALITY_UNSUPPORTED_CODE,
    acknowledged: options.state.acknowledged,
  };
}

export function hasRemoteWindowQualityKey(
  state: RemoteWindowQualityApplyState,
  qualityKey: string,
) {
  return (state.phase === 'requested' || state.phase === 'applied')
    && state.qualityKey === qualityKey;
}

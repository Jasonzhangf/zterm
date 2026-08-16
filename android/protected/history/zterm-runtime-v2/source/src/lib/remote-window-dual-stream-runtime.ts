export type RemoteWindowDualStreamPhase =
  | 'idle'
  | 'switch-requested'
  | 'overview-crop-visible'
  | 'focus-updating'
  | 'focus-ready'
  | 'focus-committed'
  | 'error';

export interface RemoteWindowDualStreamError {
  code: 'stale-focus-result' | 'invalid-focus-result' | 'focus-update-error';
  message: string;
}

export interface RemoteWindowDualStreamState {
  phase: RemoteWindowDualStreamPhase;
  revision: number;
  activeTargetId: string | null;
  pendingTargetId: string | null;
  focusStreamId: string | null;
  overviewCropTargetId: string | null;
  error: RemoteWindowDualStreamError | null;
}

export interface RemoteWindowFocusReadyResult {
  revision: number;
  targetId: string;
  streamId: string;
}

export function beginRemoteWindowDualStreamSwitch(
  state: RemoteWindowDualStreamState,
  targetId: string,
): RemoteWindowDualStreamState {
  if (!targetId) {
    return {
      ...state,
      phase: 'error',
      error: { code: 'invalid-focus-result', message: 'remote window switch target is empty' },
    };
  }
  return {
    ...state,
    phase: 'switch-requested',
    revision: state.revision + 1,
    pendingTargetId: targetId,
    overviewCropTargetId: null,
    error: null,
  };
}

export function showRemoteWindowOverviewCrop(
  state: RemoteWindowDualStreamState,
  targetId: string,
  cropTargetId = targetId,
): RemoteWindowDualStreamState {
  if (state.pendingTargetId !== targetId) {
    return state;
  }
  return {
    ...state,
    phase: 'overview-crop-visible',
    overviewCropTargetId: cropTargetId,
  };
}

export function markRemoteWindowFocusUpdating(
  state: RemoteWindowDualStreamState,
): RemoteWindowDualStreamState {
  if (state.phase !== 'switch-requested' && state.phase !== 'overview-crop-visible') {
    return state;
  }
  return { ...state, phase: 'focus-updating' };
}

export function acceptRemoteWindowFocusReady(
  state: RemoteWindowDualStreamState,
  result: RemoteWindowFocusReadyResult,
): RemoteWindowDualStreamState {
  if (
    result.revision !== state.revision
    || result.targetId !== state.pendingTargetId
    || result.streamId !== state.focusStreamId
  ) {
    return {
      ...state,
      error: {
        code: 'stale-focus-result',
        message: `ignored focus-ready revision=${result.revision} target=${result.targetId} stream=${result.streamId}`,
      },
    };
  }
  return { ...state, phase: 'focus-ready', error: null };
}

export function commitRemoteWindowFocusProjection(
  state: RemoteWindowDualStreamState,
): RemoteWindowDualStreamState {
  if (state.phase !== 'focus-ready' || !state.pendingTargetId) {
    return state;
  }
  return {
    ...state,
    phase: 'focus-committed',
    activeTargetId: state.pendingTargetId,
    pendingTargetId: null,
    overviewCropTargetId: null,
  };
}

export function failRemoteWindowDualStreamSwitch(
  state: RemoteWindowDualStreamState,
  message: string,
): RemoteWindowDualStreamState {
  return {
    ...state,
    phase: 'error',
    error: { code: 'focus-update-error', message },
  };
}

/**
 * 切流超时/缩回浮窗的兜底重置：把进行中的切流（switch-requested /
 * overview-crop-visible / focus-updating / focus-ready / error）强制拉回
 * focus-committed，保留 activeTargetId（focus 仍指向原窗口），清空
 * pendingTargetId / overviewCropTargetId。idle 或已 committed 时不动。
 * 用途：focus-result 消息被吞（streamId/targetId/revision 不匹配）时
 * 防止永久卡在 overview-crop-visible（video 隐藏 + canvas 无内容 = 黑屏）。
 */
export function resetRemoteWindowDualStreamSwitch(
  state: RemoteWindowDualStreamState,
): RemoteWindowDualStreamState {
  if (state.phase === 'idle' || state.phase === 'focus-committed') {
    return state;
  }
  return {
    ...state,
    phase: 'focus-committed',
    pendingTargetId: null,
    overviewCropTargetId: null,
    error: null,
  };
}

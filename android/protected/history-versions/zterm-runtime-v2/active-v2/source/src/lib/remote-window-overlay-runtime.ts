import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from './types';

export type RemoteWindowOverlayMode = 'floating' | 'fullscreen';

export interface RemoteWindowStreamHandoffState {
  epoch: number;
  previousStreamId: string;
  pendingStreamId: string;
  acceptedStreamIds?: string[];
  targetId: string;
  status: 'starting';
}

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
      targets: RemoteWindowStreamTargetManifest[];
      mode: RemoteWindowOverlayMode;
      streamStarted: boolean;
      streamStatus: 'idle' | 'starting' | 'streaming' | 'error';
      streamId?: string;
      streamErrorMessage?: string | null;
      streamDegradedMessage?: string | null;
      streamHandoff?: RemoteWindowStreamHandoffState | null;
      streamHandoffErrorMessage?: string | null;
      streamCleanupErrorMessage?: string | null;
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

function normalizeTargets(
  targets: RemoteWindowStreamTargetsResponsePayload['targets'] | undefined,
): RemoteWindowStreamTargetManifest[] {
  return Array.isArray(targets) ? targets : [];
}

function upsertRemoteWindowTarget(
  targets: RemoteWindowStreamTargetManifest[],
  target: RemoteWindowStreamTargetManifest,
) {
  let found = false;
  const nextTargets = targets.map((item) => {
    if (item.streamTargetId !== target.streamTargetId) {
      return item;
    }
    found = true;
    return target;
  });
  return found ? nextTargets : [target, ...nextTargets];
}

export function upsertRemoteWindowCatalogTarget(
  payload: RemoteWindowStreamTargetsResponsePayload,
  target: RemoteWindowStreamTargetManifest,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId: payload.requestId,
    targets: upsertRemoteWindowTarget(normalizeTargets(payload.targets), target),
    ...(payload.errors ? { errors: normalizeErrors(payload.errors) } : {}),
  };
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
    targets: normalizeTargets(payload.targets),
    errors: normalizeErrors(payload.errors),
    errorMessage: null,
  };
}

export function applyRemoteWindowTargetCatalogSnapshot(
  state: RemoteWindowOverlayState,
  payload: RemoteWindowStreamTargetsResponsePayload,
): RemoteWindowOverlayState {
  const targets = normalizeTargets(payload.targets);
  const errors = normalizeErrors(payload.errors);
  if (state.phase === 'pickerOpen') {
    return {
      ...state,
      targets,
      errors,
      errorMessage: null,
    };
  }
  if (state.phase !== 'targetLocked') {
    return state;
  }
  const nextTarget = targets.find((item) => (
    item.streamTargetId === state.target.streamTargetId
  )) || state.target;
  return {
    ...state,
    target: nextTarget,
    targets,
    errors,
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
  if (state.phase !== 'pickerOpen' && state.phase !== 'targetLocked') {
    return state;
  }
  const target = state.targets.find((item) => item.streamTargetId === targetId) || null;
  if (!target) {
    if (state.phase === 'targetLocked') {
      return {
        ...state,
        streamStatus: 'error',
        streamErrorMessage: 'Selected remote window target is no longer in the catalog',
      };
    }
    return {
      ...state,
      errorMessage: 'Selected remote window target is no longer in the catalog',
    };
  }
  // 组合推流（background pane）：选 app 窗口时自动带同 app 全部窗口（平铺合成）
  const compositeTarget = attachSameAppCompositeWindows(target, state.targets);
  if (state.phase === 'targetLocked') {
    return {
      ...state,
      target: compositeTarget,
      streamStarted: false,
      streamStatus: 'idle',
      streamId: undefined,
      streamErrorMessage: null,
      streamDegradedMessage: null,
    };
  }
  return {
    phase: 'targetLocked',
    requestEpoch: state.requestEpoch,
    target: compositeTarget,
    targets: state.targets,
    mode: 'floating',
    streamStarted: false,
    streamStatus: 'idle',
    errors: state.errors,
  };
}

export function attachSameAppCompositeWindows(
  target: RemoteWindowStreamTargetManifest,
  targets: RemoteWindowStreamTargetManifest[],
): RemoteWindowStreamTargetManifest {
  if (target.videoTarget.kind !== 'app-window') {
    return target;
  }
  const targetAppBundleId = target.videoTarget.appBundleId?.trim();
  const originalTargetOwnerName = target.videoTarget.ownerName?.trim();
  // 归属未知（appBundleId 为空）时禁止盲目聚合，避免把其他 app 的窗口混进组合
  if (!targetAppBundleId) {
    return target;
  }
  const filteredCandidates = targets.filter((item) => {
      if (item.videoTarget.kind !== 'app-window') {
        return false;
      }
      if (item.streamTargetId === target.streamTargetId) {
        return false;
      }
      const itemAppBundleId = item.videoTarget.appBundleId?.trim();
      if (!itemAppBundleId || itemAppBundleId !== targetAppBundleId) {
        return false;
      }
      return true;
    });
  const compositeWindows = filteredCandidates
    .filter((item) => {
      // 双保险：ownerName 存在时必须一致（避免不同 app 共享/缺失 bundle id 时误聚合）
      const itemOwnerName = item.videoTarget.ownerName?.trim();
      if (itemOwnerName && originalTargetOwnerName && itemOwnerName !== originalTargetOwnerName) {
        return false;
      }
      return true;
    })
    .map((item) => ({
      windowId: item.videoTarget.windowId,
      title: item.videoTarget.title,
      ownerName: item.videoTarget.ownerName,
      windowBoundsTopLeftPx: item.videoTarget.windowBoundsTopLeftPx,
      cropRectTopLeftPx: item.videoTarget.cropRectTopLeftPx,
    }));
  // 双流的 overview 是否启动由 app-window target 类型决定；compositeWindows 只描述
  // 主窗口之外的真实兄弟窗口，不能把主窗口自身塞回列表，否则客户端会绘制重复主缩略图。
  if (compositeWindows.length > 0) {
    return { ...target, compositeWindows };
  }
  if (filteredCandidates.length > compositeWindows.length) {
    // 有候选被 ownerName 不一致过滤掉 → 真的跨 app 误报，绝不聚合。
    return target;
  }
  return target;
}

export function beginRemoteWindowStreamSetup(
  state: RemoteWindowOverlayState,
  streamId: string,
): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked') {
    return state;
  }
  const normalizedStreamId = streamId.trim();
  if (!normalizedStreamId) {
    return {
      ...state,
      streamStarted: false,
      streamStatus: 'error',
      streamErrorMessage: 'Remote window stream requires streamId',
    };
  }
  return {
    ...state,
    streamId: normalizedStreamId,
    streamStarted: false,
    streamStatus: 'starting',
    streamErrorMessage: null,
    streamDegradedMessage: null,
    streamHandoff: null,
    streamHandoffErrorMessage: null,
    streamCleanupErrorMessage: null,
  };
}

export function beginRemoteWindowStreamHandoff(
  state: RemoteWindowOverlayState,
  handoff: RemoteWindowStreamHandoffState,
): RemoteWindowOverlayState {
  if (
    state.phase !== 'targetLocked'
    || !state.streamId
    || state.streamId !== handoff.previousStreamId
  ) {
    return state;
  }
  return {
    ...state,
    streamHandoff: handoff,
    streamHandoffErrorMessage: null,
  };
}

export function attachRemoteWindowStreamReceiver(
  state: RemoteWindowOverlayState,
  streamId: string,
): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked' || state.streamId !== streamId) {
    return state;
  }
  return {
    ...state,
    streamStarted: true,
    streamStatus: 'streaming',
    streamErrorMessage: null,
  };
}

export function degradeRemoteWindowStream(
  state: RemoteWindowOverlayState,
  streamId: string,
  error: unknown,
): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked' || state.streamId !== streamId) {
    return state;
  }
  return {
    ...state,
    streamDegradedMessage: error instanceof Error ? error.message : String(error),
  };
}

export function commitRemoteWindowStreamHandoff(
  state: RemoteWindowOverlayState,
  handoff: RemoteWindowStreamHandoffState,
  committedStreamId: string,
): RemoteWindowOverlayState {
  const acceptedStreamIds = handoff.acceptedStreamIds && handoff.acceptedStreamIds.length > 0
    ? handoff.acceptedStreamIds
    : [handoff.pendingStreamId];
  if (
    state.phase !== 'targetLocked'
    || !state.streamHandoff
    || state.streamHandoff.epoch !== handoff.epoch
    || state.streamHandoff.pendingStreamId !== handoff.pendingStreamId
    || state.streamHandoff.targetId !== handoff.targetId
    || !acceptedStreamIds.includes(committedStreamId)
  ) {
    return state;
  }
  const committed = attachRemoteWindowStreamReceiver(
    beginRemoteWindowStreamSetup(
      selectRemoteWindowTarget(state, handoff.targetId),
      committedStreamId,
    ),
    committedStreamId,
  );
  if (committed.phase !== 'targetLocked') {
    return committed;
  }
  return {
    ...committed,
    streamHandoff: null,
    streamHandoffErrorMessage: null,
  };
}

export function failRemoteWindowStreamHandoff(
  state: RemoteWindowOverlayState,
  handoff: RemoteWindowStreamHandoffState,
  error: unknown,
): RemoteWindowOverlayState {
  if (
    state.phase !== 'targetLocked'
    || !state.streamHandoff
    || state.streamHandoff.epoch !== handoff.epoch
    || state.streamHandoff.pendingStreamId !== handoff.pendingStreamId
  ) {
    return state;
  }
  return {
    ...state,
    streamHandoff: null,
    streamHandoffErrorMessage: error instanceof Error ? error.message : String(error),
  };
}

export function failRemoteWindowStreamCleanup(
  state: RemoteWindowOverlayState,
  previousStreamId: string,
  nextStreamId: string,
  error: unknown,
): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked' || state.streamId !== nextStreamId) {
    return state;
  }
  return {
    ...state,
    streamCleanupErrorMessage: `旧远程窗口流 ${previousStreamId} 清理失败: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export function applyRemoteWindowInputResultTarget(
  state: RemoteWindowOverlayState,
  streamId: string,
  targetId: string,
  target: RemoteWindowStreamTargetManifest,
): RemoteWindowOverlayState {
  if (
    state.phase !== 'targetLocked'
    || state.streamId !== streamId
    || state.target.streamTargetId !== targetId
    || target.streamTargetId !== targetId
  ) {
    return state;
  }
  return {
    ...state,
    target,
    targets: upsertRemoteWindowTarget(state.targets, target),
  };
}

export function failRemoteWindowStream(
  state: RemoteWindowOverlayState,
  streamId: string,
  error: unknown,
): RemoteWindowOverlayState {
  if (state.phase !== 'targetLocked' || state.streamId !== streamId) {
    return state;
  }
  return {
    ...state,
    streamStarted: false,
    streamStatus: 'error',
    streamErrorMessage: error instanceof Error ? error.message : String(error),
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

// ---- 组合推流 UI 布局（与 daemon resolveRemoteWindowCompositeLayout 保持同算法：单行平铺）----

export interface RemoteWindowCompositeWindowSlot {
  windowId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface RemoteWindowCompositeLayoutClient {
  windows: RemoteWindowCompositeWindowSlot[];
  canvasWidth: number;
  canvasHeight: number;
}

export function resolveRemoteWindowCompositeWindowLayout(
  target: RemoteWindowStreamTargetManifest,
): RemoteWindowCompositeLayoutClient | null {
  const compositeWindows = target.compositeWindows ?? [];
  if (compositeWindows.length === 0) {
    return null;
  }
  const mainCrop = target.videoTarget.cropRectTopLeftPx ?? target.videoTarget.windowBoundsTopLeftPx;
  const entries = [
    {
      windowId: target.videoTarget.windowId,
      crop: mainCrop,
    },
    ...compositeWindows.map((w) => ({
      windowId: w.windowId,
      crop: w.cropRectTopLeftPx ?? w.windowBoundsTopLeftPx,
    })),
  ];
  const uniqueEntries = entries.filter((entry, index) => (
    entries.findIndex((candidate) => candidate.windowId === entry.windowId) === index
  ));
  if (uniqueEntries.length <= 1) {
    return null;
  }
  const canvasWidth = 1920;
  const canvasHeight = 1080;
  const totalWidth = uniqueEntries.reduce((sum, entry) => sum + Math.max(1, entry.crop.width), 0);
  const maxHeight = uniqueEntries.reduce((max, entry) => Math.max(max, Math.max(1, entry.crop.height)), 1);
  const scale = Math.min(1, canvasWidth / totalWidth, canvasHeight / maxHeight);
  let offsetX = 0;
  const windows = uniqueEntries.map((entry) => {
    const slot: RemoteWindowCompositeWindowSlot = {
      windowId: entry.windowId,
      offsetX,
      offsetY: 0,
      width: Math.max(1, Math.round(entry.crop.width * scale)),
      height: Math.max(1, Math.round(entry.crop.height * scale)),
    };
    offsetX += slot.width;
    return slot;
  });
  return {
    windows,
    canvasWidth,
    canvasHeight,
  };
}

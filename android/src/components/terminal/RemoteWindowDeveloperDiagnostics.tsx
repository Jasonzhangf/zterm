import type { RemoteWindowCanvasLayoutV1 } from '../../lib/types';
import type { RemoteWindowOverlayState } from '../../lib/remote-window-overlay-runtime';
import type {
  RemoteWindowLiveDiagnostics,
  RemoteWindowVideoDebugSnapshot,
  RemoteWindowViewportDebugSnapshot,
} from './RemoteWindowOverlayController';
import { styles } from './remote-window-overlay-styles';

type RemoteWindowLockedOverlayState = Extract<RemoteWindowOverlayState, { phase: 'targetLocked' }>;

export interface RemoteWindowDeveloperDiagnosticsProps {
  activeSessionId?: string | null;
  appForegroundActive: boolean;
  canvasLayout: RemoteWindowCanvasLayoutV1 | null;
  liveDiagnostics: RemoteWindowLiveDiagnostics | null;
  receiverAttached: boolean;
  receiverFrameSize: { width: number; height: number } | null;
  state: RemoteWindowLockedOverlayState;
  videoDebugSnapshot: RemoteWindowVideoDebugSnapshot | null;
  videoHasPlayed: boolean;
  viewportDebugSnapshot: RemoteWindowViewportDebugSnapshot | null;
}

export function RemoteWindowDeveloperDiagnostics({
  activeSessionId,
  appForegroundActive,
  canvasLayout,
  liveDiagnostics,
  receiverAttached,
  receiverFrameSize,
  state,
  videoDebugSnapshot,
  videoHasPlayed,
  viewportDebugSnapshot,
}: RemoteWindowDeveloperDiagnosticsProps) {
  return (
    <details data-testid="remote-window-developer-diagnostics" style={styles.debugDiagnostics}>
      <summary>开发诊断</summary>
      <div>app: {appForegroundActive ? 'foreground' : 'background'}</div>
      <div>phase: {state.phase} / {state.streamStatus}</div>
      <div>session: {activeSessionId || '-'}</div>
      <div>stream: {state.streamId || '-'}</div>
      <div>target: {state.target?.streamTargetId || '-'}</div>
      <div>layout: {canvasLayout ? `v${canvasLayout.version} gen=${canvasLayout.layoutGeneration}` : '-'}</div>
      <div>receiver: {receiverAttached ? 'attached' : 'missing'} / played:{videoHasPlayed ? 'yes' : 'no'}</div>
      <div>frame: {receiverFrameSize ? `${receiverFrameSize.width}x${receiverFrameSize.height}` : '-'}</div>
      <div>video: {videoDebugSnapshot ? `${videoDebugSnapshot.videoWidth}x${videoDebugSnapshot.videoHeight} ready=${videoDebugSnapshot.readyState} frames=${videoDebugSnapshot.framesReceived}` : '-'}</div>
      <div>live: {liveDiagnostics ? `t=${liveDiagnostics.currentTime.toFixed(3)} track=${liveDiagnostics.trackState} frames=${liveDiagnostics.framesReceived}` : '-'}</div>
      <div>error: {videoDebugSnapshot?.lastError || state.streamErrorMessage || '-'}</div>
      <div>viewport: {viewportDebugSnapshot ? `${viewportDebugSnapshot.event} window=${viewportDebugSnapshot.window}` : '-'}</div>
    </details>
  );
}

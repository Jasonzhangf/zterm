import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import {
  buildRemoteWindowAppTargetGroups,
  formatTargetSubtitle,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowAppSwitchProps {
  targets: RemoteWindowStreamTargetManifest[];
  activeTargetId: string;
  catalogSyncError: string | null;
  onSelectTarget: (target: RemoteWindowStreamTargetManifest) => void;
  onDismiss: () => void;
}

export function RemoteWindowAppSwitch({
  targets,
  activeTargetId,
  catalogSyncError,
  onSelectTarget,
  onDismiss,
}: RemoteWindowAppSwitchProps) {
  const appGroups = buildRemoteWindowAppTargetGroups(targets);
  const itermTargets = targets.filter((target) => target.videoTarget.kind === 'iterm2-pane');
  const renderTarget = (target: RemoteWindowStreamTargetManifest) => {
    const active = target.streamTargetId === activeTargetId;
    return (
      <button
        key={target.streamTargetId}
        type="button"
        data-no-drag="true"
        data-testid={`remote-window-active-app-switch-target-${target.streamTargetId}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => active ? onDismiss() : onSelectTarget(target)}
        style={active ? styles.appSwitchTargetRowActive : styles.appSwitchTargetRow}
      >
        <span style={styles.appSwitchTargetTitle}>
          {target.videoTarget.title || target.videoTarget.appBundleId || target.streamTargetId}
        </span>
        <span style={styles.appSwitchTargetMeta}>{formatTargetSubtitle(target)}</span>
      </button>
    );
  };

  return (
    <div data-testid="remote-window-active-app-switch-list" data-no-drag="true" style={styles.appSwitchPopover}>
      {catalogSyncError ? (
        <div data-testid="remote-window-active-catalog-sync-error" style={styles.appSwitchError}>
          {catalogSyncError}
        </div>
      ) : null}
      {appGroups.map((group) => (
        <div
          key={group.groupId}
          data-testid={`remote-window-active-app-switch-group-${safeRemoteWindowGroupId(group.groupId)}`}
          style={styles.appSwitchGroup}
        >
          <div style={styles.appSwitchGroupTitle}>
            <span>{group.title || group.appBundleId}</span>
            <span style={styles.appSwitchGroupCount}>{group.targets.length}</span>
          </div>
          {group.targets.map(renderTarget)}
        </div>
      ))}
      {itermTargets.length > 0 ? (
        <div data-testid="remote-window-active-app-switch-group-iterm2" style={styles.appSwitchGroup}>
          <div style={styles.appSwitchGroupTitle}>
            <span>iTerm2 Panes</span>
            <span style={styles.appSwitchGroupCount}>{itermTargets.length}</span>
          </div>
          {itermTargets.map(renderTarget)}
        </div>
      ) : null}
      {targets.length === 0 ? <div style={styles.appSwitchEmpty}>没有可切换窗口</div> : null}
    </div>
  );
}

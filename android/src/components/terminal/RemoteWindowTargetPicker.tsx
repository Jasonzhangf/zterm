import type {
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamTargetManifest,
} from '../../lib/types';
import {
  buildRemoteWindowAppTargetGroups,
  formatTargetKind,
  formatTargetSubtitle,
  safeRemoteWindowGroupId,
} from './remote-window-overlay-helpers';
import { RemoteWindowIcon } from './remote-window-icons';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowTargetPickerProps {
  phase: 'targetEnumerating' | 'pickerOpen';
  targets: RemoteWindowStreamTargetManifest[];
  errors: RemoteWindowStreamErrorPayload[];
  errorMessage: string | null;
  catalogRefreshing: boolean;
  itermPaneTargetsExpanded: boolean;
  onToggleItermPaneTargets: () => void;
  onSelectTarget: (target: RemoteWindowStreamTargetManifest) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function RemoteWindowPickerErrors({ errors }: { errors: RemoteWindowStreamErrorPayload[] }) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div data-testid="remote-window-partial-errors" style={styles.errorStrip}>
      {errors.map((error) => (
        <div key={`${error.requestId}:${error.code}:${error.message}`}>
          {error.code}: {error.message}
        </div>
      ))}
    </div>
  );
}

export function RemoteWindowTargetPicker({
  phase,
  targets,
  errors,
  errorMessage,
  catalogRefreshing,
  itermPaneTargetsExpanded,
  onToggleItermPaneTargets,
  onSelectTarget,
  onRefresh,
  onClose,
}: RemoteWindowTargetPickerProps) {
  const appGroups = phase === 'pickerOpen' ? buildRemoteWindowAppTargetGroups(targets) : [];
  const itermPaneTargets = phase === 'pickerOpen'
    ? targets.filter((target) => target.videoTarget.kind === 'iterm2-pane')
    : [];
  return (
    <div
      data-testid="remote-window-picker"
      role="dialog"
      aria-label="远程窗口"
      aria-modal="true"
      aria-busy={phase === 'targetEnumerating' || catalogRefreshing ? 'true' : 'false'}
      style={styles.pickerPanel}
    >
      <div style={styles.panelHeader}>
        <div>
          <h2 style={styles.panelTitle}>远程窗口</h2>
          <div aria-live="polite" style={styles.panelSubtitle}>
            {phase === 'targetEnumerating'
              ? '正在读取窗口列表'
              : `${targets.length} 个目标${catalogRefreshing ? ' · 更新中' : ''}`}
          </div>
        </div>
        <div style={styles.panelActions}>
          <button
            type="button"
            aria-label="刷新远程窗口列表"
            aria-busy={phase === 'targetEnumerating' || catalogRefreshing ? 'true' : undefined}
            onClick={onRefresh}
            style={styles.pickerIconButton}
          >
            <span style={phase === 'targetEnumerating' || catalogRefreshing ? styles.pickerRefreshingIcon : undefined}>
              <RemoteWindowIcon name="refresh" />
            </span>
          </button>
          <button type="button" aria-label="关闭远程窗口选择" onClick={onClose} style={styles.pickerIconButton}>
            <RemoteWindowIcon name="close" />
          </button>
        </div>
      </div>
      {phase === 'pickerOpen' && errorMessage ? (
        <div data-testid="remote-window-picker-error" role="alert" style={styles.errorBox}>{errorMessage}</div>
      ) : null}
      {phase === 'pickerOpen' && targets.length === 0 ? <RemoteWindowPickerErrors errors={errors} /> : null}
      <div style={styles.targetList}>
        {phase === 'targetEnumerating' ? (
          <div data-testid="remote-window-picker-loading" role="status" style={styles.pickerState}>
            <span aria-hidden="true" style={styles.pickerSpinner} />
            <span>正在读取窗口列表</span>
          </div>
        ) : targets.length === 0 ? (
          <div data-testid="remote-window-picker-empty" style={styles.pickerEmptyState}>
            <strong style={styles.pickerEmptyTitle}>没有可选窗口</strong>
            <span style={styles.pickerEmptyDetail}>刷新后会显示当前可串流的应用窗口。</span>
            <button type="button" aria-label="重新加载远程窗口列表" onClick={onRefresh} style={styles.pickerRecoveryButton}>
              重新加载
            </button>
          </div>
        ) : (
          <>
            {appGroups.map((group) => {
              const primary = group.targets[0];
              return (
                <button
                  type="button"
                  key={group.groupId}
                  data-testid={`remote-window-app-group-${safeRemoteWindowGroupId(group.groupId)}`}
                  data-primary-target-id={primary.streamTargetId}
                  onClick={() => onSelectTarget(primary)}
                  style={styles.targetGroupRow}
                >
                  <span style={styles.targetKind}>App</span>
                  <span style={styles.targetCopy}>
                    <span style={styles.targetMain}>{group.title || group.appBundleId}</span>
                    <span data-testid={`remote-window-target-${primary.streamTargetId}`} style={styles.targetMeta}>
                      {group.targets.length} 个窗口 · {formatTargetSubtitle(primary)}
                    </span>
                  </span>
                </button>
              );
            })}
            {itermPaneTargets.length > 0 ? (
              <button
                type="button"
                data-testid="remote-window-iterm-pane-group"
                aria-expanded={itermPaneTargetsExpanded}
                onClick={onToggleItermPaneTargets}
                style={styles.targetGroupRow}
              >
                <span style={styles.targetKind}>iTerm2</span>
                <span style={styles.targetCopy}>
                  <span style={styles.targetMain}>iTerm2 Panes</span>
                  <span style={styles.targetMeta}>
                    {itermPaneTargetsExpanded ? `${itermPaneTargets.length} 个 pane` : `${itermPaneTargets.length} 个 pane · 已折叠`}
                  </span>
                </span>
              </button>
            ) : null}
            {itermPaneTargetsExpanded ? itermPaneTargets.map((target) => (
              <button
                key={target.streamTargetId}
                type="button"
                data-testid={`remote-window-target-${target.streamTargetId}`}
                onClick={() => onSelectTarget(target)}
                style={styles.targetRow}
              >
                <span style={styles.targetKind}>{formatTargetKind(target)}</span>
                <span style={styles.targetCopy}>
                  <span style={styles.targetMain}>{target.videoTarget.title || target.videoTarget.appBundleId}</span>
                  <span style={styles.targetMeta}>{formatTargetSubtitle(target)}</span>
                </span>
              </button>
            )) : null}
          </>
        )}
      </div>
    </div>
  );
}

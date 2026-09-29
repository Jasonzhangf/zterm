import { resolveActiveTab } from '@zterm/shared';
import type { WindowsConnectionProfile } from './windows-profile-store';
import type { WindowsWorkspaceState } from './windows-workspace';
import type { WindowsTerminalRegistry } from './windows-terminal-registry';

function statusFor(registry: WindowsTerminalRegistry, workspace: WindowsWorkspaceState) {
  const activeTab = resolveActiveTab(workspace);
  if (!activeTab?.target) {
    return { sessionName: 'No session', state: 'idle', error: '', geometry: '' };
  }
  const session = registry.get(activeTab.id);
  const snapshot = session?.getSnapshot();
  return {
    sessionName: activeTab.target.sessionName,
    state: snapshot?.status ?? 'idle',
    error: snapshot?.error ?? '',
    geometry: snapshot ? `${snapshot.buffer.cols} x ${snapshot.buffer.rows}` : '',
  };
}

export function WindowsStatusBar({
  profile,
  registry,
  workspace,
  controlError,
}: {
  profile: WindowsConnectionProfile | null;
  registry: ReturnType<typeof import('./windows-terminal-registry').createWindowsTerminalRegistry>;
  workspace: WindowsWorkspaceState;
  controlError: string;
}) {
  const status = statusFor(registry, workspace);
  return (
    <footer className="windows-statusbar" data-status={status.state} data-testid="windows-statusbar">
      <span className="statusbar-segment">{profile?.name ?? 'No profile'}</span>
      <span className="statusbar-segment">{status.sessionName}</span>
      <span className="statusbar-segment">{status.state}</span>
      {status.geometry ? <span className="statusbar-segment">{status.geometry}</span> : null}
      {status.error || controlError ? (
        <span className="statusbar-segment statusbar-error">{status.error || controlError}</span>
      ) : null}
    </footer>
  );
}

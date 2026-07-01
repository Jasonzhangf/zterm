import type { Dispatch, SetStateAction } from 'react';
import type { BridgeSettings, EditableHost, Host } from '@zterm/shared';
import { ShellWorkspace } from '../pages/ShellWorkspace';

interface MacWorkspaceTransitionalShellProps {
  hosts: Host[];
  isLoaded: boolean;
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  addHost: (host: EditableHost) => Host;
  updateHost: (id: string, updates: Partial<EditableHost>) => void;
}

export function MacWorkspaceTransitionalShell(props: MacWorkspaceTransitionalShellProps) {
  return <ShellWorkspace {...props} />;
}

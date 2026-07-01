import {
  useBridgeSettingsStorage,
  useHostStorage,
} from '@zterm/shared';
import { MacWorkspaceTransitionalShell } from './MacWorkspaceTransitionalShell';

export function MacDesktopApp() {
  const { hosts, isLoaded, addHost, updateHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();

  return (
    <MacWorkspaceTransitionalShell
      hosts={hosts}
      isLoaded={isLoaded}
      bridgeSettings={settings}
      setBridgeSettings={setSettings}
      addHost={addHost}
      updateHost={updateHost}
    />
  );
}

import {
  useBridgeSettingsStorage,
  useHostStorage,
} from '@zterm/shared';
import { MacAppShell } from './MacAppShell';

export function MacDesktopApp() {
  const { hosts, isLoaded, addHost, updateHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();

  return (
    <MacAppShell
      hosts={hosts}
      isLoaded={isLoaded}
      bridgeSettings={settings}
      setBridgeSettings={setSettings}
      addHost={addHost}
      updateHost={updateHost}
    />
  );
}

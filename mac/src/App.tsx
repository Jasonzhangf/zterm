import {
  useBridgeSettingsStorage,
  useHostStorage,
} from '@zterm/shared';
import { MacAppShell } from './app/MacAppShell';

export default function App() {
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

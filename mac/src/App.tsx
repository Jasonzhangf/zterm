import {
  useBridgeSettingsStorage,
  useHostStorage,
} from '@zterm/shared';
import { ShellWorkspace } from './pages/ShellWorkspace';

export default function App() {
  const { hosts, isLoaded, addHost, updateHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();

  return (
    <ShellWorkspace
      hosts={hosts}
      isLoaded={isLoaded}
      bridgeSettings={settings}
      setBridgeSettings={setSettings}
      addHost={addHost}
      updateHost={updateHost}
    />
  );
}

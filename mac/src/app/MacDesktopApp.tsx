import {
  useBridgeSettingsStorage,
  useHostStorage,
} from '@zterm/shared';
import { MacAppShell } from './MacAppShell';
import { resolveMacRendererWindowId } from './window/window-id';

export function MacDesktopApp() {
  const { hosts, isLoaded, addHost, updateHost } = useHostStorage();
  const { settings, setSettings } = useBridgeSettingsStorage();
  const windowId = resolveMacRendererWindowId(globalThis.window.location);

  return (
    <MacAppShell
      windowId={windowId}
      hosts={hosts}
      isLoaded={isLoaded}
      bridgeSettings={settings}
      setBridgeSettings={setSettings}
      addHost={addHost}
      updateHost={updateHost}
    />
  );
}

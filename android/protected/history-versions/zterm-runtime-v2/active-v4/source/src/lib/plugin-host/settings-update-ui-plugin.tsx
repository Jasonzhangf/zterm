import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { AppUpdateSection } from '../../components/settings/AppUpdateSection';
import {
  SETTINGS_UPDATE_UI_SLOT_ID,
  type SettingsUpdateUiProps,
} from '../plugin-settings-update/settings-update-contract';

export class SettingsUpdateUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<SettingsUpdateUiProps>(
      SETTINGS_UPDATE_UI_SLOT_ID,
      (props) => <AppUpdateSection {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

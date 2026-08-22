import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { TerminalQuickBar } from '../../components/terminal/TerminalQuickBar';
import {
  QUICKBAR_UI_SLOT_ID,
  type QuickBarUiProps,
} from '../plugin-quickbar/quickbar-contract';

export class QuickBarUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<QuickBarUiProps>(
      QUICKBAR_UI_SLOT_ID,
      (props) => <TerminalQuickBar {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { TerminalSessionDrawer } from '../../components/terminal/TerminalSessionDrawer';
import {
  SESSION_DRAWER_UI_SLOT_ID,
  type SessionDrawerUiProps,
} from '../plugin-session-drawer/session-drawer-contract';

export class SessionDrawerUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<SessionDrawerUiProps>(
      SESSION_DRAWER_UI_SLOT_ID,
      (props) => <TerminalSessionDrawer {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { RemoteWindowOverlay } from '../../components/terminal/RemoteWindowOverlay';
import {
  REMOTE_WINDOW_UI_SLOT_ID,
  type RemoteWindowUiProps,
} from '../plugin-remote-window/remote-window-contract';

export class RemoteWindowUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<RemoteWindowUiProps>(
      REMOTE_WINDOW_UI_SLOT_ID,
      (props) => <RemoteWindowOverlay {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

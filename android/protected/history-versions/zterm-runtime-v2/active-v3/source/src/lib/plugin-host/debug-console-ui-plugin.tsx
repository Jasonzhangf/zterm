import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { TerminalDebugOverlay } from '../../pages/TerminalPageDebugOverlay';
import {
  DEBUG_CONSOLE_UI_SLOT_ID,
  type TerminalDebugOverlayProps,
} from '../plugin-debug-console/debug-console-contract';

export class DebugConsoleUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<TerminalDebugOverlayProps>(
      DEBUG_CONSOLE_UI_SLOT_ID,
      (props) => <TerminalDebugOverlay {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

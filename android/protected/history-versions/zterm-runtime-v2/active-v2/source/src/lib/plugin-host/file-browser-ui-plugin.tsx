import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { FileTransferSheet } from '../../components/terminal/FileTransferSheet';
import {
  FILE_BROWSER_UI_SLOT_ID,
  type FileBrowserUiProps,
} from '../plugin-file-browser/file-browser-contract';

export class FileBrowserUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<FileBrowserUiProps>(
      FILE_BROWSER_UI_SLOT_ID,
      (props) => <FileTransferSheet {...props} />,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

import type { ReactNode } from 'react';
import type { PluginContext, PluginInstance } from '@zterm/shared/terminal/plugin-contract';
import { TerminalConnectionStatusStrip } from '../../pages/TerminalConnectionStatusStrip';
import { TerminalPageCopyMenu } from '../../pages/TerminalPageCopyMenu';
import { TerminalStageShell } from '../../pages/TerminalPageStageShell';
import { TerminalNetworkBanner, TerminalQuickBarShell } from '../../pages/terminal-page-shell-ui';
import {
  TERMINAL_SHELL_UI_SLOT_ID,
  type TerminalShellUiProps,
} from '../plugin-terminal-shell/terminal-shell-contract';

export function renderTerminalShellUi(props: TerminalShellUiProps): ReactNode {
  return (
    <>
      <TerminalNetworkBanner {...props.networkBanner} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {props.topProjection.statusStrip ? (
          <TerminalConnectionStatusStrip {...props.topProjection.statusStrip} />
        ) : null}
        {props.topProjection.controls}
        <TerminalStageShell {...props.stage} />
        {props.copyMenu ? <TerminalPageCopyMenu {...props.copyMenu} /> : null}
        {props.bottomProjection}
        {props.quickBarShell.visible ? (
          <TerminalQuickBarShell
            bottomPx={props.quickBarShell.bottomPx}
            zIndex={props.quickBarShell.zIndex}
            centered={props.quickBarShell.centered}
          >
            {props.quickBarShell.children}
          </TerminalQuickBarShell>
        ) : null}
      </div>
    </>
  );
}

export class TerminalShellUiPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    context.provideUiSlot<TerminalShellUiProps>(
      TERMINAL_SHELL_UI_SLOT_ID,
      renderTerminalShellUi,
    );
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}

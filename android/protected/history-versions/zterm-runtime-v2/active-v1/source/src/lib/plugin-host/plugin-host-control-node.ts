import {
  errorControlOutcome,
  okControlOutcome,
  type ControlCommand,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';
import type { PluginHost } from './plugin-host-runtime';

export interface PluginHostDisposeParams {
  readonly reason: string;
}

export type PluginHostControlNodeError =
  | {
      readonly code: 'invalid_reason';
      readonly message: string;
    }
  | {
      readonly code: 'dispose_failed';
      readonly message: string;
    };

export class PluginHostControlNode {
  readonly ownerId = 'plugin-host-control-node' as const;

  constructor(private readonly pluginHost: PluginHost) {}

  async execute(
    command: Readonly<ControlCommand<unknown>>,
  ): Promise<
    ControlOutcome<
      { readonly disposed: true; readonly reason: string },
      PluginHostControlNodeError
    >
  > {
    const reason = readDisposeReason(command.params);
    if (reason === null) {
      return errorControlOutcome({
        code: 'invalid_reason',
        message: 'plugin-host.dispose reason must be a non-empty string',
      });
    }

    try {
      await this.pluginHost.disposeAll(reason);
    } catch (error) {
      return errorControlOutcome({
        code: 'dispose_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return okControlOutcome({ disposed: true, reason });
  }
}

function readDisposeReason(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) {
    return null;
  }
  const reason = (params as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

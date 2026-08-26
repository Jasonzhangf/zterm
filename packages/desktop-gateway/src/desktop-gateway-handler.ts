import { errorOutcome, okOutcome, type ControlOutcome } from '@zterm/runtime-contracts';
import { isDesktopCommandWire, type DesktopCommandResult, type DesktopCommandResultWire } from './desktop-platform-contracts.js';
import { DesktopGatewayError } from './desktop-gateway-errors.js';

export type DesktopCommandExecutor = (params: unknown) => unknown | Promise<unknown>;

export interface DesktopCommandHandlerState {
  getGeneration(): number;
  setGeneration(generation: number): void;
}

/**
 * Shared control-plane boundary for Electron main processes.
 * Native implementations are registered by the owning host and never cross
 * this package boundary.
 */
export class DesktopCommandHandler {
  private readonly executors = new Map<string, DesktopCommandExecutor>();

  constructor(private readonly state: DesktopCommandHandlerState) {}

  register(commandType: string, executor: DesktopCommandExecutor): void {
    if (this.executors.has(commandType)) {
      throw new Error(`duplicate desktop command: ${commandType}`);
    }
    this.executors.set(commandType, executor);
  }

  async execute(wire: unknown): Promise<DesktopCommandResultWire> {
    if (!isDesktopCommandWire(wire)) {
      return {
        commandId: '',
        generation: 0,
        outcome: errorOutcome(
          'INVALID_COMMAND',
          'commandType, commandId, correlationId, and generation are required',
        ),
      };
    }

    const { commandType, commandId, params, generation } = wire;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return {
        commandId,
        generation,
        outcome: errorOutcome('INVALID_GENERATION', 'generation must be a positive integer'),
      };
    }
    const currentGeneration = this.state.getGeneration();
    if (generation < currentGeneration) {
      return {
        commandId,
        generation,
        outcome: errorOutcome(
          'STALE_GENERATION',
          `stale generation ${generation} < current ${currentGeneration}`,
        ),
      };
    }

    this.state.setGeneration(generation);
    const executor = this.executors.get(commandType);
    if (!executor) {
      return {
        commandId,
        generation,
        outcome: errorOutcome('UNKNOWN_COMMAND', `unknown command: ${commandType}`),
      };
    }

    try {
      const value = await executor(params);
      return {
        commandId,
        generation,
        outcome: okOutcome(value as DesktopCommandResult),
      };
    } catch (error) {
      return {
        commandId,
        generation,
        outcome: errorOutcome(
          error instanceof DesktopGatewayError ? error.code : 'EXECUTION_ERROR',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }
}

export type DesktopCommandOutcome<R> = ControlOutcome<R>;

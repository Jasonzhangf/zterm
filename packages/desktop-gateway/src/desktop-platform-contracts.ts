/**
 * Phase 3: typed platform command/event contracts for desktop Electron hosts.
 * Platform-neutral: no React, Electron, Cordis imports.
 * Consumed by Mac/Windows preload bridges and renderer-side gateway adapters.
 */
import type { ControlOutcome, RuntimeEvent, RuntimeSnapshot } from '@zterm/runtime-contracts';

// ── Platform command types ────────────────────────────────────────────────

/** Discovers available local tmux sessions. */
export interface DesktopListSessionsCommand {
  commandType: 'desktop.listSessions';
}

/** Opens a local tmux session. */
export interface DesktopTmuxConnectCommand {
  commandType: 'desktop.tmuxConnect';
  params: { clientId: string; sessionName: string; cols: number; rows: number };
}

/** Closes an active local tmux session. */
export interface DesktopTmuxDisconnectCommand {
  commandType: 'desktop.tmuxDisconnect';
  params: { clientId: string };
}

/** Resizes an active local tmux session. */
export interface DesktopTmuxResizeCommand {
  commandType: 'desktop.tmuxResize';
  params: { clientId: string; cols: number; rows: number };
}

/** Lists a local directory. */
export interface DesktopListDirCommand {
  commandType: 'desktop.listDir';
  params: { dirPath: string };
}

/** Creates a new window. */
export interface DesktopCreateWindowCommand {
  commandType: 'desktop.createWindow';
}

/** Reads a local file. */
export interface DesktopReadFileCommand {
  commandType: 'desktop.readFile';
  params: { filePath: string };
}

export type DesktopPlatformCommand =
  | DesktopListSessionsCommand
  | DesktopTmuxConnectCommand
  | DesktopTmuxDisconnectCommand
  | DesktopTmuxResizeCommand
  | DesktopListDirCommand
  | DesktopCreateWindowCommand
  | DesktopReadFileCommand;

// ── Response payloads ────────────────────────────────────────────────────────

export interface TmuxSessionListPayload { sessions: string[] }
export interface TmuxConnectPayload { clientId: string }
export interface TmuxDisconnectPayload { clientId: string }
export interface TmuxResizePayload { clientId: string }
export interface ListDirEntry {
  name: string; type: 'file' | 'directory';
  size: number; modified: number; modifiedMs: number; path: string;
}
export interface ListDirPayload { path: string; entries: ListDirEntry[] }
export interface CreateWindowPayload { windowId: string }
export interface ReadFilePayload { dataBase64: string; size: number }

export type DesktopCommandResult =
  | TmuxSessionListPayload
  | TmuxConnectPayload
  | TmuxDisconnectPayload
  | TmuxResizePayload
  | ListDirPayload
  | CreateWindowPayload
  | ReadFilePayload;

// ── Typed IPC channel names ─────────────────────────────────────────────────

export const DESKTOP_COMMAND_CHANNEL = 'zterm:desktop:command' as const;
export const DESKTOP_SUBSCRIBE_CHANNEL = 'zterm:desktop:event' as const;
export const DESKTOP_GATEWAY_COMMAND_CHANNEL = DESKTOP_COMMAND_CHANNEL;
export const DESKTOP_GATEWAY_EVENT_CHANNEL = DESKTOP_SUBSCRIBE_CHANNEL;

// ── Wire format ─────────────────────────────────────────────────────────────

export interface DesktopCommandWire {
  readonly commandType: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly params?: unknown;
  readonly generation: number;
}

export interface DesktopCommandResultWire {
  readonly commandId: string;
  readonly generation: number;
  readonly outcome: ControlOutcome<DesktopCommandResult>;
}

export interface DesktopGatewayPreloadApi {
  execute<R>(
    commandType: string,
    commandId: string,
    correlationId: string,
    params?: unknown,
  ): Promise<DesktopCommandResultWire>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export type DesktopGatewayInvoke = (channel: string, wire: DesktopCommandWire) => Promise<DesktopCommandResultWire>;
export type DesktopGatewayOn = (
  channel: string,
  listener: (event: unknown, payload: RuntimeEvent) => void,
) => void;
export type DesktopGatewayOff = (
  channel: string,
  listener: (event: unknown, payload: RuntimeEvent) => void,
) => void;

export function createDesktopGatewayPreloadApi(
  invoke: DesktopGatewayInvoke,
  on: DesktopGatewayOn,
  off: DesktopGatewayOff,
): DesktopGatewayPreloadApi {
  let generation = 0;
  return {
    execute<R>(
      commandType: string,
      commandId: string,
      correlationId: string,
      params?: unknown,
    ) {
      generation += 1;
      return invoke(DESKTOP_COMMAND_CHANNEL, {
        commandType,
        commandId,
        correlationId,
        params,
        generation,
      }) as Promise<DesktopCommandResultWire & { outcome: ControlOutcome<R> }>;
    },
    subscribe(listener) {
      const handler = (_event: unknown, payload: RuntimeEvent) => listener(payload);
      on(DESKTOP_SUBSCRIBE_CHANNEL, handler);
      return () => off(DESKTOP_SUBSCRIBE_CHANNEL, handler);
    },
  };
}

/**
 * Positive gate: valid command round-trips with typed result.
 * Negative gate: invalid payload gets explicit error, no silent fallback.
 * Stale gate: response with old generation is rejected, does not update state.
 */
export function isDesktopCommandWire(cmd: unknown): cmd is DesktopCommandWire {
  if (typeof cmd !== 'object' || cmd === null) return false;
  const candidate = cmd as Record<string, unknown>;
  return (
    typeof candidate.commandType === 'string' && candidate.commandType.trim().length > 0 &&
    typeof candidate.commandId === 'string' && candidate.commandId.trim().length > 0 &&
    typeof candidate.correlationId === 'string' && candidate.correlationId.trim().length > 0 &&
    typeof candidate.generation === 'number'
  );
}

export function isDesktopResultWire(res: unknown): res is DesktopCommandResultWire {
  if (typeof res !== 'object' || res === null) return false;
  const candidate = res as Record<string, unknown>;
  return (
    typeof candidate.commandId === 'string' &&
    Number.isSafeInteger(candidate.generation) && (candidate.generation as number) >= 0 &&
    typeof candidate.outcome === 'object' && candidate.outcome !== null &&
    typeof (candidate.outcome as Record<string, unknown>).ok === 'boolean'
  );
}

import type { AccountClient } from '../account-client.js';
import type {
  TerminalBackendKind,
  TerminalSessionCatalog,
  TerminalSnapshotResultPayload,
} from '../../../shared/src/connection/protocol.js';
import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayEndpointCandidate,
} from '../../../shared/src/connection/relay-directory.js';
import {
  normalizeSlotAlias,
  SlotConfigValidationError,
} from '../../../shared/src/connection/cli-slot-config.js';
import {
  ConfigStoreError,
  type SharedConfigStore,
} from '../../../shared/src/node/shared-config.js';
import {
  PromptCancelledError,
  type PromptPort,
} from '../prompts.js';
import {
  SlotStore,
  type CliSlotBinding,
  type SlotListEntry,
} from '../slot-store.js';
import {
  readStoredCliAuth,
  toCommandError,
  type CommandCancelled,
  type CommandError,
  type CommandFailed,
  type StoredCliAuth,
} from './auth.js';

export type SlotWidthMode = CliSlotBinding['widthMode'];

export interface SlotSessionTarget {
  name: string;
  backend: TerminalBackendKind;
  stableId: string;
}

export interface SlotServerChoice {
  deviceId: string;
  daemonHostId: string;
  displayName: string;
  platform: string;
  presence: RelayDirectoryDaemon['presence'];
  endpoints: readonly RelayEndpointCandidate[];
}

export interface SlotConnection {
  listSessions(): Promise<TerminalSessionCatalog>;
  readSnapshot(
    target: SlotSessionTarget,
    maxLines: number,
  ): Promise<TerminalSnapshotResultPayload>;
  close(reason: string): Promise<void>;
}

export interface SlotConnectionFactoryOptions {
  account: StoredCliAuth;
  server: SlotServerChoice;
  signal?: AbortSignal;
}

export type SlotConnectionFactory = (
  options: SlotConnectionFactoryOptions,
) => Promise<SlotConnection>;

export type SlotPreviewRenderer = (
  snapshot: TerminalSnapshotResultPayload,
  target: SlotSessionTarget,
) => void | Promise<void>;

export interface SlotListCommandOptions {
  store: SharedConfigStore;
  signal?: AbortSignal;
}

export type SlotListCommandResult =
  | { kind: 'ok'; value: { slots: SlotListEntry[] } }
  | CommandCancelled
  | CommandFailed;

export interface SlotRenameCommandOptions {
  store: SharedConfigStore;
  slot: number;
  name: string;
  signal?: AbortSignal;
}

export type SlotRenameCommandResult =
  | {
      kind: 'ok';
      value: {
        slot: number;
        binding: CliSlotBinding;
      };
    }
  | CommandCancelled
  | (CommandFailed & { current?: CliSlotBinding });

export interface SelectSlotCommandOptions {
  store: SharedConfigStore;
  prompts: PromptPort;
  signal?: AbortSignal;
}

export type SelectSlotCommandResult =
  | {
      kind: 'ok';
      value: {
        slot: number;
        binding: CliSlotBinding;
      };
    }
  | CommandCancelled
  | CommandFailed;

export interface ResolveSlotCommandOptions {
  store: SharedConfigStore;
  slot: number;
  signal?: AbortSignal;
}

export type ResolveSlotCommandResult =
  | {
      kind: 'ok';
      value: {
        slot: number;
        binding: CliSlotBinding;
      };
    }
  | CommandCancelled
  | CommandFailed;

export interface SlotSetOptions {
  store: SharedConfigStore;
  account: Pick<AccountClient, 'me' | 'directory'>;
  prompts: PromptPort;
  connectionFactory: SlotConnectionFactory;
  renderPreview: SlotPreviewRenderer;
  slot: number;
  widthMode?: SlotWidthMode;
  maxLines?: number;
  signal?: AbortSignal;
}

export type SlotSetResult =
  | {
      kind: 'ok';
      value: {
        slot: number;
        binding: CliSlotBinding;
      };
      cleanupErrors?: CommandError[];
    }
  | (CommandCancelled & { cleanupErrors?: CommandError[] })
  | (CommandFailed & {
      current?: CliSlotBinding;
      cleanupErrors?: CommandError[];
    });

function invalidSlot(slot: number): CommandFailed {
  return {
    kind: 'failed',
    stage: 'validate',
    error: {
      code: 'invalid_slot',
      message: `槽位编号必须是 1 到 20 的整数：${String(slot)}`,
      action: '请使用 zterm slot set <1..20>。',
    },
  };
}

function noSlotsFailure(): CommandFailed {
  return {
    kind: 'failed',
    stage: 'select',
    error: {
      code: 'no_slots',
      message: '没有已配置的槽位。',
      action: '请先运行 zterm slot set <1..20>。',
    },
  };
}

function isCancellation(error: unknown) {
  return error instanceof PromptCancelledError
    || (error instanceof ConfigStoreError && error.code === 'config_aborted')
    || (error instanceof Error && error.name === 'AbortError');
}

function serverChoices(directory: RelayAccountDirectory): SlotServerChoice[] {
  const choices: SlotServerChoice[] = [];
  const identities = new Set<string>();
  for (const device of directory.devices) {
    if (!device.daemon) continue;
    const identity = `${device.deviceId}\u0000${device.daemon.hostId}`;
    if (identities.has(identity)) {
      throw new Error('duplicate daemon server identity');
    }
    identities.add(identity);
    choices.push({
      deviceId: device.deviceId,
      daemonHostId: device.daemon.hostId,
      displayName: device.deviceName.trim() || device.deviceId,
      platform: device.platform,
      presence: device.daemon.presence,
      endpoints: device.daemon.endpoints,
    });
  }
  return choices;
}

function serverLabel(server: SlotServerChoice) {
  const state = server.presence.connected ? '在线' : '离线';
  return `${server.displayName} · ${server.platform} · ${state} · ${server.deviceId}`;
}

function sessionChoices(catalog: TerminalSessionCatalog): SlotSessionTarget[] {
  const choices: SlotSessionTarget[] = [];
  const identities = new Set<string>();
  for (const entry of catalog.sessionCatalog) {
    if (!entry.stableId?.trim() || !entry.name.trim()) continue;
    if (entry.backend !== 'tmux' && entry.backend !== 'herdr') continue;
    const identity = `${entry.backend}\u0000${entry.stableId}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    choices.push({
      name: entry.name,
      backend: entry.backend,
      stableId: entry.stableId,
    });
  }
  return choices;
}

function sessionLabel(session: SlotSessionTarget) {
  return `${session.name} · ${session.backend}`;
}

export function slotDisplayLabel(entry: SlotListEntry): string {
  const alias = entry.binding.alias?.trim();
  const identity = alias
    ? alias
    : `${entry.binding.server.displayName} / ${entry.binding.session.name}`;
  return [
    `槽位 ${entry.slot}`,
    identity,
    entry.binding.server.displayName,
    entry.binding.session.name,
    entry.binding.session.backend,
    entry.binding.widthMode,
  ].join(' · ');
}

function mapFailure(stage: string, error: unknown, code: string, message: string): CommandFailed {
  return {
    kind: 'failed',
    stage,
    error: toCommandError(stage, error, code, message),
  };
}

export async function slotListCommand(
  options: SlotListCommandOptions,
): Promise<SlotListCommandResult> {
  try {
    const slots = await new SlotStore(options.store).list(options.signal);
    return { kind: 'ok', value: { slots } };
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'list' };
    return mapFailure('list', error, 'slot_list_failed', '无法读取本地槽位。');
  }
}

export async function slotRenameCommand(
  options: SlotRenameCommandOptions,
): Promise<SlotRenameCommandResult> {
  if (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > 20) {
    return invalidSlot(options.slot);
  }

  try {
    normalizeSlotAlias(options.name);
  } catch (error) {
    if (error instanceof SlotConfigValidationError) {
      return {
        kind: 'failed',
        stage: 'validate',
        error: {
          code: 'invalid_alias',
          message: '槽位别名无效。',
          action: '请使用 1 到 80 个字符，且不要包含控制字符。',
        },
      };
    }
    return mapFailure('validate', error, 'invalid_alias', '槽位别名无效。');
  }

  const slotStore = new SlotStore(options.store);
  let original: CliSlotBinding | undefined;
  try {
    original = await slotStore.read(options.slot, options.signal);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'read' };
    return mapFailure('read', error, 'slot_read_failed', '无法读取槽位。');
  }
  if (!original) {
    return {
      kind: 'failed',
      stage: 'rename',
      error: {
        code: 'slot_not_found',
        message: `槽位 ${options.slot} 未配置。`,
        action: '请先运行 zterm slot set <1..20>。',
      },
    };
  }

  try {
    const result = await slotStore.renameIfUnchanged({
      slot: options.slot,
      expectedOriginal: original,
      alias: options.name,
      signal: options.signal,
    });
    if (result.kind === 'slot_missing') {
      return {
        kind: 'failed',
        stage: 'rename',
        error: {
          code: 'slot_not_found',
          message: `槽位 ${options.slot} 未配置。`,
          action: '请先运行 zterm slot set <1..20>。',
        },
      };
    }
    if (result.kind === 'slot_changed') {
      return {
        kind: 'failed',
        stage: 'save',
        error: {
          code: 'slot_changed',
          message: '槽位已被其他进程修改，本次别名未覆盖。',
          action: '请重新运行 zterm slot rename。',
        },
        current: result.current,
      };
    }
    return { kind: 'ok', value: { slot: result.slot, binding: result.binding } };
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'save' };
    return mapFailure('save', error, 'slot_rename_failed', '无法保存槽位别名。');
  }
}

export async function selectSlotCommand(
  options: SelectSlotCommandOptions,
): Promise<SelectSlotCommandResult> {
  const slotStore = new SlotStore(options.store);
  let slots: SlotListEntry[];
  try {
    slots = await slotStore.list(options.signal);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'select' };
    return mapFailure('select', error, 'slot_list_failed', '无法读取本地槽位。');
  }
  if (slots.length === 0) return noSlotsFailure();

  let selectedSlot: number;
  try {
    selectedSlot = await options.prompts.select(
      '选择槽位',
      slots.map((entry) => ({
        label: slotDisplayLabel(entry),
        value: entry.slot,
      })),
    );
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'select' };
    return mapFailure('select', error, 'slot_select_failed', '无法选择槽位。');
  }

  try {
    const binding = await slotStore.read(selectedSlot, options.signal);
    if (!binding) {
      return {
        kind: 'failed',
        stage: 'select',
        error: {
          code: 'slot_not_found',
          message: '所选槽位已不存在。',
          action: '请重新运行 zterm。',
        },
      };
    }
    return { kind: 'ok', value: { slot: selectedSlot, binding } };
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'select' };
    return mapFailure('select', error, 'slot_read_failed', '无法读取所选槽位。');
  }
}

export async function resolveSlotCommand(
  options: ResolveSlotCommandOptions,
): Promise<ResolveSlotCommandResult> {
  if (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > 20) {
    return invalidSlot(options.slot);
  }
  try {
    const binding = await new SlotStore(options.store).read(options.slot, options.signal);
    if (!binding) {
      return {
        kind: 'failed',
        stage: 'resolve',
        error: {
          code: 'slot_not_found',
          message: `槽位 ${options.slot} 未配置。`,
          action: '请先运行 zterm slot set <1..20>。',
        },
      };
    }
    return { kind: 'ok', value: { slot: options.slot, binding } };
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'resolve' };
    return mapFailure('resolve', error, 'slot_read_failed', '无法读取槽位。');
  }
}

export async function slotSetCommand(options: SlotSetOptions): Promise<SlotSetResult> {
  if (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > 20) {
    return invalidSlot(options.slot);
  }

  const signal = options.signal ?? new AbortController().signal;
  const slotStore = new SlotStore(options.store);
  let original: CliSlotBinding | undefined;
  try {
    original = await slotStore.read(options.slot, signal);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'read' };
    return mapFailure('read', error, 'slot_read_failed', '无法读取原槽位。');
  }

  let auth: StoredCliAuth | undefined;
  try {
    auth = await readStoredCliAuth(options.store, signal);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'auth' };
    return mapFailure('auth', error, 'auth_config_invalid', '无法读取本机登录态。');
  }
  if (!auth) {
    return {
      kind: 'failed',
      stage: 'auth',
      error: {
        code: 'auth_required',
        message: '尚未登录或本机登录态缺少服务器配置。',
        action: '请先运行 zterm login。',
      },
    };
  }

  let directory: RelayAccountDirectory;
  try {
    const accountSession = {
      relayBaseUrl: auth.relayBaseUrl,
      accessToken: auth.accessToken,
    };
    const account = await options.account.me(accountSession, signal);
    if (account.user.id !== auth.userId) {
      return {
        kind: 'failed',
        stage: 'account',
        error: {
          code: 'auth_account_changed',
          message: '当前登录账号与本机记录不一致。',
          action: '请重新运行 zterm login。',
        },
      };
    }
    directory = await options.account.directory(accountSession, signal);
    if (directory.user.id !== auth.userId) {
      return {
        kind: 'failed',
        stage: 'account',
        error: {
          code: 'auth_account_changed',
          message: '服务器目录不属于当前登录账号。',
          action: '请重新运行 zterm login。',
        },
      };
    }
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'account' };
    return mapFailure('account', error, 'directory_failed', '无法读取账号服务器目录。');
  }

  let servers: SlotServerChoice[];
  try {
    servers = serverChoices(directory);
  } catch (error) {
    return mapFailure('servers', error, 'directory_invalid', '服务器目录包含重复身份。');
  }
  if (servers.length === 0) {
    return {
      kind: 'failed',
      stage: 'servers',
      error: {
        code: 'no_servers',
        message: '账号目录中没有运行 daemon 的服务器。',
        action: '请先启动 daemon 并刷新账号目录。',
      },
    };
  }

  const cleanupErrors: CommandError[] = [];

  while (true) {
    let serverIndex: number;
    try {
      serverIndex = await options.prompts.select(
        '选择服务器',
        servers.map((server, index) => ({ label: serverLabel(server), value: index })),
      );
    } catch (error) {
      if (isCancellation(error)) return { kind: 'cancelled', stage: 'server' };
      return mapFailure('server', error, 'server_select_failed', '无法选择服务器。');
    }
    const server = servers[serverIndex];
    if (!server) {
      return mapFailure(
        'server',
        new Error('selected server index is invalid'),
        'server_select_failed',
        '服务器选择无效。',
      );
    }

    let connection: SlotConnection;
    try {
      connection = await options.connectionFactory({ account: auth, server, signal });
    } catch (error) {
      if (isCancellation(error)) return { kind: 'cancelled', stage: 'connection' };
      return mapFailure('connection', error, 'connection_failed', '无法建立目标连接。');
    }

    let closeAttempted = false;
    const closeOnce = async (): Promise<boolean> => {
      if (closeAttempted) return true;
      closeAttempted = true;
      try {
        await connection.close('slot-configure-complete');
        return true;
      } catch (error) {
        cleanupErrors.push(
          toCommandError('cleanup', error, 'connection_close_failed', '无法关闭本次连接。'),
        );
        return false;
      }
    };
    const finish = async (result: SlotSetResult): Promise<SlotSetResult> => {
      await closeOnce();
      if (cleanupErrors.length === 0) return result;
      return { ...result, cleanupErrors: [...cleanupErrors] };
    };

    try {
      while (true) {
        let sessions: SlotSessionTarget[];
        try {
          sessions = sessionChoices(await connection.listSessions());
        } catch (error) {
          return await finish(
            isCancellation(error)
              ? { kind: 'cancelled', stage: 'sessions' }
              : mapFailure('sessions', error, 'session_list_failed', '无法读取 session 列表。'),
          );
        }
        if (sessions.length === 0) {
          return await finish({
            kind: 'failed',
            stage: 'sessions',
            error: {
              code: 'stable_session_unavailable',
              message: '没有同时提供 backend 和 stableId 的可绑定 session。',
              action: '请确认 daemon backend 支持稳定 session 身份。',
            },
          });
        }

        let sessionIndex: number;
        try {
          sessionIndex = await options.prompts.select(
            '选择 session',
            sessions.map((session, index) => ({
              label: sessionLabel(session),
              value: index,
            })),
          );
        } catch (error) {
          return await finish(
            isCancellation(error)
              ? { kind: 'cancelled', stage: 'session' }
              : mapFailure('session', error, 'session_select_failed', '无法选择 session。'),
          );
        }
        const session = sessions[sessionIndex];
        if (!session) {
          return await finish(mapFailure(
            'session',
            new Error('selected session index is invalid'),
            'session_select_failed',
            'session 选择无效。',
          ));
        }

        try {
          const wantsPreview = await options.prompts.confirm('预览 snapshot？');
          if (wantsPreview) {
            const preview = await connection.readSnapshot(session, options.maxLines ?? 80);
            if (preview.status === 'failed') {
              return await finish({
                kind: 'failed',
                stage: 'preview',
                error: {
                  code: preview.code,
                  message: preview.code === 'session_not_found'
                    ? '预览时 session 已不存在。'
                    : '预览时 session 身份已改变。',
                  action: '请重新读取 session 列表后重试。',
                },
              });
            }
            if (
              preview.status === 'available'
              && (preview.backend !== session.backend || preview.stableId !== session.stableId)
            ) {
              return await finish({
                kind: 'failed',
                stage: 'preview',
                error: {
                  code: 'snapshot_identity_mismatch',
                  message: 'snapshot 身份与所选 session 不一致。',
                  action: '请重新读取 session 列表后重试。',
                },
              });
            }
            await options.renderPreview(preview, session);
          }
        } catch (error) {
          return await finish(
            isCancellation(error)
              ? { kind: 'cancelled', stage: 'preview' }
              : mapFailure('preview', error, 'preview_failed', '无法预览 snapshot。'),
          );
        }

        let action: 'save' | 'sessions' | 'servers' | 'exit';
        try {
          action = await options.prompts.select<'save' | 'sessions' | 'servers' | 'exit'>(
            `配置槽位 ${options.slot}`,
            [
              { label: `保存到槽位 ${options.slot}`, value: 'save' },
              { label: '重新选择 session', value: 'sessions' },
              { label: '返回服务器选择', value: 'servers' },
              { label: '退出配置', value: 'exit' },
            ],
          );
        } catch (error) {
          return await finish(
            isCancellation(error)
              ? { kind: 'cancelled', stage: 'action' }
              : mapFailure('action', error, 'action_select_failed', '无法选择下一步操作。'),
          );
        }

        if (action === 'sessions') continue;
        if (action === 'servers') {
          if (!await closeOnce()) {
            return {
              kind: 'failed',
              stage: 'cleanup',
              error: {
                code: 'connection_close_failed',
                message: '无法关闭本次连接。',
                action: '请检查连接状态后重试 zterm slot set。',
              },
              cleanupErrors: [...cleanupErrors],
            };
          }
          break;
        }
        if (action === 'exit') {
          return await finish({ kind: 'cancelled', stage: 'exit' });
        }

        const binding: CliSlotBinding = {
          ...(original?.alias === undefined ? {} : { alias: original.alias }),
          account: {
            relayBaseUrl: auth.relayBaseUrl,
            userId: auth.userId,
          },
          server: {
            deviceId: server.deviceId,
            daemonHostId: server.daemonHostId,
            displayName: server.displayName,
          },
          session: {
            backend: session.backend,
            stableId: session.stableId,
            name: session.name,
          },
          widthMode: options.widthMode ?? original?.widthMode ?? 'adaptive-phone',
        };

        let result: SlotSetResult;
        try {
          const saved = await slotStore.saveIfUnchanged({
            slot: options.slot,
            expected: original,
            binding,
            signal,
          });
          if (saved.kind === 'slot_changed') {
            result = {
              kind: 'failed',
              stage: 'save',
              error: {
                code: 'slot_changed',
                message: '槽位已被其他进程修改，本次草稿未覆盖。',
                action: '请重新运行 zterm slot set 并确认最新绑定。',
              },
              current: saved.current,
            };
          } else {
            result = {
              kind: 'ok',
              value: {
                slot: options.slot,
                binding: saved.binding,
              },
            };
          }
        } catch (error) {
          result = isCancellation(error)
            ? { kind: 'cancelled', stage: 'save' }
            : mapFailure('save', error, 'slot_save_failed', '无法保存槽位。');
        }
        return await finish(result);
      }
    } catch (error) {
      return await finish(
        isCancellation(error)
          ? { kind: 'cancelled', stage: 'command' }
          : mapFailure('command', error, 'slot_command_failed', '槽位配置未完成。'),
      );
    }
  }
}

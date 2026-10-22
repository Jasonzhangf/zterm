import {
  AccountClientError,
  type AccountClient,
  type AuthSession,
} from '../account-client.js';
import {
  SlotConfigValidationError,
  projectSyncedSlot,
  type CloudSlotResponse,
  type SyncedSlot,
  type SyncedSlotBinding,
} from '../../../shared/src/connection/cli-slot-config.js';
import {
  ConfigStoreError,
  type SharedConfigStore,
} from '../../../shared/src/node/shared-config.js';
import {
  SlotStore,
  type CliSlotBinding,
  type SlotSyncBaseline,
  type SlotSyncScope,
} from '../slot-store.js';
import {
  toCommandError,
  type CommandError,
  type StoredCliAuth,
} from './auth.js';

const NEVER_ABORTED = new AbortController().signal;

export interface SlotSyncCommandOptions {
  store: SharedConfigStore;
  account: Pick<AccountClient, 'readSlotConfig' | 'replaceSlotConfig' | 'replaceSlot'>;
  direction: 'pull' | 'push';
  scope: SlotSyncScope;
  signal?: AbortSignal;
}

export type SlotSyncCommandResult =
  | {
      kind: 'ok';
      direction: 'pull' | 'push';
      scope: SlotSyncScope;
      count: number;
    }
  | { kind: 'cancelled'; stage: string }
  | { kind: 'failed'; stage: string; error: CommandError };

export async function slotSyncCommand(
  options: SlotSyncCommandOptions,
): Promise<SlotSyncCommandResult> {
  if (options.signal?.aborted) return cancelled('preflight');

  const scope = normalizeScope(options.scope);
  if (!scope) {
    return failure('validate', {
      code: 'invalid_scope',
      message: '槽位同步范围无效。',
      action: '请使用 1 到 20 的槽位号或 --all。',
    });
  }

  if (options.direction === 'pull') return pull(options, scope);
  if (options.direction === 'push') return push(options, scope);
  return failure('validate', {
    code: 'invalid_direction',
    message: '槽位同步方向无效。',
    action: '请使用 pull 或 push。',
  });
}

function normalizeScope(scope: unknown): SlotSyncScope | undefined {
  if (scope === null || typeof scope !== 'object') return undefined;
  const value = scope as { kind?: unknown; slot?: unknown };
  if (value.kind === 'all') return { kind: 'all' };
  if (
    value.kind === 'one'
    && typeof value.slot === 'number'
    && Number.isInteger(value.slot)
    && value.slot >= 1
    && value.slot <= 20
  ) {
    return { kind: 'one', slot: value.slot };
  }
  return undefined;
}

async function pull(
  options: SlotSyncCommandOptions,
  scope: SlotSyncScope,
): Promise<SlotSyncCommandResult> {
  const slots = new SlotStore(options.store);
  let baseline: SlotSyncBaseline | undefined;
  try {
    baseline = await slots.readSyncBaseline(scope, options.signal);
  } catch (error) {
    if (isCancellationError(error)) return cancelled('read');
    return mapFailure('read', error, 'slot_sync_read_failed', '无法读取本地槽位。');
  }
  if (!baseline) return loginRequired('pull');

  const auth = baseline.account.auth;
  let response: CloudSlotResponse;
  try {
    response = await options.account.readSlotConfig(
      authSession(auth),
      options.signal ?? NEVER_ABORTED,
    );
  } catch (error) {
    if (isCancellationError(error)) return cancelled('read');
    return mapFailure('read', error, 'slot_pull_failed', '无法读取云端槽位。');
  }

  if (response.userId !== auth.userId) {
    return failure('read', {
      code: 'cloud_account_mismatch',
      message: '云端返回的账号与当前登录账号不一致，未修改本地槽位。',
      action: '请重新登录或确认 relay 地址后重试。',
    });
  }
  if (!response.config.configured) {
    return failure('read', {
      code: 'cloud_config_missing',
      message: '云端尚未配置槽位，本地槽位未修改。',
      action: '请先运行 zterm slot push <1..20> 或 zterm slot push --all 创建云端配置。',
    });
  }

  const cloudSlots = response.config.slots;
  try {
    const applied = await slots.applyPulledSlots({
      baseline,
      slots: cloudSlots,
      signal: options.signal,
    });
    if (applied.kind === 'saved') {
      return {
        kind: 'ok',
        direction: 'pull',
        scope: baseline.scope,
        count: baseline.scope.kind === 'one' ? 1 : cloudSlots.length,
      };
    }
    if (applied.kind === 'auth_changed') {
      return failure('commit', {
        code: 'auth_changed',
        message: '登录状态已变化，本次拉取未修改本地槽位。',
        action: '请确认当前账号后重新运行 zterm slot pull。',
      });
    }
    if (applied.kind === 'slot_changed') {
      return failure('commit', {
        code: 'slot_changed',
        message: '本地槽位在拉取期间已变化，本次未覆盖。',
        action: '请确认本地槽位后重新运行 zterm slot pull。',
      });
    }
    if (applied.kind === 'foreign_slot_conflict') {
      return failure('commit', {
        code: 'foreign_slot_conflict',
        message: `云端槽位与本地其他账号的槽位冲突：${applied.slots.join('、')}。未写入任何槽位。`,
        action: '请先处理冲突槽位后重试。',
      });
    }
    return failure('read', {
      code: 'cloud_slot_missing',
      message: baseline.scope.kind === 'one'
        ? `云端没有槽位 ${baseline.scope.slot}，本地槽位未修改。`
        : '云端槽位缺失，本地槽位未修改。',
      action: '请确认云端槽位号后重试。',
    });
  } catch (error) {
    if (isCancellationError(error)) return cancelled('commit');
    if (error instanceof SlotConfigValidationError) {
      return failure('validate', {
        code: 'invalid_slot_config',
        message: '云端槽位数据未通过校验，本地槽位未修改。',
        action: '请检查 relay 服务版本或稍后重试。',
      });
    }
    return mapFailure('commit', error, 'slot_pull_failed', '无法保存云端槽位。');
  }
}

async function push(
  options: SlotSyncCommandOptions,
  scope: SlotSyncScope,
): Promise<SlotSyncCommandResult> {
  const slots = new SlotStore(options.store);
  let baseline: SlotSyncBaseline | undefined;
  try {
    baseline = await slots.readSyncBaseline(scope, options.signal);
  } catch (error) {
    if (isCancellationError(error)) return cancelled('read');
    return mapFailure('read', error, 'slot_sync_read_failed', '无法读取本地槽位。');
  }
  if (!baseline) return loginRequired('push');

  const auth = baseline.account.auth;
  let selected: Array<{ slot: number; binding: CliSlotBinding }>;
  if (scope.kind === 'one') {
    const entry = baseline.entries.find((item) => item.slot === scope.slot);
    if (!entry) {
      return failure('select', {
        code: 'slot_missing',
        message: `本地槽位 ${scope.slot} 未配置，未推送。`,
        action: '请先运行 zterm slot set <1..20> 配置槽位。',
      });
    }
    if (!sameAccount(entry.binding, auth)) {
      return failure('select', {
        code: 'slot_account_mismatch',
        message: `本地槽位 ${scope.slot} 属于其他账号，未推送。`,
        action: '请登录该槽位所属账号，或选择当前账号的槽位后重试。',
      });
    }
    selected = [entry];
  } else {
    selected = baseline.entries.filter((entry) => sameAccount(entry.binding, auth));
  }

  let projected: SyncedSlot[];
  try {
    projected = selected.map((entry) => projectSyncedSlot(entry.slot, entry.binding));
  } catch (error) {
    if (error instanceof SlotConfigValidationError) {
      return failure('validate', {
        code: 'invalid_slot_config',
        message: '本地槽位数据未通过校验，未推送。',
        action: '请修正本地槽位后重试。',
      });
    }
    return mapFailure('validate', error, 'invalid_slot_config', '本地槽位数据无效，未推送。');
  }

  try {
    const check = await slots.checkSyncBaseline(baseline, options.signal);
    if (check.kind === 'auth_changed') {
      return failure('preflight', {
        code: 'auth_changed',
        message: '登录状态已变化，本次推送未发出。',
        action: '请确认当前账号后重新运行 zterm slot push。',
      });
    }
    if (check.kind === 'slot_changed') {
      return failure('preflight', {
        code: 'slot_changed',
        message: '本地槽位在推送前已变化，本次推送未发出。',
        action: '请确认本地槽位后重新运行 zterm slot push。',
      });
    }
  } catch (error) {
    if (isCancellationError(error)) return cancelled('preflight');
    return mapFailure('preflight', error, 'slot_sync_read_failed', '无法确认本地槽位状态。');
  }

  const signal = options.signal ?? NEVER_ABORTED;
  try {
    const response = scope.kind === 'one'
      ? await options.account.replaceSlot(
        authSession(auth),
        scope.slot,
        bindingWithoutSlot(projected[0]),
        signal,
      )
      : await options.account.replaceSlotConfig(
        authSession(auth),
        projected,
        signal,
      );
    if (response.userId !== auth.userId) return remoteUnknown();
    return {
      kind: 'ok',
      direction: 'push',
      scope: baseline.scope,
      count: projected.length,
    };
  } catch (error) {
    return pushWriteFailure(error);
  }
}

function bindingWithoutSlot(slot: SyncedSlot): SyncedSlotBinding {
  return {
    ...(slot.alias === undefined ? {} : { alias: slot.alias }),
    server: slot.server,
    session: slot.session,
    widthMode: slot.widthMode,
  };
}

function authSession(auth: StoredCliAuth): AuthSession {
  return {
    relayBaseUrl: auth.relayBaseUrl,
    accessToken: auth.accessToken,
  };
}

function sameAccount(binding: unknown, auth: StoredCliAuth): boolean {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return false;
  }
  const account = (binding as { account?: unknown }).account;
  if (account === null || typeof account !== 'object' || Array.isArray(account)) {
    return false;
  }
  const record = account as Record<string, unknown>;
  return record.relayBaseUrl === auth.relayBaseUrl
    && record.userId === auth.userId;
}

function loginRequired(direction: 'pull' | 'push'): SlotSyncCommandResult {
  return failure('auth', {
    code: 'login_required',
    message: direction === 'pull'
      ? '未登录，无法拉取云端槽位。'
      : '未登录，无法推送本地槽位。',
    action: '请先运行 zterm login。',
  });
}

function pushWriteFailure(error: unknown): SlotSyncCommandResult {
  if (error instanceof AccountClientError) {
    if (error.code === 'cancelled' && error.requestDispatched === false) {
      return cancelled('write');
    }
    if (error.requestDispatched === false) {
      return mapFailure('write', error, 'slot_push_failed', '无法推送本地槽位。');
    }
    if (error.definitiveRejection) {
      return mapFailure('write', error, 'slot_push_failed', '云端拒绝了本次推送。');
    }
  }
  return remoteUnknown();
}

function remoteUnknown(): SlotSyncCommandResult {
  return failure('write', {
    code: 'remote_commit_unknown',
    message: '云端写入结果无法确认，本次推送可能已生效。',
    action: '请先重新读取云端槽位确认当前内容，再决定是否再次推送。',
  });
}

function isCancellationError(error: unknown): boolean {
  return (error instanceof AccountClientError && error.code === 'cancelled')
    || (error instanceof ConfigStoreError && error.code === 'config_aborted')
    || (error instanceof Error && error.name === 'AbortError');
}

function cancelled(stage: string): SlotSyncCommandResult {
  return { kind: 'cancelled', stage };
}

function failure(stage: string, error: CommandError): SlotSyncCommandResult {
  return { kind: 'failed', stage, error };
}

function mapFailure(
  stage: string,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): SlotSyncCommandResult {
  return failure(stage, toCommandError(stage, error, fallbackCode, fallbackMessage));
}

import { basename } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { AccountClient, type AuthenticatedAccount } from './account-client.js';
import {
  createApplicationConnection,
} from './application-connection.js';
import type { SessionConnection } from './connection.js';
import { createAnsiProjection } from './ansi-projection.js';
import {
  loginCommand,
  logoutCommand,
  readStoredCliAuth,
  toCommandError,
  type CommandError,
  type StoredCliAuth,
} from './commands/auth.js';
import {
  matchServerChoice,
  matchSessionChoice,
  resolveSlotCommand,
  selectSlotCommand,
  serverChoices,
  sessionChoices,
  slotDisplayLabel,
  slotListCommand,
  slotRenameCommand,
  slotSetCommand,
  type SlotConnection,
  type SlotConnectionFactory,
  type SlotPreviewRenderer,
  type SlotServerChoice,
  type SlotSessionTarget,
} from './commands/slots.js';
import {
  slotSyncCommand,
  type SlotSyncCommandResult,
} from './commands/slot-sync.js';
import {
  getDaemonConfig,
  getDaemonStatus,
  installDaemon,
} from './daemon-management.js';
import { createNodePrompts, type PromptPort } from './prompts.js';
import { createRendererWindow } from './renderer-window.js';
import { runExecSession } from './exec-session.js';
import {
  installSkill,
  readBundledSkill,
  type SkillInstallTarget,
} from './commands/skill.js';
import { upgradeCli } from './release.js';
import { APP_HELP, runAppCommand } from './commands/app-messaging.js';
import type {
  CliSlotBinding,
  SlotListEntry,
  SlotSyncScope,
} from './slot-store.js';
import { runTerminalSession } from './terminal-session.js';
import type {
  RelayAccountDirectory,
  RelayEndpointCandidate,
} from '../../shared/src/connection/relay-directory.js';
import type {
  TerminalSessionCatalog,
  TerminalSnapshotResultPayload,
} from '../../shared/src/connection/protocol.js';
import { normalizeWireLines } from '../../shared/src/connection/terminal-buffer.js';
import { SharedConfigStore } from '../../shared/src/node/shared-config.js';

declare const __ZTERM_CLI_VERSION__: string;

const CLI_VERSION = typeof __ZTERM_CLI_VERSION__ === 'string'
  ? __ZTERM_CLI_VERSION__
  : '0.0.0';

const HELP = `用法：
  zterm <slot>
  zterm
  zterm list
  zterm exec <slot|--device <nameOrId>> [--session <name>] [--timeout <ms>] [--] <command...>
  zterm session list <slot|--device <nameOrId>>
  zterm session create <slot|--device <nameOrId>> <sessionName> [--cwd <path>]
  zterm session rename <slot|--device <nameOrId>> <sessionName> <nextSessionName>
  zterm session delete <slot|--device <nameOrId>> <sessionName>
  zterm skill install [--target all|agents|gemini|codex|project] [--dir <path>]
  zterm skill show
  zterm login [--from-config]
  zterm logout
  zterm slot list
  zterm slot rename <slot> <name>
  zterm slot pull <slot>
  zterm slot pull --all
  zterm slot push <slot>
  zterm slot push --all
  zterm slot set <slot> [--device <nameOrId>] [--session <name>] [--alias <name>] [--width-mode adaptive-phone|mirror-fixed]
  zterm upgrade [--registry <url>]
  zterm daemon install [--version <version>] [--registry <url>]
  zterm daemon status
  zterm daemon config
  zterm app stream|send|send-file|status|ack|consume
  zterm --help
  zterm --version
`;

const SLOT_HELP = `用法：
  zterm slot list
  zterm slot rename <slot> <name>
  zterm slot pull <slot>
  zterm slot pull --all
  zterm slot push <slot>
  zterm slot push --all
  zterm slot set <slot> [--device <nameOrId>] [--session <name>] [--alias <name>] [--width-mode adaptive-phone|mirror-fixed]
  zterm slot --help
`;

const EXEC_HELP = `用法：
  zterm exec <slot> [--session <name>] [--timeout <ms>] [--] <command...>
  zterm exec --device <nameOrId> [--session <name>] [--timeout <ms>] [--] <command...>

非交互式在远端会话执行命令，输出 stdout 并返回命令真实退出码（超时默认 30000ms，返回 124）。
`;

const SESSION_HELP = `用法：
  zterm session list <slot|--device <nameOrId>>
  zterm session create <slot|--device <nameOrId>> <sessionName> [--cwd <path>]
  zterm session rename <slot|--device <nameOrId>> <sessionName> <nextSessionName>
  zterm session delete <slot|--device <nameOrId>> <sessionName>

在远端机器上查看、创建、重命名或删除 session（tmux）。
`;

const SKILL_HELP = `用法：
  zterm skill install [--target all|agents|gemini|codex|project] [--dir <path>]
  zterm skill show

安装或查看随 @jsonstudio/zterm-cli 自带的 zterm-cli Agent Skill。
默认 --target all 会写入 ~/.agents/skills/zterm-cli/、~/.gemini/config/skills/zterm-cli/ 与 ~/.codex/skills/zterm-cli/。
`;

const SLOT_LIST_HELP = `用法：
  zterm list
  zterm slot list

列出本地已配置的槽位（slot >= 1，无上限）；已登录时同时显示 Relay 上所有设备的在线状态、IP/endpoint、session 以及槽位绑定关系。
可用 zterm slot rename <slot> <name> 为槽位设置或修改本地别名。
`;

const SLOT_RENAME_HELP = `用法：
  zterm slot rename <slot> <name>

只修改本地槽位别名，不修改绑定的机器或 session，也不需要登录。
名称包含空格时请使用引号，例如：zterm slot rename 1 "工作台"。
`;

const SLOT_PULL_HELP = `用法：
  zterm slot pull <slot>
  zterm slot pull --all

pull <slot>  用云端槽位 N 替换本地槽位 N。
pull --all   用当前账号的云端配置替换该账号的本地槽位；
             删除该账号在云端不存在的本地槽位。
             已配置的空云端列表会清空该账号的本地槽位。
尚未配置云端列表时，pull 不修改本地配置。
同步只复制别名、绑定和宽度设置，不复制登录信息，也不连接或创建 session。
`;

const SLOT_PUSH_HELP = `用法：
  zterm slot push <slot>
  zterm slot push --all

push <slot>  用本地槽位 N 替换当前账号的云端槽位 N，保留其他云端槽位。
push --all   用当前账号的本地槽位替换该账号全部云端槽位；
             空本地列表会清空该账号的云端槽位。
同步只复制别名、绑定和宽度设置，不复制登录信息，也不连接或创建 session。
`;

export type MainAccountClient =
  & Pick<AccountClient, 'login' | 'me' | 'directory'>
  & Partial<Pick<AccountClient, 'readSlotConfig' | 'replaceSlotConfig' | 'replaceSlot'>>;

type CloudSlotAccountClient = Pick<
  AccountClient,
  'readSlotConfig' | 'replaceSlotConfig' | 'replaceSlot'
>;

export interface MainOptions {
  store?: SharedConfigStore;
  accountClient?: MainAccountClient;
  prompts?: PromptPort;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  connectionFactory?: typeof createApplicationConnection;
  upgrade?: typeof upgradeCli;
  daemonInstall?: typeof installDaemon;
  daemonStatus?: typeof getDaemonStatus;
  daemonConfig?: typeof getDaemonConfig;
  runTerminal?: typeof runTerminalSession;
  runExec?: typeof runExecSession;
}

interface MainContext {
  store: SharedConfigStore;
  accountClient: MainAccountClient;
  prompts: PromptPort;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  connectionFactory: typeof createApplicationConnection;
  upgrade: typeof upgradeCli;
  daemonInstall: typeof installDaemon;
  daemonStatus: typeof getDaemonStatus;
  daemonConfig: typeof getDaemonConfig;
  runTerminal: typeof runTerminalSession;
  runExec: typeof runExecSession;
}

interface UsageError {
  usageMessage: string;
}

class MainCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: string,
  ) {
    super(message);
    this.name = 'MainCommandError';
  }
}

function write(stream: Writable, text: string) {
  stream.write(text);
}

function writeLine(stream: Writable, text: string) {
  write(stream, text.endsWith('\n') ? text : `${text}\n`);
}

function usageFailure(message: string): UsageError {
  return { usageMessage: message };
}

function isUsageError(value: unknown): value is UsageError {
  return Boolean(
    value
    && typeof value === 'object'
    && 'usageMessage' in value
    && typeof (value as UsageError).usageMessage === 'string',
  );
}

function parseSlot(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function optionValue(args: string[], name: string): string | undefined | UsageError {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (args.indexOf(name, index + 1) !== -1) {
    return usageFailure(`${name} 需要一个值，且不能重复。`);
  }
  const value = args[index + 1];
  return value && !value.startsWith('--')
    ? value
    : usageFailure(`${name} 需要一个值。`);
}

function printCommandFailure(
  result: {
    stage: string;
    error: CommandError;
  },
  stderr: Writable,
) {
  writeLine(stderr, result.error.message);
  if (result.error.action) {
    writeLine(stderr, result.error.action);
  }
}

function cleanupFailure(errors: readonly CommandError[] | undefined, stderr: Writable) {
  for (const error of errors ?? []) {
    writeLine(stderr, error.message);
    if (error.action) writeLine(stderr, error.action);
  }
}

function commandExitCode(result: { kind: string; error?: CommandError }): number {
  if (result.kind === 'ok') return 0;
  if (result.kind === 'cancelled') return 130;
  if (result.error?.code === 'invalid_slot') return 2;
  return 1;
}

function mapUnknownError(error: unknown, fallback = '命令执行失败。') {
  if (error instanceof MainCommandError) {
    return {
      code: error.code,
      message: error.message,
      action: error.action,
    };
  }
  return toCommandError('main', error, 'command_failed', fallback);
}

function printMappedError(error: unknown, stderr: Writable, fallback?: string) {
  const mapped = mapUnknownError(error, fallback);
  writeLine(stderr, mapped.message);
  if (mapped.action) writeLine(stderr, mapped.action);
}

function authSession(auth: StoredCliAuth) {
  return {
    relayBaseUrl: auth.relayBaseUrl,
    accessToken: auth.accessToken,
  };
}

async function refreshAuthenticatedAccount(
  auth: StoredCliAuth,
  accountClient: Pick<AccountClient, 'me' | 'directory'>,
  signal: AbortSignal,
): Promise<AuthenticatedAccount> {
  const session = authSession(auth);
  const account = await accountClient.me(session, signal);
  if (
    account.relayBaseUrl !== auth.relayBaseUrl
    || account.user.id !== auth.userId
  ) {
    throw new MainCommandError(
      'auth_account_changed',
      '当前登录账号与本机记录不一致。',
      '请重新运行 zterm login。',
    );
  }
  const directory = await accountClient.directory(session, signal);
  if (directory.user.id !== auth.userId) {
    throw new MainCommandError(
      'auth_account_changed',
      '服务器目录不属于当前登录账号。',
      '请重新运行 zterm login。',
    );
  }
  return { ...account, directory };
}

function exactServer(
  account: AuthenticatedAccount,
  server: { deviceId: string; daemonHostId: string },
) {
  const matches = account.directory.devices.filter(
    (device) => device.deviceId === server.deviceId,
  );
  const device = matches.length === 1 ? matches[0] : undefined;
  if (!device?.daemon || device.daemon.hostId !== server.daemonHostId) {
    throw new MainCommandError(
      'server_identity_changed',
      '槽位绑定的服务器已变化或不再可从当前账号访问。',
      '请重新运行 zterm slot set <slot>。',
    );
  }
  return device;
}

function validateBinding(binding: CliSlotBinding) {
  if (
    !binding.account.relayBaseUrl
    || !binding.account.userId
    || !binding.server.deviceId
    || !binding.server.daemonHostId
    || !binding.session.stableId
    || !binding.session.name
    || (binding.session.backend !== 'tmux' && binding.session.backend !== 'herdr')
    || (binding.widthMode !== 'adaptive-phone' && binding.widthMode !== 'mirror-fixed')
  ) {
    throw new MainCommandError(
      'slot_invalid',
      '槽位绑定缺少完整的账号、服务器或 session 身份。',
      '请重新运行 zterm slot set <slot>。',
    );
  }
}

async function prepareSlotAccount(
  auth: StoredCliAuth,
  binding: CliSlotBinding,
  accountClient: Pick<AccountClient, 'me' | 'directory'>,
  signal: AbortSignal,
) {
  if (
    auth.relayBaseUrl !== binding.account.relayBaseUrl
    || auth.userId !== binding.account.userId
  ) {
    throw new MainCommandError(
      'slot_auth_mismatch',
      '槽位绑定的账号与当前登录态不一致。',
      '请重新登录或重新配置该槽位。',
    );
  }
  const account = await refreshAuthenticatedAccount(auth, accountClient, signal);
  exactServer(account, binding.server);
  return account;
}

function sessionCatalog(
  sessions: Awaited<ReturnType<SessionConnection['listSessions']>>,
): TerminalSessionCatalog {
  return {
    sessionNames: sessions.sessions,
    sessionCatalog: sessions.sessionCatalog ?? [],
  };
}

function slotConnection(
  connection: SessionConnection,
): SlotConnection {
  return {
    listSessions: async () => sessionCatalog(await connection.listSessions()),
    readSnapshot: (target: SlotSessionTarget, maxLines: number) =>
      connection.readSnapshot({
        backend: target.backend,
        stableId: target.stableId,
        maxLines,
      }),
    close: async (reason: string) => {
      connection.close(reason);
    },
  };
}

function createSlotConnectionFactory(
  accountClient: Pick<AccountClient, 'me' | 'directory'>,
  connectionFactory: typeof createApplicationConnection,
): SlotConnectionFactory {
  return async (options) => {
    const account = await refreshAuthenticatedAccount(
      options.account,
      accountClient,
      options.signal ?? new AbortController().signal,
    );
    exactServer(account, options.server);
    const connection = await connectionFactory(
      account,
      {
        deviceId: options.server.deviceId,
        daemonHostId: options.server.daemonHostId,
      },
      options.signal,
    );
    return slotConnection(connection);
  };
}

async function renderSnapshotPreview(
  snapshot: TerminalSnapshotResultPayload,
  target: SlotSessionTarget,
  stdout: Writable,
): Promise<void> {
  if (snapshot.status === 'failed') {
    writeLine(stdout, `无法预览 ${target.name}：${snapshot.code}`);
    return;
  }
  if (snapshot.status === 'unavailable') {
    writeLine(stdout, `无法预览 ${target.name}：${snapshot.reason}`);
    return;
  }

  const { body } = snapshot;
  const normalized = normalizeWireLines(body.lines, body.cols);
  const lines = new Map<number, readonly (typeof normalized)[number]['cells'][number][]>();
  for (const line of normalized) {
    lines.set(line.index, line.cells);
  }
  const renderer = createRendererWindow({
    visibleRows: body.rows,
    visibleCols: body.cols,
  });
  const renderSnapshot = renderer.commit({
    revision: body.revision,
    latestEndIndex: snapshot.head.latestEndIndex,
    availableStartIndex: snapshot.head.availableStartIndex ?? 0,
    availableEndIndex: snapshot.head.availableEndIndex ?? snapshot.head.latestEndIndex,
    startIndex: body.startIndex,
    endIndex: body.endIndex,
    cols: body.cols,
    rows: body.rows,
    lines,
    cursor: body.cursor ?? null,
  });
  const projection = createAnsiProjection({
    write: (data) => stdout.write(data),
  });
  const commit = projection.commit(renderSnapshot);
  if (commit.blocked) await once(stdout, 'drain');
  if (!stdout.write('\x1b[0m\x1b[?25h')) await once(stdout, 'drain');
  writeLine(stdout, `\n预览：${target.name} · ${target.backend}`);
}

async function launchBinding(
  binding: CliSlotBinding,
  context: MainContext,
): Promise<number> {
  validateBinding(binding);
  const auth = await readStoredCliAuth(context.store, context.signal);
  if (!auth) {
    writeLine(context.stderr, '尚未登录或本机登录态缺少服务器配置。');
    writeLine(context.stderr, '请先运行 zterm login。');
    return 1;
  }

  let connection: SessionConnection | undefined;
  try {
    const account = await prepareSlotAccount(
      auth,
      binding,
      context.accountClient,
      context.signal,
    );
    connection = await context.connectionFactory(
      account,
      {
        deviceId: binding.server.deviceId,
        daemonHostId: binding.server.daemonHostId,
      },
      context.signal,
    );
    const result = await context.runTerminal({
      store: context.store,
      binding,
      connection,
      signal: context.signal,
    });
    if (result.message) {
      writeLine(result.exitCode === 0 ? context.stdout : context.stderr, result.message);
    }
    return result.exitCode;
  } catch (error) {
    if (context.signal.aborted) {
      writeLine(context.stderr, '操作已取消。');
      return 130;
    }
    printMappedError(error, context.stderr, '无法连接槽位绑定的 session。');
    return 1;
  } finally {
    if (connection) {
      connection.close('main-terminal-complete');
    }
  }
}

async function runLogin(args: string[], context: MainContext): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--from-config')) {
    return usage(context.stderr, 'zterm login [--from-config]');
  }
  const result = await loginCommand({
    store: context.store,
    account: context.accountClient,
    prompts: context.prompts,
    fromConfig: args[0] === '--from-config',
    signal: context.signal,
  });
  if (result.kind === 'ok') {
    writeLine(
      context.stdout,
      `登录成功：${result.value.username} @ ${result.value.relayBaseUrl}`,
    );
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(context.stderr, '登录已取消。');
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

async function runLogout(args: string[], context: MainContext): Promise<number> {
  if (args.length > 0) return usage(context.stderr, 'zterm logout');
  const result = await logoutCommand({
    store: context.store,
    signal: context.signal,
  });
  if (result.kind === 'ok') {
    writeLine(context.stdout, result.value.message);
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(context.stderr, '登出已取消。');
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

function formatDeviceEndpoints(endpoints: readonly RelayEndpointCandidate[]): string {
  const formatted: string[] = [];
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    let label: string = endpoint.kind;
    if (endpoint.host) {
      label = `${endpoint.kind}:${endpoint.host}${endpoint.port ? `:${endpoint.port}` : ''}`;
    } else if (endpoint.wsUrl) {
      label = `${endpoint.kind}:${endpoint.wsUrl}`;
    }
    if (!seen.has(label)) {
      seen.add(label);
      formatted.push(label);
    }
  }
  return formatted.length > 0 ? formatted.join(', ') : '-';
}

async function loadBestEffortDirectory(
  context: MainContext,
): Promise<RelayAccountDirectory | undefined> {
  try {
    const auth = await readStoredCliAuth(context.store, context.signal);
    if (!auth) return undefined;
    return await context.accountClient.directory(
      { relayBaseUrl: auth.relayBaseUrl, accessToken: auth.accessToken },
      context.signal,
    );
  } catch {
    return undefined;
  }
}

function findDeviceForSlot(
  entry: SlotListEntry,
  directory: RelayAccountDirectory,
) {
  return directory.devices.find(
    (device) =>
      device.deviceId === entry.binding.server.deviceId ||
      (device.daemon !== null &&
        device.daemon.hostId === entry.binding.server.daemonHostId),
  );
}

function printSlotList(
  slots: readonly SlotListEntry[],
  stdout: Writable,
  directory?: RelayAccountDirectory,
) {
  if (!directory) {
    if (slots.length === 0) {
      writeLine(stdout, '没有已配置的槽位。');
      writeLine(stdout, '请运行 zterm slot set <slot> 配置槽位。');
      return;
    }
    for (const entry of slots) {
      writeLine(stdout, slotDisplayLabel(entry));
    }
    return;
  }

  writeLine(stdout, '已配置槽位：');
  if (slots.length === 0) {
    writeLine(stdout, '  （无，可运行 zterm slot set <slot> 配置槽位）');
  } else {
    for (const entry of slots) {
      const device = findDeviceForSlot(entry, directory);
      if (!device) {
        writeLine(stdout, `  ${slotDisplayLabel(entry)} [未在 Relay 目录中找到]`);
        continue;
      }
      const status = device.daemon
        ? (device.daemon.presence.connected ? 'online' : 'offline')
        : 'no-daemon';
      const ips = device.daemon ? formatDeviceEndpoints(device.daemon.endpoints) : '-';
      writeLine(stdout, `  ${slotDisplayLabel(entry)} [${status} | ${ips}]`);
    }
  }

  writeLine(stdout, '');
  writeLine(stdout, `Relay 设备 (${directory.user.username})：`);
  if (directory.devices.length === 0) {
    writeLine(stdout, '  （暂无已注册设备）');
    return;
  }
  for (const device of directory.devices) {
    const daemonStatus = device.daemon
      ? (device.daemon.presence.connected ? 'daemon:online' : 'daemon:offline')
      : 'daemon:none';
    const clientStatus = device.client.connected ? 'client:online' : 'client:offline';
    const ips = device.daemon ? formatDeviceEndpoints(device.daemon.endpoints) : '-';
    const boundSlots = slots.filter(
      (entry) =>
        entry.binding.server.deviceId === device.deviceId ||
        (device.daemon !== null &&
          entry.binding.server.daemonHostId === device.daemon.hostId),
    );
    const slotSummary = boundSlots.length > 0
      ? boundSlots
          .map((entry) =>
            entry.binding.alias ? `${entry.slot}(${entry.binding.alias})` : `${entry.slot}`,
          )
          .join(', ')
      : '未绑定';
    const sessions =
      device.daemon && device.daemon.sessions.length > 0
        ? device.daemon.sessions.map((session) => session.name).join(', ')
        : '-';
    writeLine(
      stdout,
      `  - ${device.deviceName} (${device.deviceId}) | ${daemonStatus}, ${clientStatus} | ip: ${ips} | slots: ${slotSummary} | sessions: ${sessions}`,
    );
  }
}

function hasHelp(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--help';
}

function syncScopeFromArgs(
  direction: 'pull' | 'push',
  args: readonly string[],
): SlotSyncScope | UsageError {
  const usageMessage = direction === 'pull'
    ? 'zterm slot pull <slot> 或 zterm slot pull --all'
    : 'zterm slot push <slot> 或 zterm slot push --all';
  if (args.length === 1 && args[0] === '--all') return { kind: 'all' };
  if (args.length !== 1) return usageFailure(usageMessage);
  const slot = parseSlot(args[0]);
  if (slot === undefined || slot < 1) {
    return usageFailure('槽位编号必须是大于等于 1 的整数。');
  }
  return { kind: 'one', slot };
}

function cloudSlotAccount(
  accountClient: MainAccountClient,
): CloudSlotAccountClient {
  if (
    typeof accountClient.readSlotConfig !== 'function'
    || typeof accountClient.replaceSlotConfig !== 'function'
    || typeof accountClient.replaceSlot !== 'function'
  ) {
    throw new MainCommandError(
      'cloud_sync_unsupported',
      '当前 CLI 账号客户端不支持云端槽位同步。',
      '请升级 zterm 或使用完整安装版本后重试。',
    );
  }
  const client = accountClient as CloudSlotAccountClient;
  return {
    readSlotConfig: (auth, signal) => client.readSlotConfig(auth, signal),
    replaceSlotConfig: (auth, slots, signal) =>
      client.replaceSlotConfig(auth, slots, signal),
    replaceSlot: (auth, slot, binding, signal) =>
      client.replaceSlot(auth, slot, binding, signal),
  };
}

function slotSyncSuccessMessage(
  result: Extract<SlotSyncCommandResult, { kind: 'ok' }>,
): string {
  const { direction, scope, count } = result;
  if (scope.kind === 'one') {
    return direction === 'pull'
      ? `已用云端槽位 ${scope.slot} 覆盖本地槽位 ${scope.slot}。`
      : `已用本地槽位 ${scope.slot} 覆盖当前账号的云端槽位 ${scope.slot}。`;
  }
  if (direction === 'pull') {
    return count === 0
      ? '已清空当前账号的本地槽位（共 0 个）：云端配置为空。'
      : `已用当前账号的云端配置覆盖本地槽位：共 ${count} 个。`;
  }
  return count === 0
    ? '已清空当前账号的云端槽位（共 0 个）：本地没有该账号的槽位。'
    : `已用当前账号的本地槽位覆盖云端槽位：共 ${count} 个。`;
}

async function runSlotSync(
  direction: 'pull' | 'push',
  scope: SlotSyncScope,
  context: MainContext,
): Promise<number> {
  const result = await slotSyncCommand({
    store: context.store,
    account: cloudSlotAccount(context.accountClient),
    direction,
    scope,
    signal: context.signal,
  });
  if (result.kind === 'ok') {
    writeLine(context.stdout, slotSyncSuccessMessage(result));
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(
      context.stderr,
      direction === 'pull' ? '槽位拉取已取消。' : '槽位推送已取消。',
    );
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

async function runSlotRename(
  args: readonly string[],
  context: MainContext,
): Promise<number> {
  const slot = parseSlot(args[0]);
  if (slot === undefined || slot < 1) {
    return usage(context.stderr, 'zterm slot rename <slot> <name>');
  }
  if (args.length !== 2) {
    return usage(context.stderr, 'zterm slot rename <slot> <name>');
  }
  const result = await slotRenameCommand({
    store: context.store,
    slot,
    name: args[1]!,
    signal: context.signal,
  });
  if (result.kind === 'ok') {
    writeLine(
      context.stdout,
      `已保存槽位 ${result.value.slot} 的别名：`
        + `${result.value.binding.alias ?? args[1]!}`,
    );
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(context.stderr, '槽位别名保存已取消。');
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

async function runSlotList(
  args: readonly string[],
  context: MainContext,
): Promise<number> {
  if (hasHelp(args)) {
    write(context.stdout, SLOT_LIST_HELP);
    return 0;
  }
  if (args.length !== 0) return usage(context.stderr, 'zterm slot list');
  const result = await slotListCommand({
    store: context.store,
    signal: context.signal,
  });
  if (result.kind === 'ok') {
    const directory = await loadBestEffortDirectory(context);
    printSlotList(result.value.slots, context.stdout, directory);
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(context.stderr, '读取槽位已取消。');
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

async function runSlot(args: string[], context: MainContext): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    writeLine(context.stderr, '用法错误：zterm slot list|rename|pull|push|set');
    writeLine(context.stderr, '运行 zterm slot --help 查看槽位命令。');
    return 2;
  }
  if (subcommand === '--help') {
    write(context.stdout, SLOT_HELP);
    return 0;
  }

  if (subcommand === 'list') {
    return runSlotList(rest, context);
  }

  if (subcommand === 'rename') {
    if (hasHelp(rest)) {
      write(context.stdout, SLOT_RENAME_HELP);
      return 0;
    }
    return runSlotRename(rest, context);
  }

  if (subcommand === 'pull' || subcommand === 'push') {
    if (hasHelp(rest)) {
      write(
        context.stdout,
        subcommand === 'pull' ? SLOT_PULL_HELP : SLOT_PUSH_HELP,
      );
      return 0;
    }
    const scope = syncScopeFromArgs(subcommand, rest);
    if (isUsageError(scope)) return usage(context.stderr, scope.usageMessage);
    return runSlotSync(subcommand, scope, context);
  }

  if (subcommand !== 'set') {
    return usage(context.stderr, 'zterm slot list|rename|pull|push|set');
  }
  const slot = parseSlot(rest[0]);
  if (slot === undefined) {
    return usage(context.stderr, '槽位编号必须是大于等于 1 的整数。');
  }
  const optionArgs = rest.slice(1);
  const widthValue = optionValue(optionArgs, '--width-mode');
  if (isUsageError(widthValue)) {
    return usage(context.stderr, widthValue.usageMessage);
  }
  if (
    widthValue !== undefined
    && widthValue !== 'adaptive-phone'
    && widthValue !== 'mirror-fixed'
  ) {
    return usage(context.stderr, '--width-mode 仅支持 adaptive-phone 或 mirror-fixed。');
  }
  const deviceValue = optionValue(optionArgs, '--device');
  if (isUsageError(deviceValue)) {
    return usage(context.stderr, deviceValue.usageMessage);
  }
  const sessionValue = optionValue(optionArgs, '--session');
  if (isUsageError(sessionValue)) {
    return usage(context.stderr, sessionValue.usageMessage);
  }
  const aliasValue = optionValue(optionArgs, '--alias');
  if (isUsageError(aliasValue)) {
    return usage(context.stderr, aliasValue.usageMessage);
  }
  const expectedLength =
    (widthValue === undefined ? 0 : 2)
    + (deviceValue === undefined ? 0 : 2)
    + (sessionValue === undefined ? 0 : 2)
    + (aliasValue === undefined ? 0 : 2);
  if (optionArgs.length !== expectedLength) {
    return usage(
      context.stderr,
      'zterm slot set <slot> [--device <nameOrId>] [--session <name>] [--alias <name>] [--width-mode adaptive-phone|mirror-fixed]',
    );
  }

  const result = await slotSetCommand({
    store: context.store,
    account: context.accountClient,
    prompts: context.prompts,
    connectionFactory: createSlotConnectionFactory(
      context.accountClient,
      context.connectionFactory,
    ),
    renderPreview: (snapshot, target) =>
      renderSnapshotPreview(snapshot, target, context.stdout),
    slot,
    ...(deviceValue === undefined ? {} : { device: deviceValue }),
    ...(sessionValue === undefined ? {} : { session: sessionValue }),
    ...(aliasValue === undefined ? {} : { alias: aliasValue }),
    ...(widthValue === undefined ? {} : { widthMode: widthValue }),
    signal: context.signal,
  });
  cleanupFailure(result.cleanupErrors, context.stderr);
  if (result.kind === 'ok') {
    writeLine(
      context.stdout,
      `已保存槽位 ${result.value.slot}：${result.value.binding.session.name} · `
        + `${result.value.binding.server.displayName}`,
    );
    return 0;
  }
  if (result.kind === 'cancelled') {
    writeLine(context.stderr, '槽位配置已取消，原绑定未改变。');
    return 130;
  }
  printCommandFailure(result, context.stderr);
  return commandExitCode(result);
}

async function runUpgrade(args: string[], context: MainContext): Promise<number> {
  const registry = optionValue(args, '--registry');
  if (isUsageError(registry)) {
    return usage(context.stderr, registry.usageMessage);
  }
  if (args.length !== (registry === undefined ? 0 : 2)) {
    return usage(context.stderr, 'zterm upgrade [--registry <url>]');
  }
  const result = await context.upgrade({
    ...(registry === undefined ? {} : { registry }),
    signal: context.signal,
  });
  if (result.installationState === 'updated') {
    writeLine(
      context.stdout,
      `CLI 已升级：${result.beforeVersion} -> ${result.observedVersion ?? result.requestedVersion}`,
    );
    return 0;
  }
  if (result.installationState === 'unchanged') {
    writeLine(context.stdout, `CLI 已是版本 ${result.beforeVersion}。`);
    return 0;
  }
  writeLine(
    context.stderr,
    result.error?.message ?? 'CLI 升级后的安装状态未验证。',
  );
  writeLine(context.stderr, '未自动回滚；请检查当前 npm 全局安装入口。');
  return 1;
}

async function runDaemon(args: string[], context: MainContext): Promise<number> {
  if (args[0] === 'install') {
    const registry = optionValue(args.slice(1), '--registry');
    if (isUsageError(registry)) return usage(context.stderr, registry.usageMessage);
    const version = optionValue(args.slice(1), '--version');
    if (isUsageError(version)) return usage(context.stderr, version.usageMessage);
    const installArgs = args.slice(1);
    if (installArgs.includes('--no-start')) {
      return usage(
        context.stderr,
        '--no-start 已移除：daemon install 现在只安装和验证，不执行服务激活。',
      );
    }
    const expectedLength =
      (registry === undefined ? 0 : 2)
      + (version === undefined ? 0 : 2);
    if (installArgs.length !== expectedLength) {
      return usage(
        context.stderr,
        'zterm daemon install [--version <version>] [--registry <url>]',
      );
    }
    const result = await context.daemonInstall({
      ...(registry === undefined ? {} : { registry }),
      ...(version === undefined ? {} : { version }),
      signal: context.signal,
    });
    if (result.error) {
      writeLine(context.stderr, result.error.message);
      return 1;
    }
    writeLine(
      context.stdout,
      `daemon 安装完成${result.installedVersion ? `：${result.installedVersion}` : ''}`,
    );
    writeLine(
      context.stdout,
      '安装命令未执行服务激活；现有服务状态保持不变。',
    );
    return 0;
  }

  if (args[0] === 'status' || args[0] === 'config') {
    if (args.length !== 1) return usage(context.stderr, `zterm daemon ${args[0]}`);
    const result = args[0] === 'status'
      ? await context.daemonStatus({ signal: context.signal })
      : await context.daemonConfig({ signal: context.signal });
    if (result.stdout) write(context.stdout, result.stdout);
    if (result.stderr) write(context.stderr, result.stderr);
    if (result.stdout || result.stderr || result.error) {
      return result.exitCode
        ?? (result.signal || result.error ? 1 : 0);
    }
    return result.exitCode ?? (result.signal || result.error ? 1 : 0);
  }

  return usage(context.stderr, 'zterm daemon install|status|config');
}

function runSkill(args: string[], context: MainContext): number {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    write(context.stdout, SKILL_HELP);
    return 0;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === 'show') {
    if (rest.length !== 0) return usage(context.stderr, 'zterm skill show');
    write(context.stdout, readBundledSkill());
    return 0;
  }
  if (subcommand !== 'install') {
    return usage(context.stderr, 'zterm skill install|show');
  }
  if (hasHelp(rest)) {
    write(context.stdout, SKILL_HELP);
    return 0;
  }
  const targetValue = optionValue(rest, '--target');
  if (isUsageError(targetValue)) return usage(context.stderr, targetValue.usageMessage);
  if (
    targetValue !== undefined
    && targetValue !== 'all'
    && targetValue !== 'agents'
    && targetValue !== 'gemini'
    && targetValue !== 'codex'
    && targetValue !== 'project'
  ) {
    return usage(context.stderr, '--target 仅支持 all|agents|gemini|codex|project。');
  }
  const dirValue = optionValue(rest, '--dir');
  if (isUsageError(dirValue)) return usage(context.stderr, dirValue.usageMessage);
  const expectedLen = (targetValue === undefined ? 0 : 2) + (dirValue === undefined ? 0 : 2);
  if (rest.length !== expectedLen) {
    return usage(context.stderr, 'zterm skill install [--target all|agents|gemini|codex|project] [--dir <path>]');
  }

  const result = installSkill({
    ...(targetValue === undefined ? {} : { target: targetValue as SkillInstallTarget }),
    ...(dirValue === undefined ? {} : { projectDir: dirValue }),
  });
  for (const path of result.installedPaths) {
    writeLine(context.stdout, `已安装 zterm-cli skill：${path}`);
  }
  for (const path of result.skippedSymlinks) {
    writeLine(context.stdout, `已跳过符号链接目录（与主目录共用）：${path}`);
  }
  return 0;
}

function usage(stderr: Writable, detail: string): number {
  writeLine(stderr, `用法错误：${detail}`);
  writeLine(stderr, '运行 zterm --help 查看完整命令。');
  return 2;
}

async function resolveRemoteTarget(
  target: { slot?: number; device?: string },
  context: MainContext,
): Promise<{
  account: AuthenticatedAccount;
  server: SlotServerChoice;
  boundBinding?: CliSlotBinding;
} | { errorExitCode: number }> {
  let boundBinding: CliSlotBinding | undefined;
  if (target.slot !== undefined) {
    const resolved = await resolveSlotCommand({
      store: context.store,
      slot: target.slot,
      signal: context.signal,
    });
    if (resolved.kind !== 'ok') {
      if (resolved.kind === 'cancelled') {
        writeLine(context.stderr, '读取槽位已取消。');
        return { errorExitCode: 130 };
      }
      printCommandFailure(resolved, context.stderr);
      return { errorExitCode: commandExitCode(resolved) };
    }
    boundBinding = resolved.value.binding;
  }

  const auth = await readStoredCliAuth(context.store, context.signal);
  if (!auth) {
    writeLine(context.stderr, '尚未登录或本机登录态缺少服务器配置。');
    writeLine(context.stderr, '请先运行 zterm login。');
    return { errorExitCode: 1 };
  }

  const account = await refreshAuthenticatedAccount(auth, context.accountClient, context.signal);
  const servers = serverChoices(account.directory);

  if (target.device !== undefined) {
    const matched = matchServerChoice(servers, target.device);
    if (matched.kind === 'error') {
      writeLine(context.stderr, matched.message);
      writeLine(context.stderr, '请运行 zterm list 查看可用设备名称或 deviceId。');
      return { errorExitCode: 1 };
    }
    return { account, server: matched.server, boundBinding };
  }

  if (boundBinding) {
    const matchedById = servers.find(
      (s) =>
        s.deviceId === boundBinding.server.deviceId
        && s.daemonHostId === boundBinding.server.daemonHostId,
    );
    if (!matchedById) {
      writeLine(context.stderr, '槽位绑定的服务器已变化或当前不可从账号访问。');
      writeLine(context.stderr, '请运行 zterm list 或重新运行 zterm slot set <slot>。');
      return { errorExitCode: 1 };
    }
    return { account, server: matchedById, boundBinding };
  }

  writeLine(context.stderr, '请指定 <slot> 或 --device <nameOrId>。');
  return { errorExitCode: 2 };
}

function splitTargetArgs(
  args: readonly string[],
  usageText: string,
): { slot?: number; device?: string; rest: string[] } | UsageError {
  if (args.length === 0) return usageFailure(usageText);
  if (args[0] === '--device') {
    if (!args[1] || args[1].startsWith('--')) return usageFailure(usageText);
    return { device: args[1], rest: args.slice(2) };
  }
  const slot = parseSlot(args[0]);
  if (slot === undefined) return usageFailure(usageText);
  return { slot, rest: args.slice(1) };
}

async function runSession(args: string[], context: MainContext): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    write(context.stdout, SESSION_HELP);
    return 0;
  }
  const [subcommand, ...rest] = args;
  const action = subcommand === 'rm' || subcommand === 'kill' ? 'delete' : subcommand;
  if (action !== 'list' && action !== 'create' && action !== 'rename' && action !== 'delete') {
    return usage(context.stderr, 'zterm session list|create|rename|delete ...');
  }
  if (hasHelp(rest)) {
    write(context.stdout, SESSION_HELP);
    return 0;
  }

  const parsedTarget = splitTargetArgs(
    rest,
    `zterm session ${action} <slot|--device <nameOrId>>${
      action === 'list'
        ? ''
        : action === 'rename'
          ? ' <sessionName> <nextSessionName>'
          : ' <sessionName>'
    }`,
  );
  if (isUsageError(parsedTarget)) return usage(context.stderr, parsedTarget.usageMessage);

  let sessionName: string | undefined;
  let nextSessionName: string | undefined;
  let cwd: string | undefined;
  if (action === 'list') {
    if (parsedTarget.rest.length !== 0) {
      return usage(context.stderr, 'zterm session list <slot|--device <nameOrId>>');
    }
  } else if (action === 'create') {
    sessionName = parsedTarget.rest[0];
    if (!sessionName || sessionName.startsWith('--')) {
      return usage(context.stderr, 'zterm session create <slot|--device <nameOrId>> <sessionName> [--cwd <path>]');
    }
    const cwdOption = optionValue(parsedTarget.rest.slice(1), '--cwd');
    if (isUsageError(cwdOption)) return usage(context.stderr, cwdOption.usageMessage);
    cwd = cwdOption;
    if (parsedTarget.rest.slice(1).length !== (cwd === undefined ? 0 : 2)) {
      return usage(context.stderr, 'zterm session create <slot|--device <nameOrId>> <sessionName> [--cwd <path>]');
    }
  } else if (action === 'rename') {
    sessionName = parsedTarget.rest[0];
    nextSessionName = parsedTarget.rest[1];
    if (
      !sessionName
      || sessionName.startsWith('--')
      || !nextSessionName
      || nextSessionName.startsWith('--')
      || parsedTarget.rest.length !== 2
    ) {
      return usage(
        context.stderr,
        'zterm session rename <slot|--device <nameOrId>> <sessionName> <nextSessionName>',
      );
    }
  } else {
    sessionName = parsedTarget.rest[0];
    if (!sessionName || sessionName.startsWith('--') || parsedTarget.rest.length !== 1) {
      return usage(context.stderr, 'zterm session delete <slot|--device <nameOrId>> <sessionName>');
    }
  }

  const resolved = await resolveRemoteTarget(parsedTarget, context);
  if ('errorExitCode' in resolved) return resolved.errorExitCode;

  const connection = await context.connectionFactory(
    resolved.account,
    {
      deviceId: resolved.server.deviceId,
      daemonHostId: resolved.server.daemonHostId,
    },
    context.signal,
  );

  try {
    const result = action === 'list'
      ? await connection.listSessions({}, context.signal)
      : action === 'create'
        ? await connection.createSession({ sessionName: sessionName!, ...(cwd ? { cwd } : {}) }, context.signal)
        : action === 'rename'
          ? await connection.renameSession(
              { sessionName: sessionName!, nextSessionName: nextSessionName! },
              context.signal,
            )
          : await connection.killSession({ sessionName: sessionName! }, context.signal);

    if (action === 'create') {
      writeLine(context.stdout, `已创建 session：${sessionName}`);
    } else if (action === 'rename') {
      writeLine(context.stdout, `已重命名 session：${sessionName} -> ${nextSessionName}`);
    } else if (action === 'delete') {
      writeLine(context.stdout, `已删除 session：${sessionName}`);
    }
    const catalog = sessionChoices(sessionCatalog(result));
    if (catalog.length === 0) {
      if (result.sessions.length === 0) {
        writeLine(context.stdout, '（无活跃 session）');
      } else {
        for (const name of result.sessions) {
          writeLine(context.stdout, `  - ${name}`);
        }
      }
    } else {
      for (const session of catalog) {
        writeLine(context.stdout, `  - ${session.name} (${session.backend}, ${session.stableId})`);
      }
    }
    return 0;
  } finally {
    try {
      await connection.close('session-command-complete');
    } catch {
      // Best-effort close.
    }
  }
}

async function runExec(args: string[], context: MainContext): Promise<number> {
  if (args.length === 0 || hasHelp(args)) {
    write(context.stdout, EXEC_HELP);
    return 0;
  }

  let slot: number | undefined;
  let device: string | undefined;
  let sessionQuery: string | undefined;
  let timeoutMs: number | undefined;
  const commandParts: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--') {
      commandParts.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--device') {
      const next = args[i + 1];
      if (!next) return usage(context.stderr, 'zterm exec --device <nameOrId> ...');
      device = next;
      i += 2;
      continue;
    }
    if (arg === '--session') {
      const next = args[i + 1];
      if (!next) return usage(context.stderr, 'zterm exec ... --session <name> ...');
      sessionQuery = next;
      i += 2;
      continue;
    }
    if (arg === '--timeout') {
      const next = args[i + 1];
      const parsed = next ? Number(next) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return usage(context.stderr, '--timeout 必须是正整数（毫秒）。');
      }
      timeoutMs = parsed;
      i += 2;
      continue;
    }
    if (arg.startsWith('--')) {
      return usage(context.stderr, `未知选项：${arg}`);
    }
    if (slot === undefined && device === undefined && /^\d+$/.test(arg)) {
      const parsedSlot = parseSlot(arg);
      if (parsedSlot === undefined) {
        return usage(context.stderr, '槽位编号必须是大于等于 1 的整数。');
      }
      slot = parsedSlot;
      i += 1;
      continue;
    }
    commandParts.push(...args.slice(i));
    break;
  }

  const command = commandParts.join(' ').trim();
  if ((slot === undefined && device === undefined) || !command) {
    return usage(
      context.stderr,
      'zterm exec <slot|--device <nameOrId>> [--session <name>] [--timeout <ms>] [--] <command...>',
    );
  }

  const resolved = await resolveRemoteTarget({ slot, device }, context);
  if ('errorExitCode' in resolved) return resolved.errorExitCode;

  const connection = await context.connectionFactory(
    resolved.account,
    {
      deviceId: resolved.server.deviceId,
      daemonHostId: resolved.server.daemonHostId,
    },
    context.signal,
  );

  let selectedSession: CliSlotBinding['session'];
  if (sessionQuery !== undefined || resolved.boundBinding === undefined) {
    let sessions: SlotSessionTarget[];
    try {
      sessions = sessionChoices(sessionCatalog(await connection.listSessions({}, context.signal)));
    } catch (error) {
      try {
        await connection.close('exec-list-failed');
      } catch {}
      throw error;
    }
    if (sessions.length === 0) {
      try {
        await connection.close('exec-no-sessions');
      } catch {}
      writeLine(context.stderr, '目标机器没有可用 session，请先用 zterm session create 创建。');
      return 1;
    }
    if (sessionQuery !== undefined) {
      const matched = matchSessionChoice(sessions, sessionQuery);
      if (matched.kind === 'error') {
        try {
          await connection.close('exec-session-not-found');
        } catch {}
        writeLine(context.stderr, matched.message);
        return 1;
      }
      selectedSession = matched.session;
    } else if (sessions.length === 1) {
      selectedSession = sessions[0]!;
    } else {
      try {
        await connection.close('exec-session-ambiguous');
      } catch {}
      writeLine(
        context.stderr,
        `目标机器存在多个 session（${sessions.map((s) => s.name).join(', ')}），请使用 --session <name> 指定。`,
      );
      return 2;
    }
  } else {
    selectedSession = resolved.boundBinding.session;
  }

  const execBinding: CliSlotBinding = {
    account: {
      relayBaseUrl: resolved.account.relayBaseUrl,
      userId: resolved.account.user.id,
    },
    server: {
      deviceId: resolved.server.deviceId,
      daemonHostId: resolved.server.daemonHostId,
      displayName: resolved.server.displayName,
    },
    session: selectedSession,
    widthMode: 'mirror-fixed',
  };

  const result = await context.runExec({
    binding: execBinding,
    connection,
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    stdout: context.stdout,
    stderr: context.stderr,
    signal: context.signal,
  });
  if (result.message) {
    writeLine(context.stderr, result.message);
  }
  return result.exitCode;
}

async function dispatch(argv: string[], context: MainContext): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    write(context.stdout, HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    writeLine(context.stdout, `zterm ${CLI_VERSION}`);
    return 0;
  }

  const [command, ...args] = argv;
  if (command === undefined) {
    const selected = await selectSlotCommand({
      store: context.store,
      prompts: context.prompts,
      signal: context.signal,
    });
    if (selected.kind !== 'ok') {
      if (selected.kind === 'cancelled') {
        writeLine(context.stderr, '槽位选择已取消。');
        return 130;
      }
      printCommandFailure(selected, context.stderr);
      return commandExitCode(selected);
    }
    return launchBinding(selected.value.binding, context);
  }

  if (/^\d+$/.test(command)) {
    if (args.length > 0) return usage(context.stderr, 'zterm <slot>');
    const slot = parseSlot(command);
    if (slot === undefined) {
      return usage(context.stderr, '槽位编号必须是大于等于 1 的整数。');
    }
    const resolved = await resolveSlotCommand({
      store: context.store,
      slot,
      signal: context.signal,
    });
    if (resolved.kind !== 'ok') {
      if (resolved.kind === 'cancelled') {
        writeLine(context.stderr, '读取槽位已取消。');
        return 130;
      }
      printCommandFailure(resolved, context.stderr);
      return commandExitCode(resolved);
    }
    return launchBinding(resolved.value.binding, context);
  }

  switch (command) {
    case 'list':
      return runSlotList(args, context);
    case 'exec':
      return runExec(args, context);
    case 'session':
      return runSession(args, context);
    case 'skill':
      return runSkill(args, context);
    case 'login':
      return runLogin(args, context);
    case 'logout':
      return runLogout(args, context);
    case 'slot':
      return runSlot(args, context);
    case 'upgrade':
      return runUpgrade(args, context);
    case 'daemon':
      return runDaemon(args, context);
    case 'app':
      return runAppCommand(args, context);
    default:
      return usage(context.stderr, `未知命令：${command}`);
  }
}

export async function runMain(
  argv: readonly string[],
  options: MainOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signal = options.signal ?? new AbortController().signal;
  const context: MainContext = {
    store: options.store ?? new SharedConfigStore(),
    accountClient: options.accountClient ?? new AccountClient(),
    prompts: options.prompts ?? createNodePrompts({
      input: options.stdin ?? process.stdin,
      output: stdout,
      signal,
    }),
    stdin: options.stdin ?? process.stdin,
    stdout,
    stderr,
    signal,
    connectionFactory: options.connectionFactory ?? createApplicationConnection,
    upgrade: options.upgrade ?? upgradeCli,
    daemonInstall: options.daemonInstall ?? installDaemon,
    daemonStatus: options.daemonStatus ?? getDaemonStatus,
    daemonConfig: options.daemonConfig ?? getDaemonConfig,
    runTerminal: options.runTerminal ?? runTerminalSession,
    runExec: options.runExec ?? runExecSession,
  };

  try {
    return await dispatch([...argv], context);
  } catch (error) {
    if (isUsageError(error)) return usage(stderr, error.usageMessage);
    if (context.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      writeLine(stderr, '操作已取消。');
      return 130;
    }
    printMappedError(error, stderr);
    return 1;
  }
}

function isCliEntry() {
  const name = basename(process.argv[1] ?? '').toLowerCase();
  return name === 'zterm' || name === 'zterm.mjs' || name === 'main.mjs';
}

if (isCliEntry()) {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = () => controller.abort(new Error(signal));
    process.once(signal, handler);
    return { signal, handler };
  });
  void runMain(process.argv.slice(2), { signal: controller.signal })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => {
      for (const { signal, handler } of handlers) {
        process.removeListener(signal, handler);
      }
    });
}

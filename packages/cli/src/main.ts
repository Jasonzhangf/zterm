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
  resolveSlotCommand,
  selectSlotCommand,
  slotListCommand,
  slotSetCommand,
  type SlotConnection,
  type SlotConnectionFactory,
  type SlotPreviewRenderer,
  type SlotSessionTarget,
} from './commands/slots.js';
import {
  getDaemonConfig,
  getDaemonStatus,
  installDaemon,
} from './daemon-management.js';
import { createNodePrompts, type PromptPort } from './prompts.js';
import { createRendererWindow } from './renderer-window.js';
import { upgradeCli } from './release.js';
import type { CliSlotBinding, SlotListEntry } from './slot-store.js';
import { runTerminalSession } from './terminal-session.js';
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
  zterm <1..20>
  zterm
  zterm login [--from-config]
  zterm logout
  zterm slot list
  zterm slot set <1..20> [--width-mode adaptive-phone|mirror-fixed]
  zterm upgrade [--registry <url>]
  zterm daemon install [--version <version>] [--registry <url>]
  zterm daemon status
  zterm daemon config
  zterm --help
  zterm --version
`;

export interface MainOptions {
  store?: SharedConfigStore;
  accountClient?: Pick<AccountClient, 'login' | 'me' | 'directory'>;
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
}

interface MainContext {
  store: SharedConfigStore;
  accountClient: Pick<AccountClient, 'login' | 'me' | 'directory'>;
  prompts: PromptPort;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  connectionFactory: typeof createApplicationConnection;
  upgrade: typeof upgradeCli;
  daemonInstall: typeof installDaemon;
  daemonStatus: typeof getDaemonStatus;
  daemonConfig: typeof getDaemonConfig;
  runTerminal: typeof runTerminalSession;
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
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
      '请重新运行 zterm slot set <1..20>。',
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
      '请重新运行 zterm slot set <1..20>。',
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

function printSlotList(
  slots: readonly SlotListEntry[],
  stdout: Writable,
) {
  if (slots.length === 0) {
    writeLine(stdout, '没有已配置的槽位。');
    return;
  }
  for (const entry of slots) {
    writeLine(
      stdout,
      `槽位 ${entry.slot} · ${entry.binding.server.displayName} · `
        + `${entry.binding.session.name} · ${entry.binding.session.backend} · `
        + entry.binding.widthMode,
    );
  }
}

async function runSlot(args: string[], context: MainContext): Promise<number> {
  if (args[0] === 'list') {
    if (args.length !== 1) return usage(context.stderr, 'zterm slot list');
    const result = await slotListCommand({
      store: context.store,
      signal: context.signal,
    });
    if (result.kind === 'ok') {
      printSlotList(result.value.slots, context.stdout);
      return 0;
    }
    if (result.kind === 'cancelled') {
      writeLine(context.stderr, '读取槽位已取消。');
      return 130;
    }
    printCommandFailure(result, context.stderr);
    return commandExitCode(result);
  }

  if (args[0] !== 'set') {
    return usage(context.stderr, 'zterm slot set <1..20> [--width-mode adaptive-phone|mirror-fixed]');
  }
  const slot = parseSlot(args[1]);
  if (slot === undefined) {
    return usage(context.stderr, '槽位编号必须是 1 到 20 的整数。');
  }
  const widthValue = optionValue(args.slice(2), '--width-mode');
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
  const optionArgs = args.slice(2);
  if (optionArgs.length !== (widthValue === undefined ? 0 : 2)) {
    return usage(context.stderr, 'zterm slot set <1..20> [--width-mode adaptive-phone|mirror-fixed]');
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
    const expectedLength =
      (registry === undefined ? 0 : 2) + (version === undefined ? 0 : 2);
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

function usage(stderr: Writable, detail: string): number {
  writeLine(stderr, `用法错误：${detail}`);
  writeLine(stderr, '运行 zterm --help 查看完整命令。');
  return 2;
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
    if (args.length > 0) return usage(context.stderr, 'zterm <1..20>');
    const slot = parseSlot(command);
    if (slot === undefined) {
      return usage(context.stderr, '槽位编号必须是 1 到 20 的整数。');
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
    stdout,
    stderr,
    signal,
    connectionFactory: options.connectionFactory ?? createApplicationConnection,
    upgrade: options.upgrade ?? upgradeCli,
    daemonInstall: options.daemonInstall ?? installDaemon,
    daemonStatus: options.daemonStatus ?? getDaemonStatus,
    daemonConfig: options.daemonConfig ?? getDaemonConfig,
    runTerminal: options.runTerminal ?? runTerminalSession,
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

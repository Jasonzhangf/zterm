import { randomUUID } from 'node:crypto';
import { AccountClientError, type AccountClient } from '../account-client.js';
import {
  AccountState,
  type LoginAttempt,
  type NewAuthSession,
} from '../account-state.js';
import {
  PromptCancelledError,
  PromptUnsupportedError,
  type PromptPort,
} from '../prompts.js';
import {
  ConfigStoreError,
  type JsonObject,
  type SharedConfigStore,
} from '../../../shared/src/node/shared-config.js';

export interface CommandError {
  code: string;
  message: string;
  action?: string;
  status?: number;
}

export interface CommandCancelled {
  kind: 'cancelled';
  stage: string;
}

export interface CommandFailed {
  kind: 'failed';
  stage: string;
  error: CommandError;
}

export interface CliServer {
  relayBaseUrl: string;
}

export interface StoredCliAuth {
  relayBaseUrl: string;
  loginId: string;
  userId: string;
  username: string;
  accessToken: string;
  authenticatedAt: string;
}

export interface LoginCommandOptions {
  store: SharedConfigStore;
  account: Pick<AccountClient, 'login'>;
  prompts: PromptPort;
  fromConfig: boolean;
  signal?: AbortSignal;
  now?: () => string;
  createLoginId?: () => string;
}

export type LoginCommandResult =
  | {
      kind: 'ok';
      value: {
        relayBaseUrl: string;
        userId: string;
        username: string;
        source: 'interactive' | 'config';
        generation: number;
      };
    }
  | CommandCancelled
  | CommandFailed;

export interface LogoutCommandOptions {
  store: SharedConfigStore;
  signal?: AbortSignal;
}

export type LogoutCommandResult =
  | {
      kind: 'ok';
      value: {
        generation: number;
        message: string;
      };
    }
  | CommandCancelled
  | CommandFailed;

export class CommandContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CommandContractError';
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cliSection(config: JsonObject): JsonObject | undefined {
  const zterm = config.zterm;
  if (zterm === undefined) return undefined;
  if (!isJsonObject(zterm)) {
    throw new CommandContractError('invalid_config', 'zterm config must be an object');
  }
  const cli = zterm.cli;
  if (cli === undefined) return undefined;
  if (!isJsonObject(cli)) {
    throw new CommandContractError('invalid_config', 'zterm.cli config must be an object');
  }
  return cli;
}

function requiredString(record: JsonObject, key: string, label: string) {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommandContractError('invalid_config', `${label} is missing or invalid`);
  }
  return value;
}

export async function readCliServer(
  store: SharedConfigStore,
  signal?: AbortSignal,
): Promise<CliServer | undefined> {
  signal?.throwIfAborted();
  const snapshot = await store.read();
  const cli = cliSection(snapshot.config);
  if (!cli || cli.server === undefined) return undefined;
  if (!isJsonObject(cli.server)) {
    throw new CommandContractError('invalid_config', 'zterm.cli.server must be an object');
  }
  return { relayBaseUrl: requiredString(cli.server, 'relayBaseUrl', 'relayBaseUrl') };
}

export async function readStoredCliAuth(
  store: SharedConfigStore,
  signal?: AbortSignal,
): Promise<StoredCliAuth | undefined> {
  signal?.throwIfAborted();
  const snapshot = await store.read();
  const cli = cliSection(snapshot.config);
  if (!cli || cli.auth === undefined) return undefined;
  if (!isJsonObject(cli.auth)) {
    throw new CommandContractError('invalid_config', 'zterm.cli.auth must be an object');
  }
  if (cli.server === undefined) {
    throw new CommandContractError('invalid_config', 'zterm.cli.server is required with auth');
  }
  if (!isJsonObject(cli.server)) {
    throw new CommandContractError('invalid_config', 'zterm.cli.server must be an object');
  }
  return {
    relayBaseUrl: requiredString(cli.server, 'relayBaseUrl', 'relayBaseUrl'),
    loginId: requiredString(cli.auth, 'loginId', 'auth.loginId'),
    userId: requiredString(cli.auth, 'userId', 'auth.userId'),
    username: requiredString(cli.auth, 'username', 'auth.username'),
    accessToken: requiredString(cli.auth, 'accessToken', 'auth.accessToken'),
    authenticatedAt: requiredString(
      cli.auth,
      'authenticatedAt',
      'auth.authenticatedAt',
    ),
  };
}

export function toCommandError(
  stage: string,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): CommandError {
  if (error instanceof AccountClientError) {
    return {
      code: error.code,
      message: error.message,
      action: error.action,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  if (error instanceof ConfigStoreError) {
    return {
      code: error.code,
      message: configErrorMessage(error.code),
      action: '请检查共享配置文件后重试。',
    };
  }
  if (error instanceof CommandContractError) {
    return {
      code: error.code,
      message: error.message,
      action: '请修正共享配置中的 CLI 字段后重试。',
    };
  }
  if (error instanceof PromptUnsupportedError) {
    return {
      code: error.code,
      message: error.message,
      action: '请在交互式终端中重试。',
    };
  }
  return {
    code: error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : fallbackCode,
    message: fallbackMessage,
    action: stage === 'authenticate' ? '请检查账号、密码和 relay 服务后重试。' : undefined,
  };
}

function configErrorMessage(code: ConfigStoreError['code']) {
  if (code === 'config_busy') return '共享配置正被其他进程使用。';
  if (code === 'config_aborted') return '配置操作已取消。';
  if (code === 'invalid_json') return '共享配置不是有效 JSON。';
  if (code === 'invalid_config') return '共享配置的 CLI 字段无效。';
  if (code === 'config_read_failed') return '无法读取共享配置。';
  return '无法提交共享配置。';
}

function isCancellation(error: unknown) {
  return error instanceof PromptCancelledError
    || (error instanceof AccountClientError && error.code === 'cancelled')
    || (error instanceof ConfigStoreError && error.code === 'config_aborted')
    || (error instanceof Error && error.name === 'AbortError');
}

function cancelledStage(error: unknown, fallback: string) {
  return error instanceof PromptCancelledError ? error.stage : fallback;
}

function authSession(
  account: {
    user: { id: string; username: string };
    accessToken: string;
  },
  options: LoginCommandOptions,
): NewAuthSession {
  return {
    loginId: (options.createLoginId ?? randomUUID)(),
    userId: account.user.id,
    username: account.user.username,
    accessToken: account.accessToken,
    authenticatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

export async function loginCommand(options: LoginCommandOptions): Promise<LoginCommandResult> {
  const accountState = new AccountState({ store: options.store });
  let server: CliServer | undefined;
  try {
    server = await readCliServer(options.store, options.signal);
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'config' };
    return {
      kind: 'failed',
      stage: 'config',
      error: toCommandError('config', error, 'config_read_failed', '无法读取共享配置。'),
    };
  }

  if (options.fromConfig && !server) {
    return {
      kind: 'failed',
      stage: 'server',
      error: {
        code: 'server_required',
        message: 'zterm.cli.server.relayBaseUrl 未配置。',
        action: '请先在共享配置中配置 relay 服务器。',
      },
    };
  }

  let attempt: LoginAttempt;
  let username: string;
  let password: string;
  try {
    const begin = await accountState.beginLogin(
      { consumeConfigPassword: options.fromConfig },
      options.signal,
    );
    attempt = begin.attempt;
    if (options.fromConfig) {
      server = begin.attempt.serverAtBegin;
      if (!server) {
        return {
          kind: 'failed',
          stage: 'server',
          error: {
            code: 'server_required',
            message: 'zterm.cli.server.relayBaseUrl 未配置。',
            action: '请先在共享配置中配置 relay 服务器。',
          },
        };
      }
      if (!begin.input) {
        return {
          kind: 'failed',
          stage: 'login-input',
          error: {
            code: 'login_input_required',
            message: '共享配置缺少一次性的 loginInput 账号和密码。',
            action: '请补齐 username 与 password 后重试。',
          },
        };
      }
      username = begin.input.username;
      password = begin.input.password;
    } else {
      server = begin.attempt.serverAtBegin;
      if (!server) {
        try {
          server = {
            relayBaseUrl: await options.prompts.text('relay 服务器 URL: '),
          };
        } catch (error) {
          if (error instanceof PromptCancelledError) {
            return { kind: 'cancelled', stage: 'server' };
          }
          return {
            kind: 'failed',
            stage: 'server',
            error: toCommandError(
              'server',
              error,
              'server_prompt_failed',
              '无法读取 relay 服务器地址。',
            ),
          };
        }
      }
      try {
        username = await options.prompts.text('账号: ');
        password = await options.prompts.password('密码: ');
      } catch (error) {
        if (error instanceof PromptCancelledError) {
          return { kind: 'cancelled', stage: 'credentials' };
        }
        return {
          kind: 'failed',
          stage: 'credentials',
          error: toCommandError(
            'credentials',
            error,
            'credentials_prompt_failed',
            '无法读取登录凭据。',
          ),
        };
      }
    }
  } catch (error) {
    if (isCancellation(error)) {
      return { kind: 'cancelled', stage: cancelledStage(error, 'begin-login') };
    }
    return {
      kind: 'failed',
      stage: 'begin-login',
      error: toCommandError(
        'begin-login',
        error,
        'login_begin_failed',
        '无法登记登录事务。',
      ),
    };
  }

  let authenticated;
  try {
    authenticated = await options.account.login(
      {
        relayBaseUrl: server!.relayBaseUrl,
        username: username!,
        password: password!,
      },
      options.signal ?? new AbortController().signal,
    );
  } catch (error) {
    if (isCancellation(error)) {
      return { kind: 'cancelled', stage: 'authenticate' };
    }
    return {
      kind: 'failed',
      stage: 'authenticate',
      error: toCommandError(
        'authenticate',
        error,
        'login_failed',
        '登录失败，未保存新的登录态。',
      ),
    };
  }

  try {
    const committed = await accountState.commitLogin(
      attempt,
      { relayBaseUrl: authenticated.relayBaseUrl },
      authSession(authenticated, options),
      options.signal,
    );
    if (committed.kind === 'login_superseded') {
      return {
        kind: 'failed',
        stage: 'commit',
        error: {
          code: 'login_superseded',
          message: '本次登录已被较新的登录或登出取代。',
          action: '请重新运行 zterm login。',
        },
      };
    }
    if (committed.kind === 'login_server_changed') {
      return {
        kind: 'failed',
        stage: 'commit',
        error: {
          code: 'login_server_changed',
          message: '登录期间 relay 服务器配置已改变。',
          action: '请确认服务器后重新运行 zterm login。',
        },
      };
    }
    return {
      kind: 'ok',
      value: {
        relayBaseUrl: authenticated.relayBaseUrl,
        userId: authenticated.user.id,
        username: authenticated.user.username,
        source: options.fromConfig ? 'config' : 'interactive',
        generation: committed.generation,
      },
    };
  } catch (error) {
    if (isCancellation(error)) {
      return { kind: 'cancelled', stage: 'commit' };
    }
    return {
      kind: 'failed',
      stage: 'commit',
      error: toCommandError(
        'commit',
        error,
        'login_commit_failed',
        '认证成功，但无法保存登录态。',
      ),
    };
  }
}

export async function logoutCommand(
  options: LogoutCommandOptions,
): Promise<LogoutCommandResult> {
  try {
    const result = await new AccountState({ store: options.store }).logout(options.signal);
    return {
      kind: 'ok',
      value: {
        generation: result.generation,
        message: [
          '已清除本机 CLI 登录态。',
          '本机使用该登录态的连接将停止使用；其他 CLI 进程通过 loginId 变化检测失效。',
          '服务器当前不提供远端 token 撤销接口；不能保证已复制 token 失效。',
          '服务器、槽位及 daemon 配置已保留。',
        ].join('\n'),
      },
    };
  } catch (error) {
    if (isCancellation(error)) return { kind: 'cancelled', stage: 'logout' };
    return {
      kind: 'failed',
      stage: 'logout',
      error: toCommandError('logout', error, 'logout_failed', '无法清除本机登录态。'),
    };
  }
}

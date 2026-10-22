import {
  ConfigStoreError,
  type JsonObject,
  type SharedConfigStore,
} from '../../shared/src/node/shared-config';

export interface CliServerConfig {
  relayBaseUrl: string;
}

export interface ConsumedLoginInput {
  username: string;
  password: string;
}

export interface LoginAttempt {
  generation: number;
  serverAtBegin: CliServerConfig | undefined;
}

export interface NewAuthSession {
  loginId: string;
  userId: string;
  username: string;
  accessToken: string;
  authenticatedAt: string;
}

export type LoginBeginResult =
  | { attempt: LoginAttempt; input?: undefined }
  | { attempt: LoginAttempt; input: ConsumedLoginInput };

export type LoginCommitResult =
  | { kind: 'committed'; generation: number; auth: NewAuthSession }
  | { kind: 'login_superseded'; generation: number }
  | { kind: 'login_server_changed'; generation: number };

export interface LogoutResult {
  kind: 'logged_out';
  generation: number;
}

export interface AccountStateOptions {
  store: SharedConfigStore;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cliObject(config: JsonObject, path: string) {
  if (config.zterm !== undefined && !isJsonObject(config.zterm)) {
    throw new ConfigStoreError('invalid_config', 'zterm must be a JSON object', path);
  }
  const zterm: JsonObject = isJsonObject(config.zterm) ? config.zterm : {};
  config.zterm = zterm;
  if (zterm.cli !== undefined && !isJsonObject(zterm.cli)) {
    throw new ConfigStoreError('invalid_config', 'zterm.cli must be a JSON object', path);
  }
  const cli: JsonObject = isJsonObject(zterm.cli) ? zterm.cli : {};
  zterm.cli = cli;
  return cli;
}

export function safeAuthGeneration(value: unknown) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return undefined;
  }
  return value;
}

function readServer(config: JsonObject): CliServerConfig | undefined {
  const zterm = config.zterm;
  const cli = isJsonObject(zterm) && isJsonObject(zterm.cli) ? zterm.cli : {};
  const server = cli.server;
  if (
    isJsonObject(server) &&
    typeof server.relayBaseUrl === 'string' &&
    server.relayBaseUrl.trim()
  ) {
    return { relayBaseUrl: server.relayBaseUrl };
  }
  return undefined;
}

function sameServer(a: CliServerConfig | undefined, b: CliServerConfig | undefined) {
  return a?.relayBaseUrl === b?.relayBaseUrl;
}

export class AccountState {
  private readonly store: SharedConfigStore;

  constructor(options: AccountStateOptions) {
    this.store = options.store;
  }

  async beginLogin(options: {
    consumeConfigPassword: boolean;
  }, signal?: AbortSignal): Promise<LoginBeginResult> {
    return this.store.update<LoginBeginResult>((latest) => {
      const cli = cliObject(latest, this.store.path);
      const currentGeneration = safeAuthGeneration(cli.authGeneration);
      if (currentGeneration === undefined || currentGeneration === Number.MAX_SAFE_INTEGER) {
        throw new ConfigStoreError(
          'invalid_config',
          'zterm.cli.authGeneration is invalid or cannot be incremented',
          this.store.path,
        );
      }
      cli.authGeneration = currentGeneration + 1;
      const attempt: LoginAttempt = {
        generation: currentGeneration + 1,
        serverAtBegin: readServer(latest),
      };
      let input: ConsumedLoginInput | undefined;
      if (options.consumeConfigPassword) {
        const loginInput = isJsonObject(cli.loginInput) ? cli.loginInput : undefined;
        if (loginInput &&
          typeof loginInput.username === 'string' &&
          typeof loginInput.password === 'string'
        ) {
          input = {
            username: loginInput.username,
            password: loginInput.password,
          };
          delete loginInput.password;
          if (Object.keys(loginInput).length === 0) {
            delete cli.loginInput;
          }
        }
      }
      return {
        value: input ? { attempt, input } : { attempt },
        changed: true,
      };
    }, signal);
  }

  async commitLogin(
    attempt: LoginAttempt,
    authenticatedServer: CliServerConfig,
    auth: NewAuthSession,
    signal?: AbortSignal,
  ): Promise<LoginCommitResult> {
    return this.store.update<LoginCommitResult>((latest) => {
      const cli = cliObject(latest, this.store.path);
      const currentGeneration = safeAuthGeneration(cli.authGeneration);
      if (currentGeneration === undefined) {
        throw new ConfigStoreError(
          'invalid_config',
          'zterm.cli.authGeneration is invalid',
          this.store.path,
        );
      }
      if (currentGeneration !== attempt.generation) {
        return {
          value: { kind: 'login_superseded', generation: currentGeneration },
          changed: false,
        };
      }
      if (!sameServer(readServer(latest), attempt.serverAtBegin)) {
        return {
          value: { kind: 'login_server_changed', generation: currentGeneration },
          changed: false,
        };
      }
      cli.server = {
        ...(isJsonObject(cli.server) ? cli.server : {}),
        relayBaseUrl: authenticatedServer.relayBaseUrl,
      };
      cli.auth = { ...auth };
      return {
        value: { kind: 'committed', generation: currentGeneration, auth },
        changed: true,
      };
    }, signal);
  }

  async logout(signal?: AbortSignal): Promise<LogoutResult> {
    return this.store.update((latest) => {
      const cli = cliObject(latest, this.store.path);
      const currentGeneration = safeAuthGeneration(cli.authGeneration);
      if (currentGeneration === undefined || currentGeneration === Number.MAX_SAFE_INTEGER) {
        throw new ConfigStoreError(
          'invalid_config',
          'zterm.cli.authGeneration is invalid or cannot be incremented',
          this.store.path,
        );
      }
      const nextGeneration = currentGeneration + 1;
      cli.authGeneration = nextGeneration;
      delete cli.auth;
      return {
        value: { kind: 'logged_out', generation: nextGeneration },
        changed: true,
      };
    }, signal);
  }
}

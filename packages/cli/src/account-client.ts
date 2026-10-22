import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
  RelayEndpointCandidate,
  RelayPresence,
  RelayTmuxSessionSnapshot,
} from '../../shared/src/connection/relay-directory.js';

export interface LoginInput {
  relayBaseUrl: string;
  username: string;
  password: string;
}

export interface RelayAccountUser {
  id: string;
  username: string;
  createdAt?: string;
}

export interface RelaySignalingWebSockets {
  devices?: string;
  host?: string;
  client?: string;
}

export interface RelayTurnConfig {
  url: string;
  username?: string;
  credential?: string;
}

export interface AuthenticatedAccount {
  relayBaseUrl: string;
  accessToken: string;
  user: RelayAccountUser;
  directory: RelayAccountDirectory;
  ws?: RelaySignalingWebSockets | null;
  turn?: RelayTurnConfig | null;
}

export type AuthSession = Pick<AuthenticatedAccount, 'relayBaseUrl' | 'accessToken'>;

export type AccountClientStage = 'login' | 'me' | 'directory';

export type AccountClientFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AccountClientErrorCode =
  | 'invalid_request'
  | 'cancelled'
  | 'network_failure'
  | 'http_failure'
  | 'auth_invalid'
  | 'response_invalid_json'
  | 'response_invalid';

const ENDPOINT_KINDS = new Set([
  'lan',
  'rtc-direct',
  'tailscale',
  'ipv6',
  'ipv4',
  'relay-rtc',
]);

export class AccountClientError extends Error {
  readonly stage: AccountClientStage;
  readonly code: AccountClientErrorCode;
  readonly status?: number;
  readonly action: string;

  constructor(
    message: string,
    options: {
      stage: AccountClientStage;
      code: AccountClientErrorCode;
      status?: number;
      action: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AccountClientError';
    this.stage = options.stage;
    this.code = options.code;
    this.status = options.status;
    this.action = options.action;
  }
}

export class AccountClient {
  constructor(private readonly fetchImpl: AccountClientFetch = fetch) {}

  async login(input: LoginInput, signal: AbortSignal): Promise<AuthenticatedAccount> {
    const relayBaseUrl = normalizeRelayBaseUrl(input.relayBaseUrl, 'login');
    const username = requireLoginUsername(input.username);
    const password = requireLoginPassword(input.password);
    const url = buildEndpointUrl(relayBaseUrl, '/api/auth/login');

    const payload = await this.requestJson(
      'login',
      url,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      },
      signal,
    );
    return this.authenticatedFromPayload('login', payload, {
      relayBaseUrl,
      accessToken: '',
    }, true);
  }

  async me(auth: AuthSession, signal: AbortSignal): Promise<AuthenticatedAccount> {
    const normalized = normalizeAuthSession(auth, 'me');
    const url = buildEndpointUrl(normalized.relayBaseUrl, '/api/auth/me');
    const payload = await this.requestJson(
      'me',
      url,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: bearer(normalized.accessToken),
        },
      },
      signal,
    );
    return this.authenticatedFromPayload('me', payload, normalized, false);
  }

  async directory(auth: AuthSession, signal: AbortSignal): Promise<RelayAccountDirectory> {
    const normalized = normalizeAuthSession(auth, 'directory');
    const url = buildEndpointUrl(normalized.relayBaseUrl, '/api/directory');
    const payload = await this.requestJson(
      'directory',
      url,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: bearer(normalized.accessToken),
        },
      },
      signal,
    );
    const record = requireRecord(payload, 'directory', 'directory');
    const user = validateUser(record.user, 'directory');
    const directory = validateDirectory(record.directory, 'directory');
    requireSameAccountUser(directory.user.id, user.id, 'directory');
    return directory;
  }

  private async requestJson(
    stage: AccountClientStage,
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw cancelledError(stage, signal.reason);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw cancelledError(stage, signal.reason);
      }
      throw new AccountClientError(
        `${publicStage(stage)}网络请求失败。`,
        {
          stage,
          code: 'network_failure',
          action: '请检查网络和 relay 地址后重试。',
          cause: error,
        },
      );
    }

    if (response.status === 401 || response.status === 403) {
      response.body?.cancel().catch(() => undefined);
      throw new AccountClientError(
        stage === 'login'
          ? `登录失败（HTTP ${response.status}）。请检查账号和密码后重试。`
          : `登录已失效或无访问权限（HTTP ${response.status}）。请运行 zterm login。`,
        {
          stage,
          code: 'auth_invalid',
          status: response.status,
          action: stage === 'login' ? '请检查账号和密码后重试。' : '请运行 zterm login。',
        },
      );
    }

    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new AccountClientError(
        `${publicStage(stage)}请求失败（HTTP ${response.status}）。`,
        {
          stage,
          code: 'http_failure',
          status: response.status,
          action: '请稍后重试或检查 relay 服务。',
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal.aborted) {
        throw cancelledError(stage, signal.reason);
      }
      throw new AccountClientError(
        `${publicStage(stage)}返回了非 JSON 响应。`,
        {
          stage,
          code: 'response_invalid_json',
          action: '请检查 relay 服务版本或稍后重试。',
          cause: error,
        },
      );
    }
    return requireRecord(payload, stage, 'response');
  }

  private authenticatedFromPayload(
    stage: AccountClientStage,
    payload: Record<string, unknown>,
    auth: AuthSession,
    requireAccessToken: boolean,
  ): AuthenticatedAccount {
    const accessToken = isUsableAccessToken(payload.accessToken)
      ? payload.accessToken
      : requireAccessToken
        ? undefined
        : auth.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw responseInvalidError(stage, '认证响应缺少 accessToken 字段。');
    }

    const user = validateUser(payload.user, stage);
    const directory = validateDirectory(payload.directory, stage);
    requireSameAccountUser(directory.user.id, user.id, stage);

    const result: AuthenticatedAccount = {
      relayBaseUrl: auth.relayBaseUrl,
      accessToken,
      user,
      directory,
    };
    if (payload.ws !== undefined) {
      result.ws = validateWebSockets(payload.ws, stage);
    }
    if (payload.turn !== undefined) {
      result.turn = validateTurn(payload.turn, stage);
    }
    return result;
  }
}

function publicStage(stage: AccountClientStage) {
  if (stage === 'login') {
    return '登录';
  }
  if (stage === 'me') {
    return '账号校验';
  }
  return '目录读取';
}

function cancelledError(stage: AccountClientStage, reason: unknown) {
  return new AccountClientError(
    `${publicStage(stage)}请求已取消。`,
    {
      stage,
      code: 'cancelled',
      action: '请重试。',
      cause: reason,
    },
  );
}

function responseInvalidError(stage: AccountClientStage, message: string) {
  return new AccountClientError(message, {
    stage,
    code: 'response_invalid',
    action: '请检查 relay 服务版本或稍后重试。',
  });
}

function normalizeRelayBaseUrl(input: string, stage: AccountClientStage) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw invalidRequestError(stage, '缺少 relay 地址。');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw invalidRequestError(stage, 'relay 地址不是有效 URL。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidRequestError(stage, 'relay 地址只支持 http 或 https。');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw invalidRequestError(stage, 'relay 地址不能带查询参数或 fragment。');
  }
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function buildEndpointUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ''), baseUrl).toString();
}

function requireLoginUsername(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidRequestError('login', '登录缺少用户名。');
  }
  return value;
}

function requireLoginPassword(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidRequestError('login', '登录缺少密码。');
  }
  return value;
}

function invalidRequestError(stage: AccountClientStage, message: string) {
  return new AccountClientError(message, {
    stage,
    code: 'invalid_request',
    action: stage === 'login' ? '请修正 relay 地址和登录输入后重试。' : '请运行 zterm login。',
  });
}

function normalizeAuthSession(auth: AuthSession, stage: AccountClientStage): AuthSession {
  const relayBaseUrl = normalizeRelayBaseUrl(auth.relayBaseUrl, stage);
  if (!isUsableAccessToken(auth.accessToken)) {
    throw new AccountClientError('缺少有效账号访问令牌。', {
      stage,
      code: 'invalid_request',
      action: '请运行 zterm login。',
    });
  }
  return {
    relayBaseUrl,
    accessToken: auth.accessToken,
  };
}

function bearer(accessToken: string) {
  return `Bearer ${accessToken}`;
}

function isUsableAccessToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/[\r\n]/.test(value);
}

function requireRecord(value: unknown, stage: AccountClientStage, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw responseInvalidError(stage, `认证响应中的 ${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, stage: AccountClientStage, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw responseInvalidError(stage, `认证响应缺少有效 ${label} 字段。`);
  }
  return value;
}

function requireStringAllowEmpty(value: unknown, stage: AccountClientStage, label: string) {
  if (typeof value !== 'string') {
    throw responseInvalidError(stage, `认证响应中的 ${label} 字段类型错误。`);
  }
  return value;
}

function optionalString(value: unknown, stage: AccountClientStage, label: string) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw responseInvalidError(stage, `认证响应中的 ${label} 字段类型错误。`);
  }
  return value;
}

function requireBoolean(value: unknown, stage: AccountClientStage, label: string) {
  if (typeof value !== 'boolean') {
    throw responseInvalidError(stage, `认证响应中的 ${label} 字段类型错误。`);
  }
  return value;
}

function validateUser(value: unknown, stage: AccountClientStage): RelayAccountUser {
  const record = requireRecord(value, stage, 'user');
  requireString(record.id, stage, 'user.id');
  requireString(record.username, stage, 'user.username');
  optionalString(record.createdAt, stage, 'user.createdAt');
  return value as RelayAccountUser;
}

function validateDirectory(value: unknown, stage: AccountClientStage): RelayAccountDirectory {
  const record = requireRecord(value, stage, 'directory');
  if (record.schemaVersion !== 1) {
    throw responseInvalidError(stage, '目录 schemaVersion 必须为 1。');
  }
  const user = requireRecord(record.user, stage, 'directory.user');
  requireString(user.id, stage, 'directory.user.id');
  requireString(user.username, stage, 'directory.user.username');
  requireStringAllowEmpty(record.updatedAt, stage, 'directory.updatedAt');
  if (!Array.isArray(record.devices)) {
    throw responseInvalidError(stage, '目录 devices 必须是数组。');
  }
  record.devices.forEach((device) => validateDevice(device, stage));
  return value as unknown as RelayAccountDirectory;
}

function validateDevice(value: unknown, stage: AccountClientStage): RelayDirectoryDevice {
  const record = requireRecord(value, stage, 'device');
  requireString(record.deviceId, stage, 'device.deviceId');
  requireStringAllowEmpty(record.deviceName, stage, 'device.deviceName');
  requireStringAllowEmpty(record.platform, stage, 'device.platform');
  requireStringAllowEmpty(record.appVersion, stage, 'device.appVersion');
  validatePresence(record.client, stage);
  if (record.daemon !== null) {
    validateDaemon(record.daemon, stage);
  }
  return value as unknown as RelayDirectoryDevice;
}

function validatePresence(value: unknown, stage: AccountClientStage): RelayPresence {
  const record = requireRecord(value, stage, 'presence');
  requireBoolean(record.connected, stage, 'presence.connected');
  requireStringAllowEmpty(record.lastSeenAt, stage, 'presence.lastSeenAt');
  return value as unknown as RelayPresence;
}

function validateDaemon(value: unknown, stage: AccountClientStage): RelayDirectoryDaemon {
  const record = requireRecord(value, stage, 'daemon');
  requireString(record.hostId, stage, 'daemon.hostId');
  requireStringAllowEmpty(record.version, stage, 'daemon.version');
  validatePresence(record.presence, stage);
  if (!Array.isArray(record.endpoints)) {
    throw responseInvalidError(stage, 'daemon.endpoints 必须是数组。');
  }
  record.endpoints.forEach((endpoint) => validateEndpoint(endpoint, stage));
  if (!Array.isArray(record.sessions)) {
    throw responseInvalidError(stage, 'daemon.sessions 必须是数组。');
  }
  record.sessions.forEach((session) => validateSession(session, stage));
  requireStringAllowEmpty(record.lastPublishedAt, stage, 'daemon.lastPublishedAt');
  return value as unknown as RelayDirectoryDaemon;
}

function validateEndpoint(value: unknown, stage: AccountClientStage): RelayEndpointCandidate {
  const record = requireRecord(value, stage, 'endpoint');
  requireString(record.id, stage, 'endpoint.id');
  const kind = requireString(record.kind, stage, 'endpoint.kind');
  if (!ENDPOINT_KINDS.has(kind)) {
    throw responseInvalidError(stage, 'endpoint.kind 不受支持。');
  }
  requireBoolean(record.authRequired, stage, 'endpoint.authRequired');
  requireStringAllowEmpty(record.lastSeenAt, stage, 'endpoint.lastSeenAt');
  optionalString(record.host, stage, 'endpoint.host');
  optionalString(record.wsUrl, stage, 'endpoint.wsUrl');
  optionalString(record.relayHostId, stage, 'endpoint.relayHostId');
  optionalString(record.authToken, stage, 'endpoint.authToken');
  if (
    record.port !== undefined
    && (typeof record.port !== 'number'
      || !Number.isInteger(record.port)
      || record.port < 1
      || record.port > 65_535)
  ) {
    throw responseInvalidError(stage, 'endpoint.port 无效。');
  }
  return value as unknown as RelayEndpointCandidate;
}

function validateSession(value: unknown, stage: AccountClientStage): RelayTmuxSessionSnapshot {
  const record = requireRecord(value, stage, 'session');
  requireString(record.name, stage, 'session.name');
  requireStringAllowEmpty(record.updatedAt, stage, 'session.updatedAt');
  optionalString(record.cwd, stage, 'session.cwd');
  optionalString(record.title, stage, 'session.title');
  return value as unknown as RelayTmuxSessionSnapshot;
}

function validateWebSockets(value: unknown, stage: AccountClientStage): RelaySignalingWebSockets | null {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, stage, 'ws');
  optionalString(record.devices, stage, 'ws.devices');
  optionalString(record.host, stage, 'ws.host');
  optionalString(record.client, stage, 'ws.client');
  return value as unknown as RelaySignalingWebSockets;
}

function validateTurn(value: unknown, stage: AccountClientStage): RelayTurnConfig | null {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, stage, 'turn');
  requireString(record.url, stage, 'turn.url');
  optionalString(record.username, stage, 'turn.username');
  optionalString(record.credential, stage, 'turn.credential');
  return value as unknown as RelayTurnConfig;
}

function requireSameAccountUser(directoryUserId: string, authenticatedUserId: string, stage: AccountClientStage) {
  if (directoryUserId !== authenticatedUserId) {
    throw responseInvalidError(stage, '目录账号与认证账号不一致。');
  }
}

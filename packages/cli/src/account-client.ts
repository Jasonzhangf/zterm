import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
  RelayEndpointCandidate,
  RelayPresence,
  RelayTmuxSessionSnapshot,
} from '../../shared/src/connection/relay-directory.js';
import {
  CLI_SLOT_CONFIG_SCHEMA_VERSION,
  SlotConfigValidationError,
  parseCloudSlotState,
  parseSyncedSlotBinding,
  parseSyncedSlots,
  type CloudSlotResponse,
  type SyncedSlot,
  type SyncedSlotBinding,
} from '../../shared/src/connection/cli-slot-config.js';

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

export type AccountClientStage = 'login' | 'me' | 'directory' | 'slot-read' | 'slot-write';

export type AccountClientFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AccountClientErrorCode =
  | 'invalid_request'
  | 'cancelled'
  | 'network_failure'
  | 'http_failure'
  | 'auth_invalid'
  | 'response_invalid_json'
  | 'response_invalid'
  | 'cloud_sync_unsupported'
  | 'invalid_slot_config'
  | 'invalid_device_set'
  | 'device_cleanup_rejected'
  | 'request_too_large'
  | 'slot_config_unavailable'
  | 'persistence_failed';

const ENDPOINT_KINDS = new Set([
  'lan',
  'rtc-direct',
  'tailscale',
  'ipv6',
  'ipv4',
  'relay-rtc',
]);

const SLOT_STATUS_ACTIONS: Partial<Record<number, string>> = {
  400: '请检查本地槽位数据后修正。',
  409: '请刷新后重试，避免删除仍被引用的设备。',
  413: '槽位数据过大，请减少数量或体积后重试。',
  503: '请稍后重试或检查 relay 服务。',
};

const SLOT_SERVER_ERROR_STATUS = new Map<AccountClientErrorCode, number>([
  ['invalid_request', 400],
  ['invalid_slot_config', 400],
  ['invalid_device_set', 400],
  ['auth_invalid', 401],
  ['device_cleanup_rejected', 409],
  ['request_too_large', 413],
  ['slot_config_unavailable', 503],
  ['persistence_failed', 503],
]);

function isSlotStage(stage: AccountClientStage): boolean {
  return stage === 'slot-read' || stage === 'slot-write';
}

function slotHttpAction(
  stage: AccountClientStage,
  status: number,
  definitiveRejection: boolean,
): string {
  if (stage === 'slot-write' && !definitiveRejection) {
    return '请先重新读取云端槽位确认当前内容，再决定是否再次推送。';
  }
  if (status === 401) {
    return '请运行 zterm login。';
  }
  if (stage === 'slot-read' && status === 503) {
    return '请稍后重试或检查 relay 服务。';
  }
  return SLOT_STATUS_ACTIONS[status] ?? '请稍后重试或检查 relay 服务。';
}

function slotServerErrorCode(value: unknown): AccountClientErrorCode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return SLOT_SERVER_ERROR_STATUS.has(value as AccountClientErrorCode)
    ? value as AccountClientErrorCode
    : undefined;
}

function validateOutboundSlots(slots: readonly SyncedSlot[]): SyncedSlot[] {
  if (!Array.isArray(slots)) {
    throw invalidRequestError('slot-write', '槽位集合必须是数组。', false);
  }
  try {
    return parseSyncedSlots(slots as unknown[]);
  } catch (error) {
    throw outboundSlotError('槽位数据未通过共享校验。', error);
  }
}

function validateOutboundBinding(binding: SyncedSlotBinding): SyncedSlotBinding {
  try {
    return parseSyncedSlotBinding(binding);
  } catch (error) {
    throw outboundSlotError('槽位绑定未通过共享校验。', error);
  }
}

function requireSlotNumber(slot: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > 20) {
    throw invalidRequestError('slot-write', '槽位号必须是 1 到 20 的整数。', false);
  }
  return slot;
}

function outboundSlotError(message: string, cause: unknown): AccountClientError {
  return new AccountClientError(message, {
    stage: 'slot-write',
    code: 'invalid_request',
    action: '请修正本地槽位数据后重试。',
    requestDispatched: false,
    cause,
  });
}

function parseCloudSlotResponse(
  stage: AccountClientStage,
  payload: Record<string, unknown>,
  requestDispatched: boolean,
): CloudSlotResponse {
  if (payload.ok !== true) {
    throw responseInvalidError(stage, '云槽响应 ok 必须为 true。', requestDispatched);
  }
  if (payload.schemaVersion !== CLI_SLOT_CONFIG_SCHEMA_VERSION) {
    throw responseInvalidError(stage, `云槽 schemaVersion 必须为 ${CLI_SLOT_CONFIG_SCHEMA_VERSION}。`, requestDispatched);
  }
  const user = requireRecord(payload.user, stage, 'user', requestDispatched);
  const userId = requireString(user.id, stage, 'user.id', requestDispatched);
  let config: CloudSlotResponse['config'];
  try {
    config = parseCloudSlotState(payload.config);
  } catch (error) {
    throw new AccountClientError(`云槽配置未通过共享校验：${describeSlotCause(error)}`, {
      stage,
      code: 'response_invalid',
      action: '请检查 relay 服务版本或稍后重试。',
      requestDispatched,
      cause: error,
    });
  }
  return { userId, config };
}

function describeSlotCause(error: unknown): string {
  if (error instanceof SlotConfigValidationError) {
    return error.field;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown';
}

async function readSlotApiError(
  response: Response,
): Promise<{ code: AccountClientErrorCode; definitiveRejection: true } | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope.ok !== false) {
    return undefined;
  }
  const error = envelope.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const code = slotServerErrorCode((error as Record<string, unknown>).code);
  if (code === undefined || SLOT_SERVER_ERROR_STATUS.get(code) !== response.status) {
    return undefined;
  }
  return { code, definitiveRejection: true };
}

export class AccountClientError extends Error {
  readonly stage: AccountClientStage;
  readonly code: AccountClientErrorCode;
  readonly status?: number;
  readonly action: string;
  readonly requestDispatched?: boolean;
  readonly definitiveRejection: boolean;

  constructor(
    message: string,
    options: {
      stage: AccountClientStage;
      code: AccountClientErrorCode;
      status?: number;
      action: string;
      requestDispatched?: boolean;
      definitiveRejection?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AccountClientError';
    this.stage = options.stage;
    this.code = options.code;
    this.status = options.status;
    this.action = options.action;
    this.requestDispatched = options.requestDispatched;
    this.definitiveRejection = options.definitiveRejection ?? false;
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

  async readSlotConfig(auth: AuthSession, signal: AbortSignal): Promise<CloudSlotResponse> {
    const normalized = normalizeAuthSession(auth, 'slot-read', false);
    const url = buildEndpointUrl(normalized.relayBaseUrl, '/api/cli/slots');
    const payload = await this.requestJson(
      'slot-read',
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
    return parseCloudSlotResponse('slot-read', payload, true);
  }

  async replaceSlotConfig(
    auth: AuthSession,
    slots: readonly SyncedSlot[],
    signal: AbortSignal,
  ): Promise<CloudSlotResponse> {
    const normalized = normalizeAuthSession(auth, 'slot-write', false);
    const validatedSlots = validateOutboundSlots(slots);
    const url = buildEndpointUrl(normalized.relayBaseUrl, '/api/cli/slots');
    const payload = await this.requestJson(
      'slot-write',
      url,
      {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          authorization: bearer(normalized.accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION,
          slots: validatedSlots,
        }),
      },
      signal,
    );
    return parseCloudSlotResponse('slot-write', payload, true);
  }

  async replaceSlot(
    auth: AuthSession,
    slot: number,
    binding: SyncedSlotBinding,
    signal: AbortSignal,
  ): Promise<CloudSlotResponse> {
    const normalized = normalizeAuthSession(auth, 'slot-write', false);
    const validatedSlot = requireSlotNumber(slot);
    const validatedBinding = validateOutboundBinding(binding);
    const url = buildEndpointUrl(normalized.relayBaseUrl, `/api/cli/slots/${validatedSlot}`);
    const payload = await this.requestJson(
      'slot-write',
      url,
      {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          authorization: bearer(normalized.accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION,
          binding: validatedBinding,
        }),
      },
      signal,
    );
    return parseCloudSlotResponse('slot-write', payload, true);
  }

  private async requestJson(
    stage: AccountClientStage,
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw cancelledError(stage, signal.reason, false);
    }

    let requestDispatched = false;
    let response: Response;
    try {
      requestDispatched = true;
      response = await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw cancelledError(stage, signal.reason, requestDispatched);
      }
      throw new AccountClientError(
        `${publicStage(stage)}网络请求失败。`,
        {
          stage,
          code: 'network_failure',
          action: '请检查网络和 relay 地址后重试。',
          requestDispatched,
          cause: error,
        },
      );
    }

    if (!isSlotStage(stage) && (response.status === 401 || response.status === 403)) {
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
          requestDispatched,
        },
      );
    }

    if (isSlotStage(stage) && response.status === 404) {
      response.body?.cancel().catch(() => undefined);
      throw new AccountClientError(
        '云槽同步接口不可用（HTTP 404）。',
        {
          stage,
          code: 'cloud_sync_unsupported',
          status: response.status,
          action: '请升级 relay 服务或联系管理员启用云槽同步。',
          requestDispatched,
        },
      );
    }

    if (!response.ok) {
      const serverError = isSlotStage(stage)
        ? await readSlotApiError(response)
        : undefined;
      if (signal.aborted) {
        throw cancelledError(stage, signal.reason, requestDispatched);
      }
      if (serverError === undefined) {
        response.body?.cancel().catch(() => undefined);
      }
      const definitiveRejection = serverError?.definitiveRejection ?? false;
      throw new AccountClientError(
        `${publicStage(stage)}请求失败（HTTP ${response.status}）。`,
        {
          stage,
          code: serverError?.code ?? 'http_failure',
          status: response.status,
          action: isSlotStage(stage)
            ? slotHttpAction(stage, response.status, definitiveRejection)
            : '请稍后重试或检查 relay 服务。',
          requestDispatched,
          definitiveRejection,
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal.aborted) {
        throw cancelledError(stage, signal.reason, requestDispatched);
      }
      throw new AccountClientError(
        `${publicStage(stage)}返回了非 JSON 响应。`,
        {
          stage,
          code: 'response_invalid_json',
          action: '请检查 relay 服务版本或稍后重试。',
          requestDispatched,
          cause: error,
        },
      );
    }
    return requireRecord(payload, stage, 'response', requestDispatched);
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
  if (stage === 'directory') {
    return '目录读取';
  }
  if (stage === 'slot-read') {
    return '云槽读取';
  }
  return '云槽写入';
}

function cancelledError(
  stage: AccountClientStage,
  reason: unknown,
  requestDispatched?: boolean,
) {
  return new AccountClientError(
    `${publicStage(stage)}请求已取消。`,
    {
      stage,
      code: 'cancelled',
      action: '请重试。',
      requestDispatched,
      cause: reason,
    },
  );
}

function responseInvalidError(
  stage: AccountClientStage,
  message: string,
  requestDispatched?: boolean,
) {
  return new AccountClientError(message, {
    stage,
    code: 'response_invalid',
    action: '请检查 relay 服务版本或稍后重试。',
    requestDispatched,
  });
}

function normalizeRelayBaseUrl(
  input: string,
  stage: AccountClientStage,
  requestDispatched?: boolean,
) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw invalidRequestError(stage, '缺少 relay 地址。', requestDispatched);
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw invalidRequestError(stage, 'relay 地址不是有效 URL。', requestDispatched);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidRequestError(stage, 'relay 地址只支持 http 或 https。', requestDispatched);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw invalidRequestError(stage, 'relay 地址不能带查询参数或 fragment。', requestDispatched);
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

function invalidRequestError(
  stage: AccountClientStage,
  message: string,
  requestDispatched?: boolean,
) {
  return new AccountClientError(message, {
    stage,
    code: 'invalid_request',
    action: stage === 'login' ? '请修正 relay 地址和登录输入后重试。' : '请运行 zterm login。',
    requestDispatched,
  });
}

function normalizeAuthSession(
  auth: AuthSession,
  stage: AccountClientStage,
  requestDispatched?: boolean,
): AuthSession {
  const relayBaseUrl = normalizeRelayBaseUrl(auth.relayBaseUrl, stage, requestDispatched);
  if (!isUsableAccessToken(auth.accessToken)) {
    throw new AccountClientError('缺少有效账号访问令牌。', {
      stage,
      code: 'invalid_request',
      action: '请运行 zterm login。',
      requestDispatched,
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

function requireRecord(
  value: unknown,
  stage: AccountClientStage,
  label: string,
  requestDispatched?: boolean,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw responseInvalidError(stage, `认证响应中的 ${label} 必须是对象。`, requestDispatched);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  stage: AccountClientStage,
  label: string,
  requestDispatched?: boolean,
) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw responseInvalidError(stage, `认证响应缺少有效 ${label} 字段。`, requestDispatched);
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

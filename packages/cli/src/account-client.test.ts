import { describe, expect, it } from 'vitest';
import {
  AccountClient,
  AccountClientError,
  type AuthenticatedAccount,
} from './account-client.js';
import type { RelayAccountDirectory } from '../../shared/src/connection/relay-directory.js';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string;
  body: string;
  signal: AbortSignal | null;
}

const user = {
  id: 'user-1',
  username: 'jason',
  createdAt: '2026-10-20T00:00:00.000Z',
};

const directory: RelayAccountDirectory = {
  schemaVersion: 1,
  user: {
    id: 'user-1',
    username: 'jason',
  },
  devices: [{
    deviceId: 'device-1',
    deviceName: 'Mac Studio',
    platform: 'darwin',
    appVersion: '1.0.0',
    client: {
      connected: false,
      lastSeenAt: '2026-10-20T00:00:01.000Z',
    },
    daemon: {
      hostId: 'daemon-1',
      version: '0.1.2',
      presence: {
        connected: true,
        lastSeenAt: '2026-10-20T00:00:02.000Z',
      },
      endpoints: [{
        id: 'endpoint-1',
        kind: 'lan',
        host: '192.0.2.10',
        port: 3333,
        authToken: 'daemon-endpoint-token',
        authRequired: true,
        lastSeenAt: '2026-10-20T00:00:02.000Z',
      }],
      sessions: [{
        name: 'work',
        cwd: '/srv/work',
        updatedAt: '2026-10-20T00:00:02.000Z',
      }],
      lastPublishedAt: '2026-10-20T00:00:02.000Z',
    },
  }],
  updatedAt: '2026-10-20T00:00:03.000Z',
};

type FetchHandler = (request: CapturedRequest) => Response | Promise<Response>;

function createContractFetch(handler: FetchHandler) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const captured: CapturedRequest = {
      method: init?.method || 'GET',
      url: String(input),
      authorization: headers.get('authorization') || '',
      body: typeof init?.body === 'string' ? init.body : '',
      signal: init?.signal || null,
    };
    requests.push(captured);
    return handler(captured);
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function plainText(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('AccountClient', () => {
  it('rejects an empty relay URL without supplying a default or sending a request', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({});
    }) as typeof fetch;
    const client = new AccountClient(fetchImpl);

    await expect(client.login({
      relayBaseUrl: '',
      username: 'jason',
      password: 'login-password',
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'AccountClientError',
      stage: 'login',
      code: 'invalid_request',
    });
    expect(calls).toBe(0);
  });

  it('preserves the relay routePath prefix and returns the HTTP accessToken context', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl, requests } = createContractFetch(() => {
      return json({
        ok: true,
        accessToken: 'account-access-token',
        token: 'internal-store-token',
        user,
        directory,
        ws: {
          devices: `${baseUrl}ws/devices`,
          host: `${baseUrl}ws/host`,
          client: `${baseUrl}ws/client`,
        },
        turn: {
          url: 'turn:relay.example.test:3478?transport=udp',
          username: 'turn-user',
          credential: 'turn-secret',
        },
      });
    });
    const client = new AccountClient(fetchImpl);

    const auth = await client.login({
      relayBaseUrl: baseUrl,
      username: 'jason',
      password: 'login-password',
    }, new AbortController().signal);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `${baseUrl}api/auth/login`,
      authorization: '',
    });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      username: 'jason',
      password: 'login-password',
    });
    expect(auth).toEqual({
      relayBaseUrl: baseUrl,
      accessToken: 'account-access-token',
      user,
      directory,
      ws: {
        devices: `${baseUrl}ws/devices`,
        host: `${baseUrl}ws/host`,
        client: `${baseUrl}ws/client`,
      },
      turn: {
        url: 'turn:relay.example.test:3478?transport=udp',
        username: 'turn-user',
        credential: 'turn-secret',
      },
    });
    expect(auth).not.toHaveProperty('token');
  });

  it('uses the account Bearer token for me and directory without changing daemon endpoint fields', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl, requests } = createContractFetch((request) => {
      if (request.url.endsWith('/api/auth/me')) {
        return json({
          ok: true,
          user,
          directory,
          ws: {
            client: `${baseUrl}ws/client`,
          },
          turn: null,
        });
      }
      if (request.url.endsWith('/api/directory')) {
        return json({
          ok: true,
          user,
          directory,
        });
      }
      return json({ message: `unexpected ${request.url}` }, 404);
    });
    const client = new AccountClient(fetchImpl);
    const auth = {
      relayBaseUrl: baseUrl,
      accessToken: 'account-access-token',
    };

    const context = await client.me(auth, new AbortController().signal);
    const currentDirectory = await client.directory(auth, new AbortController().signal);

    expect(context.accessToken).toBe('account-access-token');
    expect(context.directory).toEqual(directory);
    expect(context.directory.devices[0]!.daemon!.endpoints[0]!.authToken).toBe('daemon-endpoint-token');
    expect(context.turn).toBeNull();
    expect(currentDirectory).toEqual(directory);
    expect(currentDirectory.devices[0]!.daemon!.endpoints[0]!.authToken).toBe('daemon-endpoint-token');
    expect(requests.map((request) => ({
      url: request.url,
      authorization: request.authorization,
    }))).toEqual([
      {
        url: `${baseUrl}api/auth/me`,
        authorization: 'Bearer account-access-token',
      },
      {
        url: `${baseUrl}api/directory`,
        authorization: 'Bearer account-access-token',
      },
    ]);
  });

  it('rejects missing or renamed required response fields as a protocol error', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl } = createContractFetch(() => {
      return json({
        ok: true,
        token: 'must-not-be-treated-as-access-token',
        user,
        directory,
      });
    });
    const client = new AccountClient(fetchImpl);

    await expect(client.login({
      relayBaseUrl: baseUrl,
      username: 'jason',
      password: 'login-password',
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'AccountClientError',
      stage: 'login',
      code: 'response_invalid',
    });
  });

  it('rejects a me response without the required directory', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl } = createContractFetch(() => json({
      ok: true,
      user,
    }));
    const client = new AccountClient(fetchImpl);

    await expect(client.me({
      relayBaseUrl: baseUrl,
      accessToken: 'account-access-token',
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'AccountClientError',
      stage: 'me',
      code: 'response_invalid',
    });
  });

  it('rejects a directory account that does not match the authenticated user', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl } = createContractFetch(() => json({
      ok: true,
      user,
      directory: {
        ...directory,
        user: {
          id: 'user-2',
          username: 'other',
        },
      },
    }));
    const client = new AccountClient(fetchImpl);

    await expect(client.directory({
      relayBaseUrl: baseUrl,
      accessToken: 'account-access-token',
    }, new AbortController().signal)).rejects.toMatchObject({
      name: 'AccountClientError',
      stage: 'directory',
      code: 'response_invalid',
    });
  });

  it('rejects non-JSON success responses with a preserved JSON error cause', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl } = createContractFetch(() => (
      plainText('not-json account-access-token login-password')
    ));
    const client = new AccountClient(fetchImpl);

    const failure = await client.login({
      relayBaseUrl: baseUrl,
      username: 'jason',
      password: 'login-password',
    }, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountClientError);
    expect(failure).toMatchObject({
      stage: 'login',
      code: 'response_invalid_json',
    });
    expect((failure as AccountClientError).cause).toBeInstanceOf(SyntaxError);
    expect((failure as Error).message).not.toContain('account-access-token');
    expect((failure as Error).message).not.toContain('login-password');
  });

  it.each([401, 403])('returns an actionable HTTP %s authentication error without reading its body', async (status) => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const bodySecret = `body-secret password=login-password accessToken=account-access-token`;
    const { fetchImpl, requests } = createContractFetch(() => plainText(bodySecret, status));
    const client = new AccountClient(fetchImpl);

    const failure = await client.login({
      relayBaseUrl: baseUrl,
      username: 'jason',
      password: 'login-password',
    }, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountClientError);
    expect(failure).toMatchObject({
      stage: 'login',
      code: 'auth_invalid',
      status,
    });
    expect((failure as Error).message).toContain('登录失败');
    expect((failure as Error).message).toContain('检查账号和密码');
    expect((failure as AccountClientError).action).toContain('检查账号和密码');
    expect((failure as Error).message).not.toContain('body-secret');
    expect((failure as Error).message).not.toContain('login-password');
    expect((failure as Error).message).not.toContain('account-access-token');
    expect((failure as AccountClientError).cause).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('reports an aborted request as cancelled and preserves the abort cause', async () => {
    const baseUrl = 'http://relay.example.test/custom/relay/';
    const { fetchImpl, requests } = createContractFetch(async (request) => {
      await new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('request did not abort')), 1_000);
        request.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(request.signal?.reason);
        }, { once: true });
      });
      return json({});
    });
    const client = new AccountClient(fetchImpl);
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(new Error('deadline exceeded')), 25);

    const failure = await client.login({
      relayBaseUrl: baseUrl,
      username: 'jason',
      password: 'login-password',
    }, controller.signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountClientError);
    expect(failure).toMatchObject({
      stage: 'login',
      code: 'cancelled',
    });
    expect((failure as AccountClientError).cause).toBe(controller.signal.reason);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requests).toHaveLength(1);
  });

  it('reports network failures with stage and the underlying error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network unavailable');
    }) as typeof fetch;
    const client = new AccountClient(fetchImpl);
    const auth: AuthenticatedAccount = {
      relayBaseUrl: 'http://relay.example.test/custom/relay/',
      accessToken: 'account-access-token',
      user,
      directory,
    };

    const failure = await client.me(auth, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountClientError);
    expect(failure).toMatchObject({
      stage: 'me',
      code: 'network_failure',
    });
    expect((failure as AccountClientError).cause).toBeInstanceOf(TypeError);
  });
});

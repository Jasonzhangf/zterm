import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountState } from './account-state';
import { SharedConfigStore, getSharedConfigPath } from '../../shared/src/node/shared-config';

function createHarness(initial?: Record<string, unknown>) {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-account-'));
  const store = new SharedConfigStore({ homeDir });
  const signal = new AbortController().signal;
  if (initial) {
    return store.update((latest) => {
      for (const key of Object.keys(latest)) delete latest[key];
      Object.assign(latest, initial);
      return { value: undefined, changed: true };
    }, signal).then(() => ({ homeDir, store, signal, account: new AccountState({ store }) }));
  }
  return Promise.resolve({ homeDir, store, signal, account: new AccountState({ store }) });
}

const oldAuth = {
  loginId: 'login-old',
  userId: 'user-1',
  username: 'jason',
  accessToken: 'old-token',
  authenticatedAt: '2026-10-20T00:00:00.000Z',
};

const server = { relayBaseUrl: 'https://relay.example.test/zterm/' };

test('logout advances authGeneration even when auth is absent', async () => {
  const { homeDir, account, signal } = await createHarness({
    zterm: {
      cli: {
        server,
        authGeneration: 4,
        slots: { '1': { session: { name: 'keep' } } },
      },
      android: { daemon: { host: '127.0.0.1' } },
    },
  });
  try {
    const result = await account.logout(signal);
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(result, { kind: 'logged_out', generation: 5 });
    assert.equal(parsed.zterm.cli.authGeneration, 5);
    assert.equal('auth' in parsed.zterm.cli, false);
    assert.deepEqual(parsed.zterm.cli.server, server);
    assert.deepEqual(parsed.zterm.cli.slots, { '1': { session: { name: 'keep' } } });
    assert.deepEqual(parsed.zterm.android.daemon, { host: '127.0.0.1' });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('logout in an empty home creates only the required auth generation', async () => {
  const { homeDir, account, signal } = await createHarness();
  try {
    await account.logout(signal);
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));
    assert.deepEqual(parsed, { zterm: { cli: { authGeneration: 1 } } });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('an older login cannot revive auth after logout', async () => {
  const { homeDir, account, signal } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 7,
        auth: oldAuth,
        server,
      },
    },
  });
  try {
    const pending = await account.beginLogin({ consumeConfigPassword: false }, signal);
    await account.logout(signal);
    const commit = await account.commitLogin(pending.attempt, server, {
      loginId: 'late-login',
      userId: 'user-1',
      username: 'jason',
      accessToken: 'late-token',
      authenticatedAt: '2026-10-20T00:01:00.000Z',
    });
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(commit, { kind: 'login_superseded', generation: 9 });
    assert.equal('auth' in parsed.zterm.cli, false);
    assert.equal(parsed.zterm.cli.authGeneration, 9);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('two login attempts commit only in latest-start order', async () => {
  const { homeDir, account, signal } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 2,
        auth: oldAuth,
        server,
      },
    },
  });
  try {
    const first = await account.beginLogin({ consumeConfigPassword: false }, signal);
    const second = await account.beginLogin({ consumeConfigPassword: false }, signal);
    const firstCommit = await account.commitLogin(first.attempt, server, {
      loginId: 'login-first',
      userId: 'user-1',
      username: 'jason',
      accessToken: 'first-token',
      authenticatedAt: '2026-10-20T00:02:00.000Z',
    });
    const secondCommit = await account.commitLogin(second.attempt, server, {
      loginId: 'login-second',
      userId: 'user-1',
      username: 'jason',
      accessToken: 'second-token',
      authenticatedAt: '2026-10-20T00:03:00.000Z',
    });
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.equal(firstCommit.kind, 'login_superseded');
    assert.equal(secondCommit.kind, 'committed');
    assert.equal(parsed.zterm.cli.auth.loginId, 'login-second');
    assert.equal(parsed.zterm.cli.authGeneration, 4);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('pending login preserves the old auth and login identity', async () => {
  const { homeDir, account, signal } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 10,
        auth: oldAuth,
        server,
      },
    },
  });
  try {
    await account.beginLogin({ consumeConfigPassword: false }, signal);
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(parsed.zterm.cli.auth, oldAuth);
    assert.equal(parsed.zterm.cli.authGeneration, 11);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('login rejects a changed server baseline without deleting the latest auth', async () => {
  const { homeDir, store, account, signal } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 1,
        auth: oldAuth,
        server,
      },
    },
  });
  try {
    const pending = await account.beginLogin({ consumeConfigPassword: false }, signal);
    await store.update((latest) => {
      const zterm = latest.zterm as Record<string, unknown>;
      const cli = zterm.cli as Record<string, unknown>;
      cli.server = { relayBaseUrl: 'https://other.example.test/zterm/' };
      return { value: undefined, changed: true };
    }, signal);
    const commit = await account.commitLogin(pending.attempt, server, {
      loginId: 'login-new',
      userId: 'user-1',
      username: 'jason',
      accessToken: 'new-token',
      authenticatedAt: '2026-10-20T00:04:00.000Z',
    });
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.equal(commit.kind, 'login_server_changed');
    assert.deepEqual(parsed.zterm.cli.auth, oldAuth);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('from-config login consumes only the one-shot password in the begin transaction', async () => {
  const { homeDir, account, signal } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 0,
        server,
        loginInput: {
          username: 'jason',
          password: 'one-shot-secret',
        },
        unknownCliField: { keep: true },
      },
    },
  });
  try {
    const pending = await account.beginLogin({ consumeConfigPassword: true }, signal);
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(pending.input, {
      username: 'jason',
      password: 'one-shot-secret',
    });
    assert.equal('password' in parsed.zterm.cli.loginInput, false);
    assert.equal(parsed.zterm.cli.loginInput.username, 'jason');
    assert.deepEqual(parsed.zterm.cli.unknownCliField, { keep: true });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

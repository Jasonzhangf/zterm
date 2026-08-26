import { describe, expect, it } from 'vitest';
import type { BridgeSettings } from '../connection/bridge-settings';
import type { RelayAccountDirectory } from '../connection/relay-directory';
import type { AppUpdateProjectionInput } from '../interaction/projection';
import {
  INITIAL_PERSISTENCE_PROJECTION,
  applyPersistenceMutation,
  createPersistenceProjection,
  parsePersistenceProjection,
  projectPersistenceEvent,
  replayPersistenceEvents,
  serializePersistenceProjection,
  type PersistenceMutation,
} from './persistence-settings-projection';

const settings: BridgeSettings = {
  targetHost: '192.168.1.20',
  targetPort: 3333,
  targetAuthToken: 'token-1',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: 200,
  terminalThemeId: 'classic-dark',
  terminalShellSkin: 'auto',
  terminalWidthMode: 'mirror-fixed',
  terminalSessionGroupLayoutMode: 'auto',
  shortcutSmartSort: true,
  servers: [],
  traversalRelay: undefined,
};

const account: RelayAccountDirectory = {
  schemaVersion: 1,
  user: {
    id: 'user-1',
    username: 'jason',
  },
  devices: [
    {
      deviceId: 'device-1',
      deviceName: 'Mac',
      platform: 'mac',
      appVersion: '1.0.0',
      client: { connected: true, lastSeenAt: '2026-08-26T00:00:00.000Z' },
      daemon: null,
    },
  ],
  updatedAt: '2026-08-26T00:00:00.000Z',
};

const update: AppUpdateProjectionInput = {
  preferences: {
    manifestUrl: 'https://example.com/latest.json',
    manifestSource: 'user-saved',
    autoCheckOnLaunch: true,
    ignoreUntilManualCheck: false,
    lastCheckedAt: 1,
    lastSeenVersionCode: 10,
  },
  latestManifest: {
    versionCode: 20,
    versionName: '1.0.2',
    buildNumber: 20,
    apkUrl: 'https://example.com/app.apk',
    sha256: 'abc',
    size: 1024,
    notes: ['fix'],
    publishedAt: '2026-08-26T00:00:00.000Z',
    channel: 'stable',
  },
  availableManifest: null,
  checking: false,
  installing: false,
  lastError: null,
  updateStage: 'idle',
  runtimeVersionCode: 10,
};

function accountMutation(): PersistenceMutation {
  return { type: 'replace-account', account };
}

describe('persistence settings projection', () => {
  it('starts from a deterministic serializable default', () => {
    expect(INITIAL_PERSISTENCE_PROJECTION.revision).toBe(0);
    expect(INITIAL_PERSISTENCE_PROJECTION.settings.targetHost).toBe('');
    expect(INITIAL_PERSISTENCE_PROJECTION.account).toBeNull();
    expect(INITIAL_PERSISTENCE_PROJECTION.update.hasNewVersion).toBe(false);
    expect(JSON.parse(serializePersistenceProjection(INITIAL_PERSISTENCE_PROJECTION))).toMatchObject({
      revision: 0,
      settings: { targetHost: '' },
      account: null,
    });
  });

  it('applies settings, account, and update mutations in order and projects revision', () => {
    const settingsEvent = applyPersistenceMutation(
      INITIAL_PERSISTENCE_PROJECTION,
      { type: 'replace-settings', settings },
      1,
    );
    const accountState = projectPersistenceEvent(INITIAL_PERSISTENCE_PROJECTION, settingsEvent);
    const accountEvent = applyPersistenceMutation(accountState, accountMutation(), 2);
    const updateState = projectPersistenceEvent(accountState, accountEvent);
    const updateEvent = applyPersistenceMutation(
      updateState,
      { type: 'replace-update', update },
      3,
    );

    const projection = replayPersistenceEvents([settingsEvent, accountEvent, updateEvent]);

    expect(projection.revision).toBe(3);
    expect(projection.settings.targetHost).toBe('192.168.1.20');
    expect(projection.account?.user.username).toBe('jason');
    expect(projection.account?.devices[0]?.deviceId).toBe('device-1');
    expect(projection.update.hasNewVersion).toBe(true);
    expect(projection.update.updateStage).toBe('idle');
  });

  it('keeps unrelated persisted domains when one slice is replaced', () => {
    const base = createPersistenceProjection(settings, account, update);
    const event = applyPersistenceMutation(base, {
      type: 'replace-update',
      update: {
        ...update,
        runtimeVersionCode: 21,
      },
    }, 4);

    const projected = projectPersistenceEvent(base, event);

    expect(projected.revision).toBe(base.revision + 1);
    expect(projected.settings.targetHost).toBe('192.168.1.20');
    expect(projected.account?.user.id).toBe('user-1');
    expect(projected.update.runtimeVersionCode).toBe(21);
    expect(projected.update.hasNewVersion).toBe(false);
  });

  it('serializes and parses the aggregate without changing semantics', () => {
    const projection = createPersistenceProjection(settings, account, update);
    const parsed = parsePersistenceProjection(serializePersistenceProjection(projection));

    expect(parsed).toEqual(projection);
    expect(parsed.account?.devices[0]?.client).toMatchObject({ connected: true });
    expect(parsed.update.latestManifest?.versionName).toBe('1.0.2');
  });

  it('preserves a non-zero revision when parsing persisted truth', () => {
    const projection = {
      ...createPersistenceProjection(settings, account, update),
      revision: 4,
    };

    expect(parsePersistenceProjection(serializePersistenceProjection(projection))).toEqual(projection);
  });

  it('rejects non-monotonic replay revision', () => {
    const event = applyPersistenceMutation(INITIAL_PERSISTENCE_PROJECTION, { type: 'replace-settings', settings }, 1);
    const eventWithWrongRevision = { ...event, revision: 2 };

    expect(() => projectPersistenceEvent(INITIAL_PERSISTENCE_PROJECTION, eventWithWrongRevision)).toThrow(
      'persistence revision must advance by exactly one',
    );
    expect(() => replayPersistenceEvents([event, event])).toThrow(
      'persistence revision must advance by exactly one',
    );
  });

  it('rejects malformed serialized projection and account/update payloads', () => {
    expect(() => parsePersistenceProjection('{')).toThrow(SyntaxError);
    expect(() => parsePersistenceProjection(serializePersistenceProjection(INITIAL_PERSISTENCE_PROJECTION).replace('"revision":0', '"revision":-1'))).toThrow(
      'persistence revision must be a non-negative integer',
    );
    expect(() => createPersistenceProjection(settings, {
      ...account,
      schemaVersion: 2 as never,
    })).toThrow('account directory schema version must be 1');
    expect(() => createPersistenceProjection(settings, account, {
      ...update,
      runtimeVersionCode: -1,
    })).toThrow('update runtimeVersionCode is invalid');
  });

  it('normalizes settings and account input instead of accepting invalid persisted truth', () => {
    const projection = createPersistenceProjection(
      { ...settings, targetHost: '' } as BridgeSettings,
      null,
      update,
    );

    expect(projection.settings.targetHost).toBe('');
    expect(projection.settings.terminalWidthMode).toBe('mirror-fixed');
    expect(projection.revision).toBe(0);
  });
});

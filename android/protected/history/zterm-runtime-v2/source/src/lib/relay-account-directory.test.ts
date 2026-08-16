import { describe, expect, it } from 'vitest';
import {
  normalizeRelayAccountDirectory,
  projectRelayDirectoryDeviceSnapshots,
  projectRelayDirectoryMachines,
} from './relay-account-directory';

const directoryPayload = {
  schemaVersion: 1,
  user: {
    id: 'u1',
    username: 'jason',
  },
  updatedAt: '2026-06-28T10:00:00.000Z',
  devices: [
    {
      deviceId: 'daemon-device',
      deviceName: 'Jason Mac',
      platform: 'darwin',
      appVersion: '0.1.3',
      client: {
        connected: false,
        lastSeenAt: '',
      },
      daemon: {
        hostId: 'daemon-host',
        version: '0.1.3-daemon',
        presence: {
          connected: true,
          lastSeenAt: '2026-06-28T10:01:00.000Z',
        },
        endpoints: [
          {
            id: 'relay-rtc:daemon-host',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:01:00.000Z',
          },
        ],
        sessions: [
          {
            name: 'main',
            cwd: '/Users/jason/project',
            title: 'main shell',
            updatedAt: '2026-06-28T10:01:00.000Z',
          },
        ],
        lastPublishedAt: '2026-06-28T10:01:00.000Z',
      },
    },
    {
      deviceId: 'client-device',
      deviceName: 'Jason Tablet',
      platform: 'android',
      appVersion: '0.1.3',
      client: {
        connected: true,
        lastSeenAt: '2026-06-28T10:02:00.000Z',
      },
      daemon: null,
    },
  ],
};

describe('relay account directory runtime', () => {
  it('normalizes account directory without dropping endpoint or session semantics', () => {
    const directory = normalizeRelayAccountDirectory(directoryPayload);
    const daemonDevice = directory?.devices.find((device) => device.deviceId === 'daemon-device');

    expect(directory).toMatchObject({
      schemaVersion: 1,
      user: { id: 'u1', username: 'jason' },
    });
    expect(daemonDevice).toMatchObject({
      deviceId: 'daemon-device',
      daemon: {
        hostId: 'daemon-host',
        endpoints: [
          {
            id: 'relay-rtc:daemon-host',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host',
            authRequired: true,
          },
        ],
        sessions: [
          {
            name: 'main',
            cwd: '/Users/jason/project',
            title: 'main shell',
          },
        ],
      },
    });
  });

  it('rejects invalid directory snapshots instead of converting them to empty success truth', () => {
    expect(normalizeRelayAccountDirectory({ schemaVersion: 1, user: { id: '', username: 'jason' }, devices: [] })).toBeNull();
    expect(normalizeRelayAccountDirectory({ schemaVersion: 2, user: { id: 'u1', username: 'jason' }, devices: [] })).toBeNull();
    expect(normalizeRelayAccountDirectory({ devices: [] })).toBeNull();
  });

  it('projects daemon machines from directory without requiring local bridge presets', () => {
    const directory = normalizeRelayAccountDirectory(directoryPayload);
    const machines = projectRelayDirectoryMachines(directory);

    expect(machines).toEqual([
      {
        deviceId: 'daemon-device',
        deviceName: 'Jason Mac',
        platform: 'darwin',
        appVersion: '0.1.3',
        daemonHostId: 'daemon-host',
        daemonVersion: '0.1.3-daemon',
        connected: true,
        lastSeenAt: '2026-06-28T10:01:00.000Z',
        endpoints: [
          {
            id: 'relay-rtc:daemon-host',
            kind: 'relay-rtc',
            relayHostId: 'daemon-host',
            authRequired: true,
            lastSeenAt: '2026-06-28T10:01:00.000Z',
          },
        ],
        sessions: [
          {
            name: 'main',
            cwd: '/Users/jason/project',
            title: 'main shell',
            updatedAt: '2026-06-28T10:01:00.000Z',
          },
        ],
      },
    ]);
  });

  it('projects directory devices into legacy device snapshots without dropping route/session facts', () => {
    const directory = normalizeRelayAccountDirectory(directoryPayload);
    const snapshots = projectRelayDirectoryDeviceSnapshots(directory);

    expect(snapshots).toEqual([
      {
        deviceId: 'daemon-device',
        deviceName: 'Jason Mac',
        platform: 'darwin',
        appVersion: '0.1.3',
        updatedAt: '2026-06-28T10:00:00.000Z',
        client: {
          connected: false,
          lastSeenAt: '2026-06-28T10:00:00.000Z',
        },
        daemon: {
          connected: true,
          lastSeenAt: '2026-06-28T10:01:00.000Z',
          hostId: 'daemon-host',
          version: '0.1.3-daemon',
          endpoints: [
            {
              id: 'relay-rtc:daemon-host',
              kind: 'relay-rtc',
              relayHostId: 'daemon-host',
              authRequired: true,
              lastSeenAt: '2026-06-28T10:01:00.000Z',
            },
          ],
          sessions: [
            {
              name: 'main',
              cwd: '/Users/jason/project',
              title: 'main shell',
              updatedAt: '2026-06-28T10:01:00.000Z',
            },
          ],
        },
      },
      {
        deviceId: 'client-device',
        deviceName: 'Jason Tablet',
        platform: 'android',
        appVersion: '0.1.3',
        updatedAt: '2026-06-28T10:00:00.000Z',
        client: {
          connected: true,
          lastSeenAt: '2026-06-28T10:02:00.000Z',
        },
        daemon: {
          connected: false,
          lastSeenAt: '',
          hostId: '',
          version: '',
        },
      },
    ]);
  });

  it('deduplicates same daemon host rows and retains the row carrying session truth', () => {
    const directory = normalizeRelayAccountDirectory({
      ...directoryPayload,
      devices: [
        {
          ...directoryPayload.devices[0],
          deviceId: 'old-registration',
          deviceName: 'Old Mac Name',
          daemon: {
            ...directoryPayload.devices[0].daemon,
            endpoints: [],
            sessions: [],
          },
        },
        {
          ...directoryPayload.devices[0],
          deviceId: 'current-registration',
          deviceName: 'Current Mac Name',
        },
      ],
    });

    const snapshots = projectRelayDirectoryDeviceSnapshots(directory);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      deviceId: 'current-registration',
      deviceName: 'Current Mac Name',
      daemon: {
        hostId: 'daemon-host',
        sessions: [{ name: 'main' }],
      },
    });
  });

  it('keeps different daemon hosts as separate machine rows', () => {
    const directory = normalizeRelayAccountDirectory({
      ...directoryPayload,
      devices: [
        directoryPayload.devices[0],
        {
          ...directoryPayload.devices[0],
          deviceId: 'second-daemon',
          daemon: {
            ...directoryPayload.devices[0].daemon,
            hostId: 'second-host',
          },
        },
      ],
    });

    expect(projectRelayDirectoryDeviceSnapshots(directory)).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildAppUpdateManifestCandidates,
  buildRelayInjectedAppUpdatePreferences,
  deriveRelayUpdateManifestUrl,
} from './app-update-relay-manifest';
import type { AppUpdatePreferences } from './app-update';
import type { BridgeSettings } from './bridge-settings';

const disabledPreferences: AppUpdatePreferences = {
  manifestUrl: '',
  manifestSource: 'none',
  autoCheckOnLaunch: false,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
};

const baseSettings: BridgeSettings = {
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: 1000,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  terminalSessionGroupLayoutMode: 'auto',
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

describe('app-update relay manifest helpers', () => {
  it('derives the update manifest URL from relay ws host truth', () => {
    expect(deriveRelayUpdateManifestUrl('wss://relay.codewhisper.cc:18443/relay/ws/host?token=abc')).toBe(
      'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
    );
    expect(deriveRelayUpdateManifestUrl('ws://159.75.134.56/relay/ws/host')).toBe(
      'http://159.75.134.56/relay/updates/latest.json',
    );
  });

  it('does not turn auto check back on when injecting a relay-derived manifest URL', () => {
    expect(buildRelayInjectedAppUpdatePreferences(
      disabledPreferences,
      'wss://relay.codewhisper.cc:18443/relay/ws/host',
    )).toMatchObject({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
      autoCheckOnLaunch: false,
    });
  });

  it('updates a previous relay-derived manifest when the relay host changes', () => {
    const current: AppUpdatePreferences = {
      ...disabledPreferences,
      manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
      manifestSource: 'server-connected',
    };

    expect(buildRelayInjectedAppUpdatePreferences(
      current,
      'wss://relay.codewhisper.cc:18443/relay/ws/host',
    )).toMatchObject({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
    });
  });

  it('keeps an explicitly saved manifest URL authoritative', () => {
    const current = {
      ...disabledPreferences,
      manifestUrl: 'https://updates.example.com/latest.json',
      manifestSource: 'user-saved' as const,
    };

    expect(buildRelayInjectedAppUpdatePreferences(
      current,
      'wss://relay.codewhisper.cc:18443/relay/ws/host',
    )).toBe(current);
  });

  it('projects Relay, Tailscale, and LAN candidates for one daemon', () => {
    expect(buildAppUpdateManifestCandidates({
      ...baseSettings,
      targetHost: '192.168.0.3',
      traversalRelay: {
        relayBaseUrl: 'https://relay.codewhisper.cc:18443',
        accessToken: 'token',
        userId: '',
        username: '',
        deviceId: '',
        deviceName: '',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
        wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
        wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
      servers: [
        {
          id: 'tailscale',
          name: 'Tailscale',
          targetHost: '100.66.1.82',
          targetPort: 3333,
          authToken: 'token',
        },
        {
          id: 'lan',
          name: 'LAN',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'token',
        },
      ],
    })).toEqual([
      {
        id: 'relay-public',
        label: 'Relay 公网',
        manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
        manifestSource: 'relay-injected',
      },
      {
        id: 'daemon-tailscale',
        label: 'Tailscale',
        manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
        manifestSource: 'server-connected',
      },
      {
        id: 'daemon-lan',
        label: 'LAN',
        manifestUrl: 'http://192.168.0.3:3333/updates/latest.json',
        manifestSource: 'server-connected',
      },
    ]);
  });

  it('projects direct target truth without Relay and deduplicates a matching saved server', () => {
    expect(buildAppUpdateManifestCandidates({
      ...baseSettings,
      targetHost: '100.66.1.82',
      servers: [
        {
          id: 'tailscale',
          name: 'Tailscale',
          targetHost: '100.66.1.82',
          targetPort: 3333,
          authToken: 'token',
        },
      ],
    })).toEqual([
      {
        id: 'daemon-tailscale',
        label: 'Tailscale',
        manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
        manifestSource: 'server-connected',
      },
    ]);
  });
});

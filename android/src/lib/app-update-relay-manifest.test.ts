import { describe, expect, it } from 'vitest';
import {
  buildRelayInjectedAppUpdatePreferences,
  deriveRelayUpdateManifestUrl,
} from './app-update-relay-manifest';
import type { AppUpdatePreferences } from './app-update';

const disabledPreferences: AppUpdatePreferences = {
  manifestUrl: '',
  manifestSource: 'none',
  autoCheckOnLaunch: false,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
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
});

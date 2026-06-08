import { describe, expect, it } from 'vitest';
import {
  buildRelayInjectedAppUpdatePreferences,
  deriveRelayUpdateManifestUrl,
} from './app-update-relay-manifest';
import type { AppUpdatePreferences } from './app-update';

const disabledPreferences: AppUpdatePreferences = {
  manifestUrl: '',
  autoCheckOnLaunch: false,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
};

describe('app-update relay manifest helpers', () => {
  it('derives the update manifest URL from relay ws host truth', () => {
    expect(deriveRelayUpdateManifestUrl('wss://claw.codewhisper.cc:18443/relay/ws/host?token=abc')).toBe(
      'https://claw.codewhisper.cc:18443/updates/latest.json',
    );
    expect(deriveRelayUpdateManifestUrl('ws://159.75.134.56/relay/ws/host')).toBe(
      'http://159.75.134.56/updates/latest.json',
    );
  });

  it('does not turn auto check back on when injecting a relay-derived manifest URL', () => {
    expect(buildRelayInjectedAppUpdatePreferences(
      disabledPreferences,
      'wss://claw.codewhisper.cc:18443/relay/ws/host',
    )).toMatchObject({
      manifestUrl: 'https://claw.codewhisper.cc:18443/updates/latest.json',
      autoCheckOnLaunch: false,
    });
  });

  it('keeps an explicitly saved manifest URL authoritative', () => {
    const current = {
      ...disabledPreferences,
      manifestUrl: 'https://updates.example.com/latest.json',
    };

    expect(buildRelayInjectedAppUpdatePreferences(
      current,
      'wss://claw.codewhisper.cc:18443/relay/ws/host',
    )).toBe(current);
  });
});

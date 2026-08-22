import { describe, expect, it } from 'vitest';
import { normalizeAppUpdatePreferences } from './app-update';

describe('app-update preference truth', () => {
  it('marks legacy private daemon update URLs as server-connected so relay can replace them', () => {
    expect(normalizeAppUpdatePreferences({
      manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
      autoCheckOnLaunch: false,
    })).toMatchObject({
      manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
      manifestSource: 'server-connected',
    });
  });

  it('keeps legacy public custom update URLs as user-saved', () => {
    expect(normalizeAppUpdatePreferences({
      manifestUrl: 'https://updates.example.com/latest.json',
      autoCheckOnLaunch: false,
    })).toMatchObject({
      manifestUrl: 'https://updates.example.com/latest.json',
      manifestSource: 'user-saved',
    });
  });
});
